"""
Flask API for GLB to Voxel conversion
"""
from flask import Flask, request, jsonify
from flask_cors import CORS
import numpy as np
import trimesh
import json
import math
import time
from pathlib import Path
import tempfile

app = Flask(__name__)
CORS(app)

# ============ VOXELIZATION ALGORITHM ============

def _validate_normal_direction(mesh, point, normal, center):
    """Validate that normal points outward"""
    normal = np.array(normal, dtype=np.float32)
    point = np.array(point, dtype=np.float32)
    center = np.array(center, dtype=np.float32)

    outward_dir = point - center
    outward_dir_norm = np.linalg.norm(outward_dir)

    if outward_dir_norm < 1e-8:
        return normal

    if np.dot(normal, outward_dir) < 0:
        return -normal

    return normal

def _average_normals_from_hits(hits_dict, step):
    """Average normals from multi-directional hits"""
    averaged_hits = {}

    for key, hit_list in hits_dict.items():
        if not hit_list:
            continue

        positions = np.array([h[0] for h in hit_list])
        normals = np.array([h[1] for h in hit_list])

        avg_pos = np.mean(positions, axis=0)

        normals_normalized = normals / (np.linalg.norm(normals, axis=1, keepdims=True) + 1e-8)
        avg_normal = np.mean(normals_normalized, axis=0)
        avg_normal = avg_normal / (np.linalg.norm(avg_normal) + 1e-8)

        averaged_hits[key] = (avg_pos, avg_normal)

    return averaged_hits

def surface_hollow_raycast(mesh, target_blocks=5000, block_size_mul=1.0, gap_ratio=0.12,
                          colorize=True, surface_z_height=1.0, ray_offset=None):
    """Main voxelization algorithm"""
    start_time = time.time()

    bounds = mesh.bounds
    min_point, max_point = bounds[0], bounds[1]
    mesh_center = (min_point + max_point) / 2.0

    try:
        mesh.remove_degenerate_faces()
        mesh.remove_unreferenced_vertices()
    except:
        pass

    sx = max_point[0] - min_point[0]
    sy = max_point[1] - min_point[1]
    sz = max_point[2] - min_point[2]
    diag = np.sqrt(sx*sx + sy*sy + sz*sz) + 1e-9

    if diag < 1e-6:
        return [], "Error: Mesh too small"

    area_proxy = max(1e-9, (sx*sy + sx*sz + sy*sz) * 2.0)
    step = math.sqrt(area_proxy / max(1, target_blocks))
    step = max(step, diag / 900.0)

    block_size = max(0.0005, step * (1.0 - gap_ratio) * block_size_mul)

    nx = max(4, int(round(sx / step)) + 1)
    ny = max(4, int(round(sy / step)) + 1)
    nz = max(4, int(round(sz / step)) + 1)

    if ray_offset is None:
        ray_pad = max(diag * 0.5, 1.0) + 2.0 * step
    else:
        ray_pad = float(ray_offset) + 2.0 * step

    hits_by_grid = {}
    rays_list = []
    ray_directions_list = []

    # 6-direction raycast
    for iy in range(ny):
        y = min_point[1] + (sy * (iy / (ny - 1) if ny > 1 else 0.5))
        for ix in range(nx):
            x = min_point[0] + (sx * (ix / (nx - 1) if nx > 1 else 0.5))
            z0_neg = max_point[2] + ray_pad
            rays_list.append(np.array([x, y, z0_neg]))
            ray_directions_list.append(np.array([0, 0, -1]))

            z0_pos = min_point[2] - ray_pad
            rays_list.append(np.array([x, y, z0_pos]))
            ray_directions_list.append(np.array([0, 0, 1]))

    for iz in range(nz):
        z = min_point[2] + (sz * (iz / (nz - 1) if nz > 1 else 0.5))
        for iy in range(ny):
            y = min_point[1] + (sy * (iy / (ny - 1) if ny > 1 else 0.5))
            x0_neg = max_point[0] + ray_pad
            rays_list.append(np.array([x0_neg, y, z]))
            ray_directions_list.append(np.array([-1, 0, 0]))

            x0_pos = min_point[0] - ray_pad
            rays_list.append(np.array([x0_pos, y, z]))
            ray_directions_list.append(np.array([1, 0, 0]))

    for iz in range(nz):
        z = min_point[2] + (sz * (iz / (nz - 1) if nz > 1 else 0.5))
        for ix in range(nx):
            x = min_point[0] + (sx * (ix / (nx - 1) if nx > 1 else 0.5))
            y0_neg = max_point[1] + ray_pad
            rays_list.append(np.array([x, y0_neg, z]))
            ray_directions_list.append(np.array([0, -1, 0]))

            y0_pos = min_point[1] - ray_pad
            rays_list.append(np.array([x, y0_pos, z]))
            ray_directions_list.append(np.array([0, 1, 0]))

    if rays_list:
        ray_origins = np.array(rays_list)
        ray_directions = np.array(ray_directions_list)
        ray_directions = ray_directions / (np.linalg.norm(ray_directions, axis=1, keepdims=True) + 1e-8)

        try:
            locations, index_ray, index_tri = mesh.ray.intersects_location(
                ray_origins=ray_origins,
                ray_directions=ray_directions,
                multiple_hits=True
            )

            q = step * 0.5
            for loc, tri_idx in zip(locations, index_tri):
                key = (round(loc[0] / q), round(loc[1] / q), round(loc[2] / q))
                normal = mesh.face_normals[tri_idx]
                normal = _validate_normal_direction(mesh, loc, normal, mesh_center)

                if key not in hits_by_grid:
                    hits_by_grid[key] = []
                hits_by_grid[key].append((loc.copy(), normal.copy()))
        except:
            pass

    averaged_hits = _average_normals_from_hits(hits_by_grid, step)
    hit_list_raw = list(averaged_hits.values())

    if len(hit_list_raw) > target_blocks:
        stride = len(hit_list_raw) / target_blocks
        sampled = []
        idx = 0.0
        while len(sampled) < target_blocks and int(idx) < len(hit_list_raw):
            sampled.append(hit_list_raw[int(idx)])
            idx += stride
        hit_list_raw = sampled

    voxels = []
    for loc, normal in hit_list_raw:
        voxels.append({
            'position': loc.tolist(),
            'normal': normal.tolist(),
            'color': [0.8, 0.8, 0.8],
            'size': float(block_size * (1.0 - gap_ratio)),
            'z_height': surface_z_height
        })

    elapsed = time.time() - start_time
    return voxels, f"Created {len(voxels)} blocks in {elapsed:.2f}s"

# ============ FLASK ROUTES ============

@app.route('/api/health', methods=['GET'])
def health():
    """Health check"""
    return jsonify({'status': 'ok', 'message': 'Voxelizer API running'})

@app.route('/api/voxelize', methods=['POST'])
def voxelize():
    """Convert GLB to voxels"""
    try:
        # Check file
        if 'file' not in request.files:
            return jsonify({'error': 'No file provided'}), 400

        file = request.files['file']
        if file.filename == '':
            return jsonify({'error': 'Empty filename'}), 400

        # Get parameters
        target_blocks = request.form.get('target_blocks', 2000, type=int)
        block_size_mul = request.form.get('block_size_mul', 1.0, type=float)
        gap_ratio = request.form.get('gap_ratio', 0.12, type=float)

        # Load mesh
        with tempfile.NamedTemporaryFile(suffix=Path(file.filename).suffix, delete=False) as tmp:
            file.save(tmp.name)
            mesh = trimesh.load(tmp.name)

            if isinstance(mesh, trimesh.Scene):
                mesh = trimesh.util.concatenate(mesh.geometry.values())

        # Voxelize
        voxels, status = surface_hollow_raycast(
            mesh=mesh,
            target_blocks=target_blocks,
            block_size_mul=block_size_mul,
            gap_ratio=gap_ratio,
            colorize=True,
            surface_z_height=1.0
        )

        return jsonify({
            'success': True,
            'status': status,
            'voxel_count': len(voxels),
            'voxels': voxels
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/voxelize-preview', methods=['POST'])
def voxelize_preview():
    """Quick preview with fewer blocks"""
    try:
        if 'file' not in request.files:
            return jsonify({'error': 'No file provided'}), 400

        file = request.files['file']

        with tempfile.NamedTemporaryFile(suffix=Path(file.filename).suffix, delete=False) as tmp:
            file.save(tmp.name)
            mesh = trimesh.load(tmp.name)

            if isinstance(mesh, trimesh.Scene):
                mesh = trimesh.util.concatenate(mesh.geometry.values())

        # Quick preview with fewer blocks
        voxels, status = surface_hollow_raycast(
            mesh=mesh,
            target_blocks=500,  # Preview with fewer blocks
            block_size_mul=1.0,
            gap_ratio=0.12,
            colorize=True,
            surface_z_height=1.0
        )

        return jsonify({
            'success': True,
            'status': status,
            'voxel_count': len(voxels),
            'voxels': voxels
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(debug=True, port=5000)
