import { clampVoxelGrid } from './triangle-grid';
import {
  inscribedCubeHalfEdge,
  orientationForSurface,
  quaternionToEuler,
  triangleCurvature,
} from './voxel-orientation';

interface GeometryData {
  positions: Float32Array;
  indices: Uint32Array;
  colors: Float32Array;
  normals: Float32Array;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

interface VoxelizeParams {
  targetBlocks: number;
  blockSizeMul: number;
  gapRatio: number;
  surface: boolean;
  interior: boolean;
  curvedVoxels: boolean;
}

interface Voxel {
  position: number[];
  normal: number[];
  color: number[];
  size: number;
  z_height: number;
  rotation: [number, number, number];
  quaternion: [number, number, number, number];
  curvature: number;
  type?: 'surface' | 'interior';
}

// ─── GEOMETRY HELPERS ─────────────────────────────────────────────────────────

/**
 * Closest point on triangle ABC to P; barycentric weights on B,C so
 * closest = (1 - barB - barC) * A + barB * B + barC * C.
 * Region logic matches three.js `Triangle.closestPointToPoint` (Ericson).
 */
function triangleClosestBarycentric(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): { distSq: number; barB: number; barC: number } {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;

  const pack = (qx: number, qy: number, qz: number, barB: number, barC: number) => {
    const dx = px - qx;
    const dy = py - qy;
    const dz = pz - qz;
    return { distSq: dx * dx + dy * dy + dz * dz, barB, barC };
  };

  if (d1 <= 0 && d2 <= 0) {
    return pack(ax, ay, az, 0, 0);
  }

  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) {
    return pack(bx, by, bz, 1, 0);
  }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3 + 1e-20);
    return pack(ax + v * abx, ay + v * aby, az + v * abz, v, 0);
  }

  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) {
    return pack(cx, cy, cz, 0, 1);
  }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6 + 1e-20);
    return pack(ax + w * acx, ay + w * acy, az + w * acz, 0, w);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const bcx = cx - bx;
    const bcy = cy - by;
    const bcz = cz - bz;
    const den = (d4 - d3) + (d5 - d6);
    const wbc = den > 1e-20 ? (d4 - d3) / den : 0.5;
    return pack(bx + wbc * bcx, by + wbc * bcy, bz + wbc * bcz, 1 - wbc, wbc);
  }

  const denom = va + vb + vc;
  if (Math.abs(denom) < 1e-20) {
    return pack((ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3, 1 / 3, 1 / 3);
  }
  const inv = 1 / denom;
  const v = vb * inv;
  const w = vc * inv;
  return pack(ax + v * abx + w * acx, ay + v * aby + w * acy, az + v * abz + w * acz, v, w);
}

function clamp01(c: number): number {
  return Math.min(1, Math.max(0, c));
}

/** Match `preview-colors` when mesh has no per-voxel paint (interior / fallback). */
function positionGradientColor(
  px: number,
  py: number,
  pz: number,
  bbox: { min: [number, number, number]; max: [number, number, number] },
): [number, number, number] {
  const [minX, minY, minZ] = bbox.min;
  const sizeX = bbox.max[0] - minX || 1;
  const sizeY = bbox.max[1] - minY || 1;
  const sizeZ = bbox.max[2] - minZ || 1;
  const nx = (px - minX) / sizeX;
  const ny = (py - minY) / sizeY;
  const nz = (pz - minZ) / sizeZ;
  return [
    clamp01(Math.max(0.3, Math.min(1, nx * 1.2))),
    clamp01(Math.max(0.3, Math.min(1, ny * 1.2))),
    clamp01(Math.max(0.3, Math.min(1, nz * 1.2))),
  ];
}

// ─── FLOOD-FILL INTERIOR DETECTION (Topology-based, works with non-watertight meshes) ──

/**
 * Build inside/outside classification using flood-fill from boundary.
 * Works reliably for non-watertight meshes by using connectivity analysis.
 * BFS from grid edges to mark all "outside" empty cells.
 * Remaining empty cells = "inside".
 */
function buildFloodFillInside(
  gridX: number,
  gridY: number,
  gridZ: number,
  grid: Uint8Array  // 0=empty, 1=surface (don't modify, use for reference)
): Uint8Array {
  const cellCount = gridX * gridY * gridZ;
  const visited = new Uint8Array(cellCount);
  const insideGrid = new Uint8Array(cellCount); // 0=outside, 1=inside
  const queue: number[] = [];

  // Helper: linear index to (gx, gy, gz)
  const unpack = (idx: number) => {
    const gz = Math.floor(idx / (gridY * gridX));
    const rem = idx % (gridY * gridX);
    const gy = Math.floor(rem / gridX);
    const gx = rem % gridX;
    return { gx, gy, gz };
  };

  // Helper: (gx, gy, gz) to linear index
  const pack = (gx: number, gy: number, gz: number) =>
    gz * gridY * gridX + gy * gridX + gx;

  // Add all boundary cells (edges of grid) to queue
  // These are definitely "outside"
  for (let gz = 0; gz < gridZ; gz++) {
    for (let gy = 0; gy < gridY; gy++) {
      for (let gx = 0; gx < gridX; gx++) {
        // Check if on boundary
        const onBoundary = (gx === 0 || gx === gridX - 1 ||
                           gy === 0 || gy === gridY - 1 ||
                           gz === 0 || gz === gridZ - 1);
        if (onBoundary) {
          const idx = pack(gx, gy, gz);
          if (grid[idx] === 0) { // Only add empty boundary cells
            visited[idx] = 1;
            queue.push(idx);
          }
        }
      }
    }
  }

  // BFS: flood-fill from boundary through empty cells
  let head = 0;
  const dx = [1, -1, 0, 0, 0, 0];
  const dy = [0, 0, 1, -1, 0, 0];
  const dz = [0, 0, 0, 0, 1, -1];

  while (head < queue.length) {
    const idx = queue[head++];
    const { gx, gy, gz } = unpack(idx);

    // Check 6 neighbors
    for (let d = 0; d < 6; d++) {
      const ngx = gx + dx[d];
      const ngy = gy + dy[d];
      const ngz = gz + dz[d];

      // Bounds check
      if (ngx < 0 || ngx >= gridX || ngy < 0 || ngy >= gridY || ngz < 0 || ngz >= gridZ) {
        continue;
      }

      const nidx = pack(ngx, ngy, ngz);
      if (visited[nidx]) continue;
      if (grid[nidx] !== 0) continue; // Only traverse empty cells

      visited[nidx] = 1;
      queue.push(nidx);
    }
  }

  // Mark unreachable empty cells as "inside"
  for (let idx = 0; idx < cellCount; idx++) {
    if (grid[idx] === 0 && !visited[idx]) {
      insideGrid[idx] = 1;
    }
  }

  return insideGrid;
}

// ─── TRIANGLE–AABB SAT TEST ───────────────────────────────────────────────────

/**
 * Separating Axis Theorem test for triangle vs axis-aligned box.
 * Box is centered at (cx,cy,cz) with half-extents (hx,hy,hz).
 * Returns true when the shapes overlap (no separating axis found).
 */
function triangleAABBIntersect(
  v0x: number, v0y: number, v0z: number,
  v1x: number, v1y: number, v1z: number,
  v2x: number, v2y: number, v2z: number,
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number,
): boolean {
  // Translate so box center is at origin
  const a0x = v0x - cx, a0y = v0y - cy, a0z = v0z - cz;
  const a1x = v1x - cx, a1y = v1y - cy, a1z = v1z - cz;
  const a2x = v2x - cx, a2y = v2y - cy, a2z = v2z - cz;
  const f0x = a1x - a0x, f0y = a1y - a0y, f0z = a1z - a0z;
  const f1x = a2x - a1x, f1y = a2y - a1y, f1z = a2z - a1z;
  const f2x = a0x - a2x, f2y = a0y - a2y, f2z = a0z - a2z;

  // Project tri onto axis (eax,eay,eaz) and check overlap with AABB projection
  const sat = (eax: number, eay: number, eaz: number): boolean => {
    const p0 = eax * a0x + eay * a0y + eaz * a0z;
    const p1 = eax * a1x + eay * a1y + eaz * a1z;
    const p2 = eax * a2x + eay * a2y + eaz * a2z;
    const r = hx * Math.abs(eax) + hy * Math.abs(eay) + hz * Math.abs(eaz);
    return Math.min(p0, p1, p2) <= r && Math.max(p0, p1, p2) >= -r;
  };

  // 9 axes: coordinate_axis × triangle_edge
  if (!sat(0, -f0z, f0y)) return false;
  if (!sat(f0z, 0, -f0x)) return false;
  if (!sat(-f0y, f0x, 0)) return false;
  if (!sat(0, -f1z, f1y)) return false;
  if (!sat(f1z, 0, -f1x)) return false;
  if (!sat(-f1y, f1x, 0)) return false;
  if (!sat(0, -f2z, f2y)) return false;
  if (!sat(f2z, 0, -f2x)) return false;
  if (!sat(-f2y, f2x, 0)) return false;

  // 3 AABB face normals (coordinate axes)
  if (Math.max(a0x, a1x, a2x) < -hx || Math.min(a0x, a1x, a2x) > hx) return false;
  if (Math.max(a0y, a1y, a2y) < -hy || Math.min(a0y, a1y, a2y) > hy) return false;
  if (Math.max(a0z, a1z, a2z) < -hz || Math.min(a0z, a1z, a2z) > hz) return false;

  // Triangle face normal
  const fnx = f0y * f1z - f0z * f1y;
  const fny = f0z * f1x - f0x * f1z;
  const fnz = f0x * f1y - f0y * f1x;
  const d = fnx * a0x + fny * a0y + fnz * a0z;
  const r = hx * Math.abs(fnx) + hy * Math.abs(fny) + hz * Math.abs(fnz);
  if (d > r || d < -r) return false;

  return true;
}

// ─── MAIN VOXELIZE ─────────────────────────────────────────────────────────────

function voxelize(
  positions: Float32Array,
  indices: Uint32Array,
  colors: Float32Array,
  normals: Float32Array,
  bbox: { min: [number, number, number]; max: [number, number, number] },
  params: VoxelizeParams,
  onProgress?: (progress: number) => void
): Voxel[] {
  const { targetBlocks, blockSizeMul, gapRatio, surface, interior, curvedVoxels } = params;

  const sizeX = bbox.max[0] - bbox.min[0];
  const sizeY = bbox.max[1] - bbox.min[1];
  const sizeZ = bbox.max[2] - bbox.min[2];
  const maxDim = Math.max(sizeX, sizeY, sizeZ);
  if (maxDim === 0) return [];

  let voxelSize = (maxDim / Math.cbrt(targetBlocks)) * blockSizeMul;
  let { voxelSize: vs, gridX, gridY, gridZ } = clampVoxelGrid(sizeX, sizeY, sizeZ, voxelSize);
  voxelSize = vs;

  // Center grid at bbox center for symmetric voxelization
  const bboxCenter = [
    (bbox.min[0] + bbox.max[0]) * 0.5,
    (bbox.min[1] + bbox.max[1]) * 0.5,
    (bbox.min[2] + bbox.max[2]) * 0.5,
  ];
  const gridOffset: [number, number, number] = [
    bboxCenter[0] - (gridX * voxelSize) * 0.5,
    bboxCenter[1] - (gridY * voxelSize) * 0.5,
    bboxCenter[2] - (gridZ * voxelSize) * 0.5,
  ];

  const triCount = Math.floor(indices.length / 3);
  if (triCount === 0) return [];

  // Build flat triangle arrays (9 floats per tri: v0 v1 v2)
  const triPos = new Float32Array(triCount * 9);
  const triCol = new Float32Array(triCount * 9); // 3 colors × 3 components

  for (let i = 0; i < triCount; i++) {
    const i0 = indices[i*3], i1 = indices[i*3+1], i2 = indices[i*3+2];
    const b = i * 9;
    // Positions
    triPos[b  ] = positions[i0*3];   triPos[b+1] = positions[i0*3+1]; triPos[b+2] = positions[i0*3+2];
    triPos[b+3] = positions[i1*3];   triPos[b+4] = positions[i1*3+1]; triPos[b+5] = positions[i1*3+2];
    triPos[b+6] = positions[i2*3];   triPos[b+7] = positions[i2*3+1]; triPos[b+8] = positions[i2*3+2];
    // Colors (fallback white if no colors)
    if (colors.length > 0) {
      triCol[b  ] = colors[i0*3] ?? 1; triCol[b+1] = colors[i0*3+1] ?? 1; triCol[b+2] = colors[i0*3+2] ?? 1;
      triCol[b+3] = colors[i1*3] ?? 1; triCol[b+4] = colors[i1*3+1] ?? 1; triCol[b+5] = colors[i1*3+2] ?? 1;
      triCol[b+6] = colors[i2*3] ?? 1; triCol[b+7] = colors[i2*3+1] ?? 1; triCol[b+8] = colors[i2*3+2] ?? 1;
    } else {
      triCol.fill(1, b, b+9);
    }
  }

  // 0=empty, 1=surface, 2=interior
  const grid = new Uint8Array(gridX * gridY * gridZ);
  const voxelColors = new Map<number, [number, number, number]>();
  const cellCount = gridX * gridY * gridZ;
  const normalSum = new Float32Array(cellCount * 3);
  const normalWsum = new Float32Array(cellCount);
  const cellCurvature = new Float32Array(cellCount);
  const cellBestDistSq = new Float32Array(cellCount);
  cellBestDistSq.fill(1e30);
  // Dominant-normal tracking for crease detection (largest-area triangle per voxel)
  const dominantNx = new Float32Array(cellCount);
  const dominantNy = new Float32Array(cellCount);
  const dominantNz = new Float32Array(cellCount);
  const dominantArea = new Float32Array(cellCount);

  // Note: triGrid is no longer used (raycasting replaced with flood-fill)
  // const triGrid = buildTriangleGrid(triPos, triCount, bbox.min, bbox.max, voxelSize);

  const reportProgress = (p: number) => {
    onProgress?.(Math.max(0, Math.min(100, p)));
  };

  // ── STEP 1: Surface voxelization (Triangle-AABB / SAT) ──────────────────
  const halfCell = voxelSize * 0.5;

  if (surface) {
    for (let ti = 0; ti < triCount; ti++) {
      const b = ti * 9;
      const ax=triPos[b], ay=triPos[b+1], az=triPos[b+2];
      const bx=triPos[b+3], by=triPos[b+4], bz=triPos[b+5];
      const cx=triPos[b+6], cy=triPos[b+7], cz=triPos[b+8];

      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      let fnx = e1y * e2z - e1z * e2y;
      let fny = e1z * e2x - e1x * e2z;
      let fnz = e1x * e2y - e1y * e2x;
      const fnl = Math.hypot(fnx, fny, fnz) || 1;
      fnx /= fnl;
      fny /= fnl;
      fnz /= fnl;

      const i0 = indices[ti * 3];
      const i1 = indices[ti * 3 + 1];
      const i2 = indices[ti * 3 + 2];
      let triCurv = 0;
      const hasVtxNormals = normals.length >= (Math.max(i0, i1, i2) + 1) * 3;
      if (hasVtxNormals) {
        triCurv = triangleCurvature(
          normals[i0 * 3], normals[i0 * 3 + 1], normals[i0 * 3 + 2],
          normals[i1 * 3], normals[i1 * 3 + 1], normals[i1 * 3 + 2],
          normals[i2 * 3], normals[i2 * 3 + 1], normals[i2 * 3 + 2]
        );
      }
      // Triangle area = fnl * 0.5; used as weight so large triangles dominate
      const triArea = fnl;

      const gx0 = Math.max(0, Math.floor((Math.min(ax,bx,cx)-gridOffset[0])/voxelSize)-1);
      const gx1 = Math.min(gridX-1, Math.ceil((Math.max(ax,bx,cx)-gridOffset[0])/voxelSize)+1);
      const gy0 = Math.max(0, Math.floor((Math.min(ay,by,cy)-gridOffset[1])/voxelSize)-1);
      const gy1 = Math.min(gridY-1, Math.ceil((Math.max(ay,by,cy)-gridOffset[1])/voxelSize)+1);
      const gz0 = Math.max(0, Math.floor((Math.min(az,bz,cz)-gridOffset[2])/voxelSize)-1);
      const gz1 = Math.min(gridZ-1, Math.ceil((Math.max(az,bz,cz)-gridOffset[2])/voxelSize)+1);

      for (let gz=gz0; gz<=gz1; gz++) {
        for (let gy=gy0; gy<=gy1; gy++) {
          for (let gx=gx0; gx<=gx1; gx++) {
            const pcx = bboxCenter[0] + (gx - gridX*0.5 + 0.5)*voxelSize;
            const pcy = bboxCenter[1] + (gy - gridY*0.5 + 0.5)*voxelSize;
            const pcz = bboxCenter[2] + (gz - gridZ*0.5 + 0.5)*voxelSize;

            // Triangle-AABB: SAT intersection test, then closest-point for normals/colors
            if (!triangleAABBIntersect(ax,ay,az,bx,by,bz,cx,cy,cz, pcx,pcy,pcz, halfCell,halfCell,halfCell)) continue;
            const hit = triangleClosestBarycentric(pcx, pcy, pcz, ax, ay, az, bx, by, bz, cx, cy, cz);

            const idx = gz*gridY*gridX + gy*gridX + gx;
            grid[idx] = 1;
            const o = idx * 3;

            // Interpolate vertex normals at barycentric hit coords (smoother than face normals)
            const wa = 1 - hit.barB - hit.barC;
            let snx: number, sny: number, snz: number;
            if (hasVtxNormals) {
              snx = wa*normals[i0*3]   + hit.barB*normals[i1*3]   + hit.barC*normals[i2*3];
              sny = wa*normals[i0*3+1] + hit.barB*normals[i1*3+1] + hit.barC*normals[i2*3+1];
              snz = wa*normals[i0*3+2] + hit.barB*normals[i1*3+2] + hit.barC*normals[i2*3+2];
              const snl = Math.hypot(snx, sny, snz) || 1;
              snx /= snl; sny /= snl; snz /= snl;
            } else {
              snx = fnx; sny = fny; snz = fnz;
            }

            // Area-weighted accumulation: large triangles contribute proportionally more
            normalSum[o]   += snx * triArea;
            normalSum[o+1] += sny * triArea;
            normalSum[o+2] += snz * triArea;
            normalWsum[idx] += triArea;

            // Track dominant triangle (largest area) for crease detection
            if (triArea > dominantArea[idx]) {
              dominantArea[idx] = triArea;
              dominantNx[idx] = snx;
              dominantNy[idx] = sny;
              dominantNz[idx] = snz;
            }

            if (triCurv > cellCurvature[idx]) cellCurvature[idx] = triCurv;
            if (hit.distSq < cellBestDistSq[idx]) {
              cellBestDistSq[idx] = hit.distSq;
              const wa = 1 - hit.barB - hit.barC;
              const r = wa * triCol[b] + hit.barB * triCol[b + 3] + hit.barC * triCol[b + 6];
              const g = wa * triCol[b + 1] + hit.barB * triCol[b + 4] + hit.barC * triCol[b + 7];
              const bl = wa * triCol[b + 2] + hit.barB * triCol[b + 5] + hit.barC * triCol[b + 8];
              voxelColors.set(idx, [r, g, bl]);
            }
          }
        }
      }
      if (ti % 64 === 0) reportProgress((ti / triCount) * 25);
    }

  }

  // ── Build flood-fill inside/outside grid (topology-based, works with non-watertight) ───
  const insideGrid = buildFloodFillInside(gridX, gridY, gridZ, grid);
  reportProgress(50);

  // ── DISABLED: Inner-shell removal ───────────────────────────────────────────────────
  // [REASON] Inner-shell removal was deleting legitimate surface voxels on non-watertight
  // meshes because raycasting-based insideGrid was unreliable. With topology-based
  // flood-fill, this step is no longer needed and would cause data loss.
  // Surface voxels (grid[idx] === 1) must be preserved in all cases.
  // if (surface) {
  //   for (let idx = 0; idx < cellCount; idx++) {
  //     if (grid[idx] === 1 && insideGrid[idx] === 1) {
  //       grid[idx] = 0;
  //     }
  //   }
  // }
  reportProgress(60);

  // ── STEP 2: Interior fill via scan-line result ───────────────────────────────
  if (interior) {
    for (let idx = 0; idx < cellCount; idx++) {
      if (grid[idx] === 0 && insideGrid[idx] === 1) {
        grid[idx] = 2; // Mark as interior (don't overwrite surface voxels)
      }
    }
  }
  reportProgress(70);

  // ── Surface layer filtering: keep only outermost surface layer ────────────────
  // Remove surface voxels not adjacent to empty cells (interior surface layers)
  if (surface) {
    const dx = [1, -1, 0, 0, 0, 0];
    const dy = [0, 0, 1, -1, 0, 0];
    const dz = [0, 0, 0, 0, 1, -1];
    const toRemove: number[] = [];

    for (let gz = 0; gz < gridZ; gz++) {
      for (let gy = 0; gy < gridY; gy++) {
        for (let gx = 0; gx < gridX; gx++) {
          const idx = gz * gridY * gridX + gy * gridX + gx;
          if (grid[idx] !== 1) continue; // Only check surface voxels

          // Check if adjacent to empty cell
          let adjacentToEmpty = false;
          for (let d = 0; d < 6; d++) {
            const ngx = gx + dx[d];
            const ngy = gy + dy[d];
            const ngz = gz + dz[d];

            // Empty cells outside grid or truly empty
            if (ngx < 0 || ngx >= gridX || ngy < 0 || ngy >= gridY || ngz < 0 || ngz >= gridZ) {
              adjacentToEmpty = true;
              break;
            }

            const nidx = ngz * gridY * gridX + ngy * gridX + ngx;
            if (grid[nidx] === 0) {
              adjacentToEmpty = true;
              break;
            }
          }

          // Mark for removal if not adjacent to empty
          if (!adjacentToEmpty) {
            toRemove.push(idx);
          }
        }
      }
    }

    // Remove internal surface layers
    for (const idx of toRemove) {
      grid[idx] = 0;
    }
  }
  reportProgress(72);

  // ── Gap-fill: close small holes with morphological closing ──────────────────
  if (interior) {
    const FILL_VOTE_THRESHOLD = 5; // out of 6 face-neighbors
    const MAX_FILL_ITERS = 2;

    for (let iter = 0; iter < MAX_FILL_ITERS; iter++) {
      const toFill: number[] = [];

      // Forward pass: gx from 1 to gridX-2
      for (let gz = 1; gz < gridZ - 1; gz++) {
        for (let gy = 1; gy < gridY - 1; gy++) {
          for (let gx = 1; gx < gridX - 1; gx++) {
            const idx = gz * gridY * gridX + gy * gridX + gx;
            if (grid[idx] !== 0) continue;

            let filledNeighbours = 0;
            if (grid[idx - 1] !== 0) filledNeighbours++;
            if (grid[idx + 1] !== 0) filledNeighbours++;
            if (grid[idx - gridX] !== 0) filledNeighbours++;
            if (grid[idx + gridX] !== 0) filledNeighbours++;
            if (grid[idx - gridY * gridX] !== 0) filledNeighbours++;
            if (grid[idx + gridY * gridX] !== 0) filledNeighbours++;

            if (filledNeighbours >= FILL_VOTE_THRESHOLD) {
              toFill.push(idx);
            }
          }
        }
      }

      // Backward pass: gx from gridX-2 to 1 (reverse direction)
      for (let gz = gridZ - 2; gz >= 1; gz--) {
        for (let gy = gridY - 2; gy >= 1; gy--) {
          for (let gx = gridX - 2; gx >= 1; gx--) {
            const idx = gz * gridY * gridX + gy * gridX + gx;
            if (grid[idx] !== 0) continue;

            let filledNeighbours = 0;
            if (grid[idx - 1] !== 0) filledNeighbours++;
            if (grid[idx + 1] !== 0) filledNeighbours++;
            if (grid[idx - gridX] !== 0) filledNeighbours++;
            if (grid[idx + gridX] !== 0) filledNeighbours++;
            if (grid[idx - gridY * gridX] !== 0) filledNeighbours++;
            if (grid[idx + gridY * gridX] !== 0) filledNeighbours++;

            if (filledNeighbours >= FILL_VOTE_THRESHOLD) {
              toFill.push(idx);
            }
          }
        }
      }

      if (toFill.length === 0) break;
      for (const idx of toFill) {
        grid[idx] = 2; // Mark as interior
      }
    }
  }
  reportProgress(75);

  // ── Remove isolated surface voxels (floating debris) ─────────────────────────
  if (surface) {
    const toRemove: number[] = [];

    for (let gz = 1; gz < gridZ - 1; gz++) {
      for (let gy = 1; gy < gridY - 1; gy++) {
        for (let gx = 1; gx < gridX - 1; gx++) {
          const idx = gz * gridY * gridX + gy * gridX + gx;
          if (grid[idx] !== 1) continue;

          let hasNeighbour = false;
          if (grid[idx - 1] !== 0) hasNeighbour = true;
          if (grid[idx + 1] !== 0) hasNeighbour = true;
          if (grid[idx - gridX] !== 0) hasNeighbour = true;
          if (grid[idx + gridX] !== 0) hasNeighbour = true;
          if (grid[idx - gridY * gridX] !== 0) hasNeighbour = true;
          if (grid[idx + gridY * gridX] !== 0) hasNeighbour = true;

          if (!hasNeighbour) {
            toRemove.push(idx);
          }
        }
      }
    }

    for (const idx of toRemove) {
      grid[idx] = 0;
    }
  }
  reportProgress(80);

  // ── STEP 1: Extract and canonicalize surface normals ──────────────────────────
  const hasOrient = new Uint8Array(cellCount);
  const orientNx = new Float32Array(cellCount);
  const orientNy = new Float32Array(cellCount);
  const orientNz = new Float32Array(cellCount);
  const smNx = new Float32Array(cellCount);
  const smNy = new Float32Array(cellCount);
  const smNz = new Float32Array(cellCount);
  const canonicalNorm = new Float32Array(cellCount * 3); // Store canonical normal sum for flat regions

  if (surface && curvedVoxels) {
    // First pass: normalize raw normals + crease detection
    for (let idx = 0; idx < cellCount; idx++) {
      if (grid[idx] !== 1 || normalWsum[idx] <= 0) continue;
      const o = idx * 3;
      const ws = normalWsum[idx];
      let nx = normalSum[o] / ws;
      let ny = normalSum[o + 1] / ws;
      let nz = normalSum[o + 2] / ws;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;

      // Crease detection: if the area-weighted average diverges from the largest-area
      // triangle's normal by >60°, the voxel straddles a hard edge — use dominant normal
      // so each side of the crease gets clean, unblended alignment
      const dot = nx * dominantNx[idx] + ny * dominantNy[idx] + nz * dominantNz[idx];
      if (dot < 0.5) {
        nx = dominantNx[idx]; ny = dominantNy[idx]; nz = dominantNz[idx];
      }

      orientNx[idx] = nx;
      orientNy[idx] = ny;
      orientNz[idx] = nz;
      hasOrient[idx] = 1;
      // Store crease-corrected unit normal for flat-region BFS
      canonicalNorm[idx * 3]     = nx;
      canonicalNorm[idx * 3 + 1] = ny;
      canonicalNorm[idx * 3 + 2] = nz;
    }

    // Second pass: Detect and canonicalize flat surface regions
    const nxv = gridX;
    const nyv = gridY;
    const nzv = gridZ;
    const FLAT_DETECTION_THRESHOLD = 0.998; // cos(~3.6°)
    const visited = new Uint8Array(cellCount);
    const dx = [1, -1, 0, 0, 0, 0];
    const dy = [0, 0, 1, -1, 0, 0];
    const dz = [0, 0, 0, 0, 1, -1];

    const canonicalizeGroup = (startIdx: number) => {
      const queue: number[] = [startIdx];
      visited[startIdx] = 1;
      let sumNx = canonicalNorm[startIdx * 3];
      let sumNy = canonicalNorm[startIdx * 3 + 1];
      let sumNz = canonicalNorm[startIdx * 3 + 2];
      let count = 1;

      let head = 0;
      while (head < queue.length) {
        const idx = queue[head++];
        const gz = Math.floor(idx / (nyv * nxv));
        const rem = idx % (nyv * nxv);
        const gy = Math.floor(rem / nxv);
        const gx = rem % nxv;

        for (let d = 0; d < 6; d++) {
          const ngx = gx + dx[d];
          const ngy = gy + dy[d];
          const ngz = gz + dz[d];

          if (ngx < 0 || ngx >= nxv || ngy < 0 || ngy >= nyv || ngz < 0 || ngz >= nzv) continue;
          const ni = ngz * nyv * nxv + ngy * nxv + ngx;
          if (visited[ni] || !hasOrient[ni]) continue;

          // Check if neighbor normal is similar to current region
          const dot = orientNx[idx] * orientNx[ni] + orientNy[idx] * orientNy[ni] + orientNz[idx] * orientNz[ni];
          if (dot >= FLAT_DETECTION_THRESHOLD) {
            visited[ni] = 1;
            queue.push(ni);
            sumNx += canonicalNorm[ni * 3];
            sumNy += canonicalNorm[ni * 3 + 1];
            sumNz += canonicalNorm[ni * 3 + 2];
            count++;
          }
        }
      }

      // Apply canonical normal to entire group (including single voxels)
      const cnl = Math.hypot(sumNx, sumNy, sumNz) || 1;
      const cnx = sumNx / cnl;
      const cny = sumNy / cnl;
      const cnz = sumNz / cnl;

      for (let i = 0; i < queue.length; i++) {
        const idx = queue[i];
        orientNx[idx] = cnx;
        orientNy[idx] = cny;
        orientNz[idx] = cnz;
      }
    };

    // Canonicalize all flat groups
    let groupsProcessed = 0;
    for (let idx = 0; idx < cellCount; idx++) {
      if (!hasOrient[idx] || visited[idx]) continue;
      canonicalizeGroup(idx);
      groupsProcessed++;
    }

    // Copy canonicalized orientNx/orientNy/orientNz to smNx/smNy/smNz for use in rotation calculation
    for (let idx = 0; idx < cellCount; idx++) {
      if (!hasOrient[idx]) continue;
      smNx[idx] = orientNx[idx];
      smNy[idx] = orientNy[idx];
      smNz[idx] = orientNz[idx];
    }
  }

  // ── STEP 3: Build output (one voxel per grid cell — no overlap) ───────────
  reportProgress(85);
  const voxels: Voxel[] = [];
  const cellHalf = (voxelSize * (1 - gapRatio)) * 0.5;

  for (let gz=0; gz<gridZ; gz++) {
    for (let gy=0; gy<gridY; gy++) {
      for (let gx=0; gx<gridX; gx++) {
        const idx = gz*gridY*gridX + gy*gridX + gx;
        const state = grid[idx];
        if (state === 0) continue;

        // Calculate from center outward to avoid floating point accumulation bias
        const posX = bboxCenter[0] + (gx - gridX*0.5 + 0.5)*voxelSize;
        const posY = bboxCenter[1] + (gy - gridY*0.5 + 0.5)*voxelSize;
        const posZ = bboxCenter[2] + (gz - gridZ*0.5 + 0.5)*voxelSize;

        let color: [number, number, number];
        if (voxelColors.has(idx)) {
          const col = voxelColors.get(idx)!;
          color = [clamp01(col[0]), clamp01(col[1]), clamp01(col[2])];
        } else {
          color = positionGradientColor(posX, posY, posZ, bbox);
        }

        let quaternion: [number, number, number, number] = [0, 0, 0, 1];
        let rotation: [number, number, number] = [0, 0, 0];
        let surfNormal: [number, number, number] = [0, 1, 0];
        let curvature = 0;

        if (state === 1 && curvedVoxels && hasOrient[idx]) {
          let nx = smNx[idx];
          let ny = smNy[idx];
          let nz = smNz[idx];
          const nl = Math.hypot(nx, ny, nz) || 1;
          nx /= nl;
          ny /= nl;
          nz /= nl;
          curvature = cellCurvature[idx];
          quaternion = orientationForSurface(nx, ny, nz, curvature);
          rotation = quaternionToEuler(quaternion);
          surfNormal = [nx, ny, nz];
        } else if (state === 1 && curvedVoxels && normalWsum[idx] > 0) {
          const wsum = normalWsum[idx];
          const o = idx * 3;
          let nx = normalSum[o] / wsum;
          let ny = normalSum[o + 1] / wsum;
          let nz = normalSum[o + 2] / wsum;
          const nl = Math.hypot(nx, ny, nz) || 1;
          nx /= nl;
          ny /= nl;
          nz /= nl;
          curvature = cellCurvature[idx];
          quaternion = orientationForSurface(nx, ny, nz, curvature);
          rotation = quaternionToEuler(quaternion);
          surfNormal = [nx, ny, nz];
        }

        // Inscribed cube fills the cell AABB exactly when rotated;
        // ×1.06 gives slight visual tightness without neighbour overlap.
        const half = inscribedCubeHalfEdge(cellHalf, quaternion) * 1.06;
        const size = Math.max(half * 2, cellHalf * 0.62);

        voxels.push({
          position: [posX, posY, posZ],
          normal: surfNormal,
          color,
          size,
          z_height: posZ,
          rotation,
          quaternion,
          curvature,
          type: state === 1 ? 'surface' : 'interior',
        });
      }
    }
  }
  reportProgress(99);
  return voxels;
}

// ─── WORKER ENTRY ─────────────────────────────────────────────────────────────

self.onmessage = (event: MessageEvent<{ geometry: GeometryData; params: VoxelizeParams }>) => {
  try {
    const { geometry, params } = event.data ?? ({} as any);
    if (!geometry?.positions?.length || !geometry?.indices?.length || !geometry?.bbox) {
      self.postMessage({ type: 'complete', voxels: [] });
      return;
    }

    const positions = geometry.positions instanceof Float32Array
      ? geometry.positions
      : new Float32Array(geometry.positions as ArrayLike<number>);
    const indices = geometry.indices instanceof Uint32Array
      ? geometry.indices
      : new Uint32Array(Array.from(geometry.indices as ArrayLike<number>));
    const colors = geometry.colors instanceof Float32Array
      ? geometry.colors
      : new Float32Array(
        geometry.colors != null && typeof (geometry.colors as ArrayLike<number>).length === 'number'
          ? (geometry.colors as ArrayLike<number>)
          : [],
      );
    const normals = geometry.normals instanceof Float32Array
      ? geometry.normals
      : new Float32Array(
        geometry.normals != null && typeof (geometry.normals as ArrayLike<number>).length === 'number'
          ? (geometry.normals as ArrayLike<number>)
          : [],
      );

    const voxels = voxelize(positions, indices, colors, normals, geometry.bbox, params, (progress) => {
      self.postMessage({ type: 'progress', value: progress });
    });
    self.postMessage({ type: 'complete', voxels: Array.isArray(voxels) ? voxels : [] });
  } catch {
    self.postMessage({ type: 'complete', voxels: [] });
  }
};
