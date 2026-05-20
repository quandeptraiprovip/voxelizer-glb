/** Surface curvature + oriented boxes that fit inside a grid cell (no overlap). */

export type Quat = [number, number, number, number]; // x, y, z, w
export type Euler = [number, number, number]; // XYZ radians

/** Vertex-normal variation on a triangle (0 = flat, higher = more curved). */
export function triangleCurvature(
  n0x: number, n0y: number, n0z: number,
  n1x: number, n1y: number, n1z: number,
  n2x: number, n2y: number, n2z: number
): number {
  const dot01 = Math.max(-1, Math.min(1, n0x * n1x + n0y * n1y + n0z * n1z));
  const dot12 = Math.max(-1, Math.min(1, n1x * n2x + n1y * n2y + n1z * n2z));
  const dot20 = Math.max(-1, Math.min(1, n2x * n0x + n2y * n0y + n2z * n0z));
  const a = Math.acos(dot01);
  const b = Math.acos(dot12);
  const c = Math.acos(dot20);
  return (a + b + c) / (Math.PI * 1.5);
}

/** Quaternion rotating local +Z onto unit normal (nx, ny, nz). */
export function quaternionFromZToNormal(nx: number, ny: number, nz: number): Quat {
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-8) return [0, 0, 0, 1];
  nx /= len;
  ny /= len;
  nz /= len;

  const zx = 0;
  const zy = 0;
  const zz = 1;
  const dot = zz * nz;
  if (dot > 0.999999) return [0, 0, 0, 1];
  if (dot < -0.999999) return [1, 0, 0, 0];

  const cx = zy * nz - zz * ny;
  const cy = zz * nx - zx * nz;
  const cz = zx * ny - zy * nx;
  const s = Math.sqrt((1 + dot) * 2);
  const invs = 1 / s;
  return [cx * invs, cy * invs, cz * invs, s * 0.5];
}

export function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  let ax = a[0], ay = a[1], az = a[2], aw = a[3];
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cos > 0.9995) {
    return normalizeQuat([
      ax + t * (bx - ax),
      ay + t * (by - ay),
      az + t * (bz - az),
      aw + t * (bw - aw),
    ]);
  }
  const sin = Math.sqrt(1 - cos * cos);
  const ang = Math.atan2(sin, cos);
  const s0 = Math.sin((1 - t) * ang) / sin;
  const s1 = Math.sin(t * ang) / sin;
  return [s0 * ax + s1 * bx, s0 * ay + s1 * by, s0 * az + s1 * bz, s0 * aw + s1 * bw];
}

export function normalizeQuat(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** 3×3 rotation matrix (row-major flat length 9) from quaternion. */
export function quatToMatrix3(q: Quat): Float32Array {
  const [x, y, z, w] = normalizeQuat(q);
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  return new Float32Array([
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy),
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx),
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy),
  ]);
}

/** Max half-extent of axis-aligned bbox of a cube with half-edge h rotated by q. */
export function rotatedCubeAABBHalfExtent(h: number, q: Quat): number {
  const m = quatToMatrix3(q);
  let rx = 0;
  let ry = 0;
  let rz = 0;
  for (let j = 0; j < 3; j++) {
    rx += Math.abs(m[j]);
    ry += Math.abs(m[3 + j]);
    rz += Math.abs(m[6 + j]);
  }
  return h * Math.max(rx, ry, rz, 1e-6);
}

/** Largest cube half-edge centered in cell so AABB stays inside cellHalf. */
export function inscribedCubeHalfEdge(cellHalf: number, q: Quat): number {
  const m = quatToMatrix3(q);
  let rx = 0;
  let ry = 0;
  let rz = 0;
  for (let j = 0; j < 3; j++) {
    rx += Math.abs(m[j]);
    ry += Math.abs(m[3 + j]);
    rz += Math.abs(m[6 + j]);
  }
  const scale = Math.max(rx, ry, rz, 1e-6);
  return cellHalf / scale;
}

export function rotateLocalPoint(q: Quat, lx: number, ly: number, lz: number): [number, number, number] {
  const m = quatToMatrix3(q);
  return [
    m[0] * lx + m[1] * ly + m[2] * lz,
    m[3] * lx + m[4] * ly + m[5] * lz,
    m[6] * lx + m[7] * ly + m[8] * lz,
  ];
}

export function quaternionToEuler(q: Quat): Euler {
  const [x, y, z, w] = normalizeQuat(q);
  const sinr = 2 * (w * x + y * z);
  const cosr = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinr, cosr);
  const sinp = 2 * (w * y - z * x);
  const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);
  const siny = 2 * (w * z + x * y);
  const cosy = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(siny, cosy);
  return [roll, pitch, yaw];
}

/**
 * Full rotation: local +X/+Y/+Z map to stable tangent frame on the surface.
 * Twist around the normal follows world `up` (default +Y), like deliberate “grain”
 * in hand-placed voxels instead of an arbitrary phase from `cross(Z, n)`.
 */
export function quaternionStableSurfaceFrame(
  nx: number,
  ny: number,
  nz: number,
  upx = 0,
  upy = 1,
  upz = 0
): Quat {
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-8) return [0, 0, 0, 1];
  const n0 = nx / len;
  const n1 = ny / len;
  const n2 = nz / len;

  // Project world up onto the plane: u_proj = u - (u·n)*n
  const dot = upx * n0 + upy * n1 + upz * n2;
  let ux = upx - dot * n0;
  let uy = upy - dot * n1;
  let uz = upz - dot * n2;

  // Normalize projected up vector
  const uproj_len = Math.hypot(ux, uy, uz);
  if (uproj_len > 1e-6) {
    ux /= uproj_len;
    uy /= uproj_len;
    uz /= uproj_len;
  } else {
    // Fallback: if projection is too small, use [1,0,0] as up-on-plane
    ux = 1;
    uy = 0;
    uz = 0;
  }

  let t1x = uy * n2 - uz * n1;
  let t1y = uz * n0 - ux * n2;
  let t1z = ux * n1 - uy * n0;
  let t1l = Math.hypot(t1x, t1y, t1z);
  if (t1l < 1e-6) {
    ux = 1;
    uy = 0;
    uz = 0;
    t1x = uy * n2 - uz * n1;
    t1y = uz * n0 - ux * n2;
    t1z = ux * n1 - uy * n0;
    t1l = Math.hypot(t1x, t1y, t1z) || 1;
  }
  t1x /= t1l;
  t1y /= t1l;
  t1z /= t1l;

  const t2x = n1 * t1z - n2 * t1y;
  const t2y = n2 * t1x - n0 * t1z;
  const t2z = n0 * t1y - n1 * t1x;

  // Row-major R with p' = R * p_local; columns are images of local X,Y,Z.
  const m0 = t1x;
  const m1 = t2x;
  const m2 = n0;
  const m3 = t1y;
  const m4 = t2y;
  const m5 = n1;
  const m6 = t1z;
  const m7 = t2z;
  const m8 = n2;

  return normalizeQuat(rotationMatrix3ToQuaternion(m0, m1, m2, m3, m4, m5, m6, m7, m8));
}

/** Pure rotation 3×3 (row-major) → unit quaternion [x,y,z,w]. */
function rotationMatrix3ToQuaternion(
  m0: number,
  m1: number,
  m2: number,
  m3: number,
  m4: number,
  m5: number,
  m6: number,
  m7: number,
  m8: number
): Quat {
  const m11 = m0;
  const m12 = m1;
  const m13 = m2;
  const m21 = m3;
  const m22 = m4;
  const m23 = m5;
  const m31 = m6;
  const m32 = m7;
  const m33 = m8;

  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return [
      (m32 - m23) * s,
      (m13 - m31) * s,
      (m21 - m12) * s,
      0.25 / s,
    ];
  }
  if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    return [
      0.25 * s,
      (m12 + m21) / s,
      (m13 + m31) / s,
      (m32 - m23) / s,
    ];
  }
  if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    return [
      (m12 + m21) / s,
      0.25 * s,
      (m23 + m32) / s,
      (m13 - m31) / s,
    ];
  }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
  return [
    (m13 + m31) / s,
    (m23 + m32) / s,
    0.25 * s,
    (m21 - m12) / s,
  ];
}

/**
 * Full surface alignment: local Z → surface normal, local Y → world-up projected
 * onto the tangent plane for stable twist ("grain") across connected flat regions.
 * curvature is accepted for API compatibility but no longer used for blending —
 * flat surfaces have the most reliable normals and benefit most from full alignment.
 */
export function orientationForSurface(
  nx: number,
  ny: number,
  nz: number,
  _curvature: number,
): Quat {
  return quaternionStableSurfaceFrame(nx, ny, nz);
}
