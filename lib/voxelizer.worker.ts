import { buildTriangleGrid, clampVoxelGrid, queryTriangleGrid, type TriangleGrid } from './triangle-grid';
import {
  inscribedCubeHalfEdge,
  orientationForSurface,
  quaternionToEuler,
  triangleCurvature,
} from './voxel-orientation';

const EPSILON = 1e-8;

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

// Möller–Trumbore - returns hit coordinate along ray axis, or -Infinity on miss
function rayHitX(oy: number, oz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number
): number {
  const e1x=bx-ax, e1y=by-ay, e1z=bz-az;
  const e2x=cx-ax, e2y=cy-ay, e2z=cz-az;
  const det = e1z*e2y - e1y*e2z;
  if (Math.abs(det) < EPSILON) return -Infinity;
  const f = 1/det;
  const sy = oy-ay, sz = oz-az;
  const u = f*(sz*e2y - sy*e2z);
  if (u < -EPSILON || u > 1+EPSILON) return -Infinity;
  const v = f*(sy*e1z - sz*e1y);
  if (v < -EPSILON || u+v > 1+EPSILON) return -Infinity;
  // Hit X via barycentric interpolation — independent of ray origin x
  return ax + u*(bx-ax) + v*(cx-ax);
}

function rayHitY(ox: number, oz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number
): number {
  const e1x=bx-ax, e1y=by-ay, e1z=bz-az;
  const e2x=cx-ax, e2y=cy-ay, e2z=cz-az;
  const det = e1x*e2z - e1z*e2x;
  if (Math.abs(det) < EPSILON) return -Infinity;
  const f = 1/det;
  const sz = oz-az, sx = ox-ax;
  const u = f*(sx*e2z - sz*e2x);
  if (u < -EPSILON || u > 1+EPSILON) return -Infinity;
  const v = f*(sz*e1x - sx*e1z);
  if (v < -EPSILON || u+v > 1+EPSILON) return -Infinity;
  return ay + u*(by-ay) + v*(cy-ay);
}

function rayHitZ(ox: number, oy: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number
): number {
  const e1x=bx-ax, e1y=by-ay, e1z=bz-az;
  const e2x=cx-ax, e2y=cy-ay, e2z=cz-az;
  const det = e1y*e2x - e1x*e2y;
  if (Math.abs(det) < EPSILON) return -Infinity;
  const f = 1/det;
  const sx = ox-ax, sy = oy-ay;
  const u = f*(sy*e2x - sx*e2y);
  if (u < -EPSILON || u > 1+EPSILON) return -Infinity;
  const v = f*(sx*e1y - sy*e1x);
  if (v < -EPSILON || u+v > 1+EPSILON) return -Infinity;
  return az + u*(bz-az) + v*(cz-az);
}

// ─── SCAN-LINE INTERIOR FILL ──────────────────────────────────────────────────

/**
 * Build a complete inside/outside classification grid using scan-line filling.
 * For each axis direction, iterate all triangles and collect ray intersections.
 * Uses parity rule: odd number of intersections = inside.
 * Returns majority vote across 3 axes (≥2 = inside).
 */
function buildScanLineInside(
  triPos: Float32Array,
  triCount: number,
  triGrid: TriangleGrid,
  bbox: { min: [number, number, number]; max: [number, number, number] },
  gridX: number,
  gridY: number,
  gridZ: number,
  voxelSize: number,
  PERTURB: number,
  gridOffset: [number, number, number],
): Uint8Array {
  const cellCount = gridX * gridY * gridZ;
  const insideX = new Uint8Array(cellCount);
  const insideY = new Uint8Array(cellCount);
  const insideZ = new Uint8Array(cellCount);

  // Helper: cell key into triGrid buckets
  const cellKey = (ix: number, iy: number, iz: number) =>
    iz * triGrid.dims[1] * triGrid.dims[0] + iy * triGrid.dims[0] + ix;

  // ── Z-axis scan (columns indexed by gx, gy) ──
  for (let gy = 0; gy < gridY; gy++) {
    for (let gx = 0; gx < gridX; gx++) {
      const px = gridOffset[0] + (gx + 0.5) * voxelSize + PERTURB;
      const py = gridOffset[1] + (gy + 0.5) * voxelSize + PERTURB;

      // Collect all Z-intersections in this column
      const hits: number[] = [];
      const seenTri = new Set<number>();

      for (let gz = 0; gz < gridZ; gz++) {
        const key = cellKey(gx, gy, gz);
        const triList = triGrid.buckets.get(key);
        if (!triList) continue;

        for (const ti of triList) {
          if (seenTri.has(ti)) continue;
          seenTri.add(ti);

          const b = ti * 9;
          const hz = rayHitZ(
            px, py,
            triPos[b], triPos[b + 1], triPos[b + 2],
            triPos[b + 3], triPos[b + 4], triPos[b + 5],
            triPos[b + 6], triPos[b + 7], triPos[b + 8]
          );

          if (hz > -Infinity) {
            hits.push(hz);
          }
        }
      }

      // Sort and apply parity rule
      hits.sort((a, b) => a - b);

      for (let gz = 0; gz < gridZ; gz++) {
        const pz = gridOffset[2] + (gz + 0.5) * voxelSize + PERTURB;
        let count = 0;
        for (const h of hits) {
          if (h <= pz) count++;
          else break;
        }
        if (count % 2 === 1) {
          insideZ[gz * gridY * gridX + gy * gridX + gx] = 1;
        }
      }
    }
  }

  // ── X-axis scan (columns indexed by gy, gz) ──
  for (let gz = 0; gz < gridZ; gz++) {
    for (let gy = 0; gy < gridY; gy++) {
      const py = gridOffset[1] + (gy + 0.5) * voxelSize + PERTURB;
      const pz = gridOffset[2] + (gz + 0.5) * voxelSize + PERTURB;

      const hits: number[] = [];
      const seenTri = new Set<number>();

      for (let gx = 0; gx < gridX; gx++) {
        const key = cellKey(gx, gy, gz);
        const triList = triGrid.buckets.get(key);
        if (!triList) continue;

        for (const ti of triList) {
          if (seenTri.has(ti)) continue;
          seenTri.add(ti);

          const b = ti * 9;
          const hx = rayHitX(
            py, pz,
            triPos[b], triPos[b + 1], triPos[b + 2],
            triPos[b + 3], triPos[b + 4], triPos[b + 5],
            triPos[b + 6], triPos[b + 7], triPos[b + 8]
          );

          if (hx > -Infinity) {
            hits.push(hx);
          }
        }
      }

      hits.sort((a, b) => a - b);

      for (let gx = 0; gx < gridX; gx++) {
        const px = gridOffset[0] + (gx + 0.5) * voxelSize + PERTURB;
        let count = 0;
        for (const h of hits) {
          if (h <= px) count++;
          else break;
        }
        if (count % 2 === 1) {
          insideX[gz * gridY * gridX + gy * gridX + gx] = 1;
        }
      }
    }
  }

  // ── Y-axis scan (columns indexed by gx, gz) ──
  for (let gz = 0; gz < gridZ; gz++) {
    for (let gx = 0; gx < gridX; gx++) {
      const px = gridOffset[0] + (gx + 0.5) * voxelSize + PERTURB;
      const pz = gridOffset[2] + (gz + 0.5) * voxelSize + PERTURB;

      const hits: number[] = [];
      const seenTri = new Set<number>();

      for (let gy = 0; gy < gridY; gy++) {
        const key = cellKey(gx, gy, gz);
        const triList = triGrid.buckets.get(key);
        if (!triList) continue;

        for (const ti of triList) {
          if (seenTri.has(ti)) continue;
          seenTri.add(ti);

          const b = ti * 9;
          const hy = rayHitY(
            px, pz,
            triPos[b], triPos[b + 1], triPos[b + 2],
            triPos[b + 3], triPos[b + 4], triPos[b + 5],
            triPos[b + 6], triPos[b + 7], triPos[b + 8]
          );

          if (hy > -Infinity) {
            hits.push(hy);
          }
        }
      }

      hits.sort((a, b) => a - b);

      for (let gy = 0; gy < gridY; gy++) {
        const py = bbox.min[1] + (gy + 0.5) * voxelSize + PERTURB;
        let count = 0;
        for (const h of hits) {
          if (h <= py) count++;
          else break;
        }
        if (count % 2 === 1) {
          insideY[gz * gridY * gridX + gy * gridX + gx] = 1;
        }
      }
    }
  }

  // ── Majority vote across 3 axes ──
  const insideFinal = new Uint8Array(cellCount);
  for (let idx = 0; idx < cellCount; idx++) {
    const votes = insideX[idx] + insideY[idx] + insideZ[idx];
    if (votes >= 2) {
      insideFinal[idx] = 1;
    }
  }

  return insideFinal;
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
  const gridOffset = [
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

  const triGrid = buildTriangleGrid(triPos, triCount, bbox.min, bbox.max, voxelSize);

  const reportProgress = (p: number) => {
    onProgress?.(Math.max(0, Math.min(100, p)));
  };

  // ── STEP 1: Surface voxelization ─────────────────────────────────────────
  // With interior fill off: thinner shell + outward side only (no inner sheet / volume)
  // Increased band to catch more surface details on curved meshes (still one cell thick shell)
  const surfaceBand = interior ? 1.0 : 0.65;
  const THRESH_SQ = (voxelSize * surfaceBand) * (voxelSize * surfaceBand);
  const outwardMargin = voxelSize * 0.12;

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
      if (normals.length >= (Math.max(i0, i1, i2) + 1) * 3) {
        triCurv = triangleCurvature(
          normals[i0 * 3], normals[i0 * 3 + 1], normals[i0 * 3 + 2],
          normals[i1 * 3], normals[i1 * 3 + 1], normals[i1 * 3 + 2],
          normals[i2 * 3], normals[i2 * 3 + 1], normals[i2 * 3 + 2]
        );
      }

      const gx0 = Math.max(0, Math.floor((Math.min(ax,bx,cx)-bbox.min[0])/voxelSize)-1);
      const gx1 = Math.min(gridX-1, Math.ceil((Math.max(ax,bx,cx)-bbox.min[0])/voxelSize)+1);
      const gy0 = Math.max(0, Math.floor((Math.min(ay,by,cy)-bbox.min[1])/voxelSize)-1);
      const gy1 = Math.min(gridY-1, Math.ceil((Math.max(ay,by,cy)-bbox.min[1])/voxelSize)+1);
      const gz0 = Math.max(0, Math.floor((Math.min(az,bz,cz)-bbox.min[2])/voxelSize)-1);
      const gz1 = Math.min(gridZ-1, Math.ceil((Math.max(az,bz,cz)-bbox.min[2])/voxelSize)+1);

      for (let gz=gz0; gz<=gz1; gz++) {
        for (let gy=gy0; gy<=gy1; gy++) {
          for (let gx=gx0; gx<=gx1; gx++) {
            const pcx = gridOffset[0] + (gx+0.5)*voxelSize;
            const pcy = gridOffset[1] + (gy+0.5)*voxelSize;
            const pcz = gridOffset[2] + (gz+0.5)*voxelSize;
            const hit = triangleClosestBarycentric(pcx, pcy, pcz, ax, ay, az, bx, by, bz, cx, cy, cz);
            if (hit.distSq <= THRESH_SQ) {
              // Remove outward margin bias - use symmetric surface detection
              const idx = gz*gridY*gridX + gy*gridX + gx;
              grid[idx] = 1;
              const o = idx * 3;
              const nw = 1 / (hit.distSq + (voxelSize * 0.07) * (voxelSize * 0.07));
              normalSum[o] += fnx * nw;
              normalSum[o + 1] += fny * nw;
              normalSum[o + 2] += fnz * nw;
              normalWsum[idx] += nw;
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
      }
      if (ti % 64 === 0) reportProgress((ti / triCount) * 25);
    }

  }

  // ── Build scan-line inside/outside grid ──────────────────────────────────────
  // Use 0 PERTURB for symmetric voxelization (no bias toward any direction)
  const PERTURB = 0;
  const insideGrid = buildScanLineInside(triPos, triCount, triGrid, bbox, gridX, gridY, gridZ, voxelSize, PERTURB, gridOffset);
  reportProgress(50);

  // ── Inner-shell removal: for surface-only mode, remove voxels deep inside solid ─
  if (surface) {
    for (let idx = 0; idx < cellCount; idx++) {
      if (grid[idx] === 1 && insideGrid[idx] === 1) {
        grid[idx] = 0; // Remove inner surface layer
      }
    }
  }
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

  // ── Gap-fill: close small holes with morphological closing ──────────────────
  if (interior) {
    const FILL_VOTE_THRESHOLD = 5; // out of 6 face-neighbors
    const MAX_FILL_ITERS = 2;

    for (let iter = 0; iter < MAX_FILL_ITERS; iter++) {
      const toFill: number[] = [];

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

  // Smooth surface normals (6-neighbor box blur) — stabler, more “hand-guided” rotations
  const hasOrient = new Uint8Array(cellCount);
  const orientNx = new Float32Array(cellCount);
  const orientNy = new Float32Array(cellCount);
  const orientNz = new Float32Array(cellCount);
  const smNx = new Float32Array(cellCount);
  const smNy = new Float32Array(cellCount);
  const smNz = new Float32Array(cellCount);

  if (surface && curvedVoxels) {
    for (let idx = 0; idx < cellCount; idx++) {
      if (grid[idx] !== 1 || normalWsum[idx] <= 0) continue;
      const o = idx * 3;
      const ws = normalWsum[idx];
      let nx = normalSum[o] / ws;
      let ny = normalSum[o + 1] / ws;
      let nz = normalSum[o + 2] / ws;
      const nl = Math.hypot(nx, ny, nz) || 1;
      orientNx[idx] = nx / nl;
      orientNy[idx] = ny / nl;
      orientNz[idx] = nz / nl;
      hasOrient[idx] = 1;
    }
    const nxv = gridX;
    const nyv = gridY;
    const nzv = gridZ;
    for (let idx = 0; idx < cellCount; idx++) {
      if (!hasOrient[idx]) continue;
      let sx = orientNx[idx];
      let sy = orientNy[idx];
      let sz = orientNz[idx];
      let w = 1;
      const gz = Math.floor(idx / (nyv * nxv));
      const rem = idx % (nyv * nxv);
      const gy = Math.floor(rem / nxv);
      const gx = rem % nxv;
      const add = (tx: number, ty: number, tz: number) => {
        if (tx < 0 || ty < 0 || tz < 0 || tx >= nxv || ty >= nyv || tz >= nzv) return;
        const ni = tz * nyv * nxv + ty * nxv + tx;
        if (!hasOrient[ni]) return;
        sx += orientNx[ni];
        sy += orientNy[ni];
        sz += orientNz[ni];
        w += 1;
      };
      add(gx + 1, gy, gz);
      add(gx - 1, gy, gz);
      add(gx, gy + 1, gz);
      add(gx, gy - 1, gz);
      add(gx, gy, gz + 1);
      add(gx, gy, gz - 1);
      const inv = 1 / w;
      smNx[idx] = sx * inv;
      smNy[idx] = sy * inv;
      smNz[idx] = sz * inv;
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

        const posX = gridOffset[0] + (gx+0.5)*voxelSize;
        const posY = gridOffset[1] + (gy+0.5)*voxelSize;
        const posZ = gridOffset[2] + (gz+0.5)*voxelSize;

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

        let half = inscribedCubeHalfEdge(cellHalf, quaternion);
        if (state === 1 && curvedVoxels) {
          const pack = 1 + 0.22 * (1 - Math.min(1, curvature * 1.1));
          half *= pack;
          half = Math.min(half, cellHalf * 1.06);
        }
        if (state === 1 && curvature > 0) {
          half *= 1 - 0.05 * Math.min(1, curvature);
        }
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
