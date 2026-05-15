/**
 * Uniform spatial grid for triangle meshes — reduces surface / ray tests
 * from O(triangles) per query to O(triangles in nearby cells).
 */

export interface TriangleGrid {
  cellSize: number;
  origin: [number, number, number];
  dims: [number, number, number];
  /** cellKey → list of triangle indices */
  buckets: Map<number, number[]>;
}

function cellKey(ix: number, iy: number, iz: number, dims: [number, number, number]): number {
  return iz * dims[1] * dims[0] + iy * dims[0] + ix;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Build grid covering bbox; cellSize typically equals voxel size. */
export function buildTriangleGrid(
  triPos: Float32Array,
  triCount: number,
  min: [number, number, number],
  max: [number, number, number],
  cellSize: number
): TriangleGrid {
  const sizeX = max[0] - min[0] || cellSize;
  const sizeY = max[1] - min[1] || cellSize;
  const sizeZ = max[2] - min[2] || cellSize;

  const dims: [number, number, number] = [
    Math.max(1, Math.ceil(sizeX / cellSize)),
    Math.max(1, Math.ceil(sizeY / cellSize)),
    Math.max(1, Math.ceil(sizeZ / cellSize)),
  ];

  const buckets = new Map<number, number[]>();

  const toCell = (x: number, y: number, z: number): [number, number, number] => [
    clamp(Math.floor((x - min[0]) / cellSize), 0, dims[0] - 1),
    clamp(Math.floor((y - min[1]) / cellSize), 0, dims[1] - 1),
    clamp(Math.floor((z - min[2]) / cellSize), 0, dims[2] - 1),
  ];

  for (let ti = 0; ti < triCount; ti++) {
    const b = ti * 9;
    const ax = triPos[b], ay = triPos[b + 1], az = triPos[b + 2];
    const bx = triPos[b + 3], by = triPos[b + 4], bz = triPos[b + 5];
    const cx = triPos[b + 6], cy = triPos[b + 7], cz = triPos[b + 8];

    const tMinX = Math.min(ax, bx, cx);
    const tMaxX = Math.max(ax, bx, cx);
    const tMinY = Math.min(ay, by, cy);
    const tMaxY = Math.max(ay, by, cy);
    const tMinZ = Math.min(az, bz, cz);
    const tMaxZ = Math.max(az, bz, cz);

    const [ix0, iy0, iz0] = toCell(tMinX, tMinY, tMinZ);
    const [ix1, iy1, iz1] = toCell(tMaxX, tMaxY, tMaxZ);

    for (let iz = iz0; iz <= iz1; iz++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const key = cellKey(ix, iy, iz, dims);
          let list = buckets.get(key);
          if (!list) {
            list = [];
            buckets.set(key, list);
          }
          list.push(ti);
        }
      }
    }
  }

  return { cellSize, origin: min, dims, buckets };
}

export function queryTriangleGrid(
  grid: TriangleGrid,
  x: number,
  y: number,
  z: number,
  neighborRadius = 1
): number[] {
  const { origin, dims, cellSize, buckets } = grid;
  const ix = clamp(Math.floor((x - origin[0]) / cellSize), 0, dims[0] - 1);
  const iy = clamp(Math.floor((y - origin[1]) / cellSize), 0, dims[1] - 1);
  const iz = clamp(Math.floor((z - origin[2]) / cellSize), 0, dims[2] - 1);

  const out: number[] = [];
  const seen = new Set<number>();

  for (let dz = -neighborRadius; dz <= neighborRadius; dz++) {
    for (let dy = -neighborRadius; dy <= neighborRadius; dy++) {
      for (let dx = -neighborRadius; dx <= neighborRadius; dx++) {
        const cx = ix + dx;
        const cy = iy + dy;
        const cz = iz + dz;
        if (cx < 0 || cy < 0 || cz < 0 || cx >= dims[0] || cy >= dims[1] || cz >= dims[2]) continue;
        const key = cellKey(cx, cy, cz, dims);
        const list = buckets.get(key);
        if (!list) continue;
        for (const ti of list) {
          if (!seen.has(ti)) {
            seen.add(ti);
            out.push(ti);
          }
        }
      }
    }
  }
  return out;
}

/** Cap voxel grid resolution so interior pass stays tractable. */
export const MAX_VOXEL_GRID_CELLS = 512_000;

export function clampVoxelGrid(
  sizeX: number,
  sizeY: number,
  sizeZ: number,
  voxelSize: number,
  maxCells = MAX_VOXEL_GRID_CELLS
): { voxelSize: number; gridX: number; gridY: number; gridZ: number } {
  let vs = voxelSize;
  let gridX = Math.max(1, Math.ceil(sizeX / vs));
  let gridY = Math.max(1, Math.ceil(sizeY / vs));
  let gridZ = Math.max(1, Math.ceil(sizeZ / vs));
  let cells = gridX * gridY * gridZ;

  if (cells <= maxCells) {
    return { voxelSize: vs, gridX, gridY, gridZ };
  }

  const scale = Math.cbrt(cells / maxCells);
  vs *= scale;
  gridX = Math.max(1, Math.ceil(sizeX / vs));
  gridY = Math.max(1, Math.ceil(sizeY / vs));
  gridZ = Math.max(1, Math.ceil(sizeZ / vs));
  return { voxelSize: vs, gridX, gridY, gridZ };
}
