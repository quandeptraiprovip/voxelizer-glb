/** Point-in-solid test (parity) for culling inner shell voxels when interior fill is off. */

import type { TriangleGrid } from './triangle-grid';
import { queryTriangleGrid } from './triangle-grid';

const EPSILON = 1e-8;

function rayHitX(
  oy: number, oz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number
): number {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const det = e1z * e2y - e1y * e2z;
  if (Math.abs(det) < EPSILON) return -Infinity;
  const f = 1 / det;
  const sy = oy - ay, sz = oz - az;
  const u = f * (sz * e2y - sy * e2z);
  if (u < -EPSILON || u > 1 + EPSILON) return -Infinity;
  const v = f * (sy * e1z - sz * e1y);
  if (v < -EPSILON || u + v > 1 + EPSILON) return -Infinity;
  return ax + u * (bx - ax) + v * (cx - ax);
}

function rayHitY(
  ox: number, oz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number
): number {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const det = e1x * e2z - e1z * e2x;
  if (Math.abs(det) < EPSILON) return -Infinity;
  const f = 1 / det;
  const sz = oz - az, sx = ox - ax;
  const u = f * (sx * e2z - sz * e2x);
  if (u < -EPSILON || u > 1 + EPSILON) return -Infinity;
  const v = f * (sz * e1x - sx * e1z);
  if (v < -EPSILON || u + v > 1 + EPSILON) return -Infinity;
  return ay + u * (by - ay) + v * (cy - ay);
}

function rayHitZ(
  ox: number, oy: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number
): number {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const det = e1y * e2x - e1x * e2y;
  if (Math.abs(det) < EPSILON) return -Infinity;
  const f = 1 / det;
  const sx = ox - ax, sy = oy - ay;
  const u = f * (sy * e2x - sx * e2y);
  if (u < -EPSILON || u > 1 + EPSILON) return -Infinity;
  const v = f * (sx * e1y - sy * e1x);
  if (v < -EPSILON || u + v > 1 + EPSILON) return -Infinity;
  return az + u * (bz - az) + v * (cz - az);
}

/** Majority-vote parity: true if point lies inside closed solid (not cavity). */
export function isInsideSolid(
  px: number,
  py: number,
  pz: number,
  triPos: Float32Array,
  triCount: number,
  triGrid: TriangleGrid,
  bboxMin: [number, number, number],
  voxelSize: number
): boolean {
  let voteX = 0;
  let voteY = 0;
  let voteZ = 0;
  const candidates = queryTriangleGrid(triGrid, px, py, pz, 1);

  for (const ti of candidates) {
    const b = ti * 9;
    const hitX = rayHitX(py, pz, triPos[b], triPos[b + 1], triPos[b + 2],
      triPos[b + 3], triPos[b + 4], triPos[b + 5],
      triPos[b + 6], triPos[b + 7], triPos[b + 8]);
    if (hitX > -Infinity && hitX > bboxMin[0] - voxelSize && hitX <= px) voteX++;
  }
  for (const ti of candidates) {
    const b = ti * 9;
    const hitY = rayHitY(px, pz, triPos[b], triPos[b + 1], triPos[b + 2],
      triPos[b + 3], triPos[b + 4], triPos[b + 5],
      triPos[b + 6], triPos[b + 7], triPos[b + 8]);
    if (hitY > -Infinity && hitY > bboxMin[1] - voxelSize && hitY <= py) voteY++;
  }
  for (const ti of candidates) {
    const b = ti * 9;
    const hitZ = rayHitZ(px, py, triPos[b], triPos[b + 1], triPos[b + 2],
      triPos[b + 3], triPos[b + 4], triPos[b + 5],
      triPos[b + 6], triPos[b + 7], triPos[b + 8]);
    if (hitZ > -Infinity && hitZ > bboxMin[2] - voxelSize && hitZ <= pz) voteZ++;
  }

  const insideCount = [voteX % 2 === 1, voteY % 2 === 1, voteZ % 2 === 1].filter(Boolean).length;
  return insideCount >= 2;
}
