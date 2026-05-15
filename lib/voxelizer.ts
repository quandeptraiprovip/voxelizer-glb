import * as THREE from 'three';
import { buildPreviewVertexColors } from './preview-colors';

export interface Voxel {
  position: number[];
  normal: number[];
  color: number[];
  size: number;
  z_height: number;
  /** Euler XYZ radians — oriented voxel aligned to surface curvature */
  rotation: [number, number, number];
  quaternion: [number, number, number, number];
  curvature: number;
  type?: 'surface' | 'interior';
}

const EPSILON = 1e-8;

// ─── FILE PARSERS ─────────────────────────────────────────────────────────────

export async function parseModelFile(file: File): Promise<THREE.BufferGeometry> {
  const arrayBuffer = await file.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);
  const ext = file.name.toLowerCase();

  // Parse synchronously for now - web worker has compatibility issues
  // TODO: Fix worker loading with Next.js
  let geo: THREE.BufferGeometry;

  if (ext.endsWith('.glb') || ext.endsWith('.gltf')) {
    geo = parseGLB(uint8);
  } else if (ext.endsWith('.obj')) {
    geo = parseOBJ(new TextDecoder().decode(uint8));
  } else if (ext.endsWith('.stl')) {
    geo = parseSTL(uint8);
  } else {
    throw new Error('Unsupported file format');
  }

  return geo;
}

function parseGLB(data: Uint8Array): THREE.BufferGeometry {
  const view = new DataView(data.buffer, data.byteOffset);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('Invalid GLB file');

  const fileLength = view.getUint32(8, true);
  let offset = 12;
  let geometry: THREE.BufferGeometry | null = null;

  while (offset < fileLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType  = view.getUint32(offset + 4, true);
    offset += 8;

    if (chunkType === 0x4e4f534a /* JSON */) {
      const json = JSON.parse(new TextDecoder().decode(data.subarray(offset, offset + chunkLength)));
      offset += chunkLength;

      // Find BIN chunk
      while (offset < fileLength) {
        const binLen  = view.getUint32(offset, true);
        const binType = view.getUint32(offset + 4, true);
        offset += 8;
        if (binType === 0x004e4942 /* BIN */) {
          // Pass the exact slice so byteOffset is always 0 inside helpers
          geometry = parseGLTFMesh(json, data.slice(offset, offset + binLen));
          break;
        }
        offset += binLen;
      }
      break;
    }
    offset += chunkLength;
  }

  if (!geometry) throw new Error('No mesh found in GLB');
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  return geometry;
}

function parseGLTFMesh(json: any, binData: Uint8Array): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  if (!json.meshes?.length) return geo;

  const { accessors, bufferViews } = json;
  const positions: Float32Array[] = [];
  const normals: Float32Array[] = [];
  const colors: Float32Array[] = [];
  const indices: (Uint32Array | null)[] = [];  // null if primitive has no indices
  let vertexCount = 0;
  let totalPositions = 0;

  // Merge all meshes and primitives
  for (const mesh of json.meshes) {
    if (!mesh.primitives?.length) continue;
    for (const prim of mesh.primitives) {
      if (prim.attributes?.POSITION === undefined) continue;

      // Read positions
      const pos = readFloats(binData, accessors[prim.attributes.POSITION], bufferViews);
      positions.push(pos);
      totalPositions += pos.length;

      // Read normals if available
      if (prim.attributes?.NORMAL !== undefined) {
        const norm = readFloats(binData, accessors[prim.attributes.NORMAL], bufferViews);
        normals.push(norm);
      }

      // Extract material color - try baseColorFactor first, then fallback to color property
      const material = prim.material !== undefined ? json.materials?.[prim.material] : undefined;
      let baseColor: [number, number, number] = [1, 1, 1];

      // Try baseColorFactor (PBR metallic roughness)
      const baseColorFactor = material?.pbrMetallicRoughness?.baseColorFactor;
      if (baseColorFactor && baseColorFactor.length >= 3) {
        baseColor = [
          Math.max(0, Math.min(1, baseColorFactor[0] ?? 1)),
          Math.max(0, Math.min(1, baseColorFactor[1] ?? 1)),
          Math.max(0, Math.min(1, baseColorFactor[2] ?? 1)),
        ];
      }
      // Fallback: try direct color property
      else if (material?.color) {
        baseColor = [
          Math.max(0, Math.min(1, material.color[0] ?? 1)),
          Math.max(0, Math.min(1, material.color[1] ?? 1)),
          Math.max(0, Math.min(1, material.color[2] ?? 1)),
        ];
      }
      // Fallback: try emissive color if available
      else if (material?.emissiveFactor) {
        baseColor = [
          Math.max(0, Math.min(1, material.emissiveFactor[0] ?? 1)),
          Math.max(0, Math.min(1, material.emissiveFactor[1] ?? 1)),
          Math.max(0, Math.min(1, material.emissiveFactor[2] ?? 1)),
        ];
      }

      // Read vertex colors if available
      if (prim.attributes?.COLOR_0 !== undefined) {
        const col = readFloats(binData, accessors[prim.attributes.COLOR_0], bufferViews);
        const componentCount = accessors[prim.attributes.COLOR_0].type === 'VEC4' ? 4 : 3;
        const baked = new Float32Array(Math.floor(col.length / componentCount) * 3);

        // Extract RGB and ignore alpha
        for (let i = 0; i < baked.length; i += 3) {
          const srcIdx = i / 3 * componentCount;
          baked[i] = (col[srcIdx] ?? 1) * baseColor[0];
          baked[i + 1] = (col[srcIdx + 1] ?? 1) * baseColor[1];
          baked[i + 2] = (col[srcIdx + 2] ?? 1) * baseColor[2];
        }
        colors.push(baked);
      } else {
        // No vertex colors - use material color for all vertices
        const baked = new Float32Array(pos.length);
        for (let i = 0; i < baked.length; i += 3) {
          baked[i] = baseColor[0];
          baked[i + 1] = baseColor[1];
          baked[i + 2] = baseColor[2];
        }
        colors.push(baked);
      }

      // Read indices or create sequential ones
      if (prim.indices !== undefined) {
        const idx = readIndices(binData, accessors[prim.indices], bufferViews);
        indices.push(idx);
      } else {
        // Create sequential indices for non-indexed primitive
        const idx = new Uint32Array(Math.floor(pos.length / 3));
        for (let i = 0; i < idx.length; i++) idx[i] = i;
        indices.push(idx);
      }

      vertexCount += pos.length / 3;
    }
  }

  if (totalPositions === 0) return geo;

  // Merge all position data
  const mergedPositions = new Float32Array(totalPositions);
  let offset = 0;
  for (const pos of positions) {
    mergedPositions.set(pos, offset);
    offset += pos.length;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(mergedPositions, 3));

  // Merge all normal data if present
  if (normals.length === positions.length) {
    const mergedNormals = new Float32Array(totalPositions);
    let offset = 0;
    for (let i = 0; i < normals.length; i++) {
      const norm = normals[i];
      if (norm && norm.length > 0) {
        mergedNormals.set(norm, offset);
      }
      offset += positions[i].length;
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(mergedNormals, 3));
  }

  // Merge all color data if present
  if (colors.length === positions.length) {
    const mergedColors = new Float32Array(totalPositions);
    let offset = 0;
    for (let i = 0; i < colors.length; i++) {
      const col = colors[i];
      if (col && col.length > 0) {
        mergedColors.set(col, offset);
      }
      offset += positions[i].length;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(mergedColors, 3));
  }

  // Merge and offset indices
  let totalIndices = 0;
  for (const idx of indices) {
    if (idx) totalIndices += idx.length;
  }
  const mergedIndices = new Uint32Array(totalIndices);
  let idxOffset = 0;
  let vertexOffset = 0;
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    if (idx) {
      for (let j = 0; j < idx.length; j++) {
        mergedIndices[idxOffset++] = idx[j] + vertexOffset;
      }
    }
    vertexOffset += positions[i].length / 3;
  }
  geo.setIndex(new THREE.BufferAttribute(mergedIndices, 1));

  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  return geo;
}

/**
 * Read accessor data via DataView — handles byteOffset and byteStride correctly.
 * `binData` must be a clean slice (byteOffset === 0).
 */
function readFloats(binData: Uint8Array, accessor: any, bufferViews: any[]): Float32Array {
  const bv         = bufferViews[accessor.bufferView];
  const bvOffset   = bv.byteOffset   ?? 0;
  const accOffset  = accessor.byteOffset ?? 0;
  const stride     = bv.byteStride   ?? 0;
  const components = ({ SCALAR:1, VEC2:2, VEC3:3, VEC4:4 } as Record<string,number>)[accessor.type] ?? 1;
  const count      = accessor.count;
  const out        = new Float32Array(count * components);
  const elemBytes  = accessor.componentType === 5123 ? 2 : 4;
  const effectiveStride = stride || components * elemBytes;
  const baseOffset = bvOffset + accOffset;

  // Ensure we don't exceed buffer bounds
  if (baseOffset >= binData.byteLength) {
    console.warn(`readFloats: offset ${baseOffset} exceeds buffer length ${binData.byteLength}`);
    return out;
  }

  // Create a new DataView that is scoped to the remaining data
  const remainingBytes = binData.byteLength - baseOffset;
  const dv = new DataView(binData.buffer, binData.byteOffset + baseOffset, remainingBytes);

  for (let i = 0; i < count; i++) {
    for (let j = 0; j < components; j++) {
      const pos = i * effectiveStride + j * elemBytes;
      // Check bounds before reading
      const requiredBytes = elemBytes;
      if (pos + requiredBytes > remainingBytes) {
        console.warn(`readFloats: reading at ${pos} + ${requiredBytes} exceeds remaining ${remainingBytes}`);
        out[i * components + j] = 0;
        continue;
      }

      if (accessor.componentType === 5126) {          // FLOAT
        out[i * components + j] = dv.getFloat32(pos, true);
      } else if (accessor.componentType === 5125) {   // UNSIGNED_INT
        out[i * components + j] = dv.getUint32(pos, true);
      } else if (accessor.componentType === 5123) {   // UNSIGNED_SHORT
        out[i * components + j] = dv.getUint16(pos, true);
      }
    }
  }
  return out;
}

function readIndices(binData: Uint8Array, accessor: any, bufferViews: any[]): Uint32Array {
  const bv   = bufferViews[accessor.bufferView];
  const base = (bv.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const n    = accessor.count;
  const out  = new Uint32Array(n);
  const elemSize = accessor.componentType === 5125 ? 4 : 2;

  // Ensure we don't exceed buffer bounds
  if (base >= binData.byteLength) {
    console.warn(`readIndices: offset ${base} exceeds buffer length ${binData.byteLength}`);
    return out;
  }

  const remainingBytes = binData.byteLength - base;
  const dv = new DataView(binData.buffer, binData.byteOffset + base, remainingBytes);

  for (let i = 0; i < n; i++) {
    const pos = i * elemSize;
    // Check bounds before reading
    if (pos + elemSize > remainingBytes) {
      console.warn(`readIndices: reading at ${pos} + ${elemSize} exceeds remaining ${remainingBytes}`);
      out[i] = 0;
      continue;
    }
    out[i] = accessor.componentType === 5125
      ? dv.getUint32(pos, true)
      : dv.getUint16(pos, true);
  }
  return out;
}

// ─── OBJ / STL ───────────────────────────────────────────────────────────────

function parseOBJ(text: string): THREE.BufferGeometry {
  const vertices: [number,number,number][] = [];
  const vNormals: [number,number,number][] = [];
  const positions: number[] = [];
  const normals:   number[] = [];

  for (const line of text.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'v'  && p.length >= 4) vertices.push([+p[1], +p[2], +p[3]]);
    if (p[0] === 'vn' && p.length >= 4) vNormals.push([+p[1], +p[2], +p[3]]);
    if (p[0] === 'f'  && p.length >= 4) {
      for (let i = 1; i <= p.length - 2; i++) {
        for (const idx of [p[1], p[i+1], p[i+2]]) {
          if (!idx) continue;
          const parts = idx.split('/');
          const vi = parseInt(parts[0]) - 1;
          const ni = parts[2] ? parseInt(parts[2]) - 1 : -1;
          if (vi >= 0 && vi < vertices.length) {
            positions.push(...vertices[vi]);
            if (ni >= 0 && ni < vNormals.length) normals.push(...vNormals[ni]);
          }
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  if (normals.length) geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  else geo.computeVertexNormals();
  return geo;
}

function parseSTL(data: Uint8Array): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals:   number[] = [];
  const view = new DataView(data.buffer, data.byteOffset);
  const triCount = view.getUint32(80, true);
  let off = 84;

  for (let i = 0; i < triCount && off + 50 <= data.length; i++) {
    const nx = view.getFloat32(off, true), ny = view.getFloat32(off+4, true), nz = view.getFloat32(off+8, true);
    off += 12;
    for (let j = 0; j < 3; j++) {
      positions.push(view.getFloat32(off, true), view.getFloat32(off+4, true), view.getFloat32(off+8, true));
      normals.push(nx, ny, nz);
      off += 12;
    }
    off += 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('normal',   new THREE.BufferAttribute(new Float32Array(normals), 3));
  return geo;
}

// ─── TRIANGLE EXTRACTION ─────────────────────────────────────────────────────

interface TriangleData {
  positions: Float32Array;
  colors: Float32Array;
  normals: Float32Array;
  indices: any;
}

/** Returns triangle positions and per-vertex colors/normals */
function extractTriangles(geometry: THREE.BufferGeometry): TriangleData {
  const pos = (geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
  const idx = geometry.getIndex();
  const colorAttr = geometry.getAttribute('color');
  const normalAttr = geometry.getAttribute('normal');

  let colors = new Float32Array(pos.length);
  let normals = new Float32Array(pos.length);
  let indices: any;

  // Use vertex colors if available, else white
  if (colorAttr) {
    const col = (colorAttr as THREE.BufferAttribute).array as Float32Array;
    colors.set(col.subarray(0, Math.min(col.length, colors.length)));
  } else {
    colors.fill(1, 0, colors.length);
  }

  // Use normals if available
  if (normalAttr) {
    const norm = (normalAttr as THREE.BufferAttribute).array as Float32Array;
    normals.set(norm.subarray(0, Math.min(norm.length, normals.length)));
  } else {
    normals.fill(0, 0, normals.length);
  }

  // Get or create indices
  if (idx) {
    indices = idx.array as any;
  } else {
    // Create sequential indices for non-indexed geometry
    const count = Math.floor(pos.length / 3);
    indices = new Uint32Array(count);
    for (let i = 0; i < count; i++) indices[i] = i;
  }

  return { positions: pos, colors, normals, indices };
}

// ─── MÖLLER–TRUMBORE  (generic + X/Y/Z specializations) ──────────────────────

function rayXHit(
  ox:number, oy:number, oz:number,
  v0x:number,v0y:number,v0z:number,
  v1x:number,v1y:number,v1z:number,
  v2x:number,v2y:number,v2z:number
): number {
  const e1x=v1x-v0x, e1y=v1y-v0y, e1z=v1z-v0z;
  const e2x=v2x-v0x, e2y=v2y-v0y, e2z=v2z-v0z;
  const a = e1z*e2y - e1y*e2z;
  if (Math.abs(a) < EPSILON) return -Infinity;
  const f  = 1/a;
  const sy = oy-v0y, sz = oz-v0z;
  const u = f*(sz*e2y - sy*e2z);
  if (u < -EPSILON || u > 1+EPSILON) return -Infinity;
  const v = f*(sy*e1z - sz*e1y);
  if (v < -EPSILON || u+v > 1+EPSILON) return -Infinity;
  const sx = ox-v0x;
  const qx = sy*e1z - sz*e1y;
  const qy = sz*e1x - sx*e1z;
  const qz = sx*e1y - sy*e1x;
  const t  = f*(e2x*qx + e2y*qy + e2z*qz);
  return t > EPSILON ? ox+t : -Infinity;
}

function rayYHit(
  ox:number, oy:number, oz:number,
  v0x:number,v0y:number,v0z:number,
  v1x:number,v1y:number,v1z:number,
  v2x:number,v2y:number,v2z:number
): number {
  const e1x=v1x-v0x, e1y=v1y-v0y, e1z=v1z-v0z;
  const e2x=v2x-v0x, e2y=v2y-v0y, e2z=v2z-v0z;
  const a = e1x*e2z - e1z*e2x;
  if (Math.abs(a) < EPSILON) return -Infinity;
  const f  = 1/a;
  const sz = oz-v0z, sx = ox-v0x;
  const u = f*(sx*e2z - sz*e2x);
  if (u < -EPSILON || u > 1+EPSILON) return -Infinity;
  const v = f*(sz*e1x - sx*e1z);
  if (v < -EPSILON || u+v > 1+EPSILON) return -Infinity;
  const sy = oy-v0y;
  const qx = sz*e1x - sx*e1z;
  const qy = sx*e2z - sz*e2x;
  const qz = sx*e1y - sy*e1x;
  const t  = f*(e2y*qx + e1y*qy - qz);
  return t > EPSILON ? oy+t : -Infinity;
}

function rayZHit(
  ox:number, oy:number, oz:number,
  v0x:number,v0y:number,v0z:number,
  v1x:number,v1y:number,v1z:number,
  v2x:number,v2y:number,v2z:number
): number {
  const e1x=v1x-v0x, e1y=v1y-v0y, e1z=v1z-v0z;
  const e2x=v2x-v0x, e2y=v2y-v0y, e2z=v2z-v0z;
  const a = e1y*e2x - e1x*e2y;
  if (Math.abs(a) < EPSILON) return -Infinity;
  const f  = 1/a;
  const sx = ox-v0x, sy = oy-v0y;
  const u = f*(sy*e2x - sx*e2y);
  if (u < -EPSILON || u > 1+EPSILON) return -Infinity;
  const v = f*(sx*e1y - sy*e1x);
  if (v < -EPSILON || u+v > 1+EPSILON) return -Infinity;
  const sz = oz-v0z;
  const qx = sy*e1x - sx*e1y;
  const qy = sx*e2y - sy*e2x;
  const qz = sx*e1z - sz*e1x;
  const t  = f*(e2z*qx + e1z*qy + qz);
  return t > EPSILON ? oz+t : -Infinity;
}

// Count ray intersections and return inside (odd) or outside (even) via parity rule
function countRayIntersections(
  px: number, py: number, pz: number,
  direction: 'x' | 'y' | 'z',
  triPosData: number[],
  triCount: number,
  bbox: THREE.Box3,
  baseVoxelSize: number
): boolean {
  const EPSILON = 1e-8;
  let intersectionCount = 0;
  const rayOrigin = (direction === 'x') ? (bbox.min.x - baseVoxelSize) :
                    (direction === 'y') ? (bbox.min.y - baseVoxelSize) :
                    (bbox.min.z - baseVoxelSize);
  const targetCoord = (direction === 'x') ? px : (direction === 'y') ? py : pz;

  for (let ti = 0; ti < triCount; ti++) {
    const b = ti * 9;
    const ax = triPosData[b], ay = triPosData[b + 1], az = triPosData[b + 2];
    const bx = triPosData[b + 3], by = triPosData[b + 4], bz = triPosData[b + 5];
    const cx = triPosData[b + 6], cy = triPosData[b + 7], cz = triPosData[b + 8];

    let hitCoord = -Infinity;

    if (direction === 'x') {
      hitCoord = rayXHit(rayOrigin, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz);
    } else if (direction === 'y') {
      hitCoord = rayYHit(px, rayOrigin, pz, ax, ay, az, bx, by, bz, cx, cy, cz);
    } else {
      hitCoord = rayZHit(px, py, rayOrigin, ax, ay, az, bx, by, bz, cx, cy, cz);
    }

    // Count intersections between ray origin and target point
    if (hitCoord > rayOrigin && hitCoord <= targetCoord) {
      intersectionCount++;
    }
  }

  // Parity rule: odd count = inside, even count = outside
  return intersectionCount % 2 === 1;
}

// Sample color at barycentric coordinates on triangle
function sampleColorOnTri(
  u: number, v: number,
  c0x: number, c0y: number, c0z: number,
  c1x: number, c1y: number, c1z: number,
  c2x: number, c2y: number, c2z: number
): [number, number, number] {
  const w = 1 - u - v;
  const r = w * c0x + u * c1x + v * c2x;
  const g = w * c0y + u * c1y + v * c2y;
  const b = w * c0z + u * c1z + v * c2z;
  return [r, g, b];
}

// Calculate surface curvature (variation in normals)
function calculateCurvature(
  n0x: number, n0y: number, n0z: number,
  n1x: number, n1y: number, n1z: number,
  n2x: number, n2y: number, n2z: number
): number {
  const d01 = Math.abs(n0x*n1x + n0y*n1y + n0z*n1z - 1);
  const d12 = Math.abs(n1x*n2x + n1y*n2y + n1z*n2z - 1);
  const d20 = Math.abs(n2x*n0x + n2y*n0y + n2z*n0z - 1);
  return (d01 + d12 + d20) / 3;
}

// ─── SURFACE VOXELIZATION FALLBACK ───────────────────────────────────────────
// Used when solid fill finds 0 voxels (non-watertight mesh).
// Marks voxels within sqrt(3)/2 * voxelSize of any triangle surface.

function closestDistToTriSq(
  px:number,py:number,pz:number,
  ax:number,ay:number,az:number,
  bx:number,by:number,bz:number,
  cx:number,cy:number,cz:number
): number {
  const abx=bx-ax,aby=by-ay,abz=bz-az;
  const acx=cx-ax,acy=cy-ay,acz=cz-az;
  const apx=px-ax,apy=py-ay,apz=pz-az;
  const d1=abx*apx+aby*apy+abz*apz, d2=acx*apx+acy*apy+acz*apz;
  if(d1<=0&&d2<=0){return apx*apx+apy*apy+apz*apz;}
  const bpx=px-bx,bpy=py-by,bpz=pz-bz;
  const d3=abx*bpx+aby*bpy+abz*bpz,d4=acx*bpx+acy*bpy+acz*bpz;
  if(d3>=0&&d4<=d3){return bpx*bpx+bpy*bpy+bpz*bpz;}
  const cpx=px-cx,cpy=py-cy,cpz=pz-cz;
  const d5=abx*cpx+aby*cpy+abz*cpz,d6=acx*cpx+acy*cpy+acz*cpz;
  if(d6>=0&&d5<=d6){return cpx*cpx+cpy*cpy+cpz*cpz;}
  const vc=d1*d4-d3*d2; if(vc<=0&&d1>=0&&d3<=0){const vv=d1/(d1-d3);return(apx-vv*abx)**2+(apy-vv*aby)**2+(apz-vv*abz)**2;}
  const vb=d5*d2-d1*d6; if(vb<=0&&d2>=0&&d6<=0){const ww=d2/(d2-d6);return(apx-ww*acx)**2+(apy-ww*acy)**2+(apz-ww*acz)**2;}
  const va=d3*d6-d5*d4; if(va<=0&&(d4-d3)>=0&&(d5-d6)>=0){const ww=(d4-d3)/((d4-d3)+(d5-d6));const rx=bpx+ww*(cx-bx),ry=bpy+ww*(cy-by),rz=bpz+ww*(cz-bz);return rx*rx+ry*ry+rz*rz;}
  const denom=1/(va+vb+vc);const vv=vb*denom,ww=vc*denom;
  const rx=apx-(vv*abx+ww*acx),ry=apy-(vv*aby+ww*acy),rz=apz-(vv*abz+ww*acz);
  return rx*rx+ry*ry+rz*rz;
}

function surfaceVoxelize(
  triPos:Float32Array, bbox:THREE.Box3,
  gridX:number, gridY:number, gridZ:number, voxelSize:number, gapRatio:number
): Voxel[] {
  const triCount = triPos.length / 9;
  const threshold = (voxelSize * Math.sqrt(3) / 2) ** 2;
  const grid = new Map<number, [number,number,number]>(); // flat index → accumulated normal

  for (let ti = 0; ti < triCount; ti++) {
    const b = ti * 9;
    const ax=triPos[b],ay=triPos[b+1],az=triPos[b+2];
    const bx=triPos[b+3],by=triPos[b+4],bz=triPos[b+5];
    const cx=triPos[b+6],cy=triPos[b+7],cz=triPos[b+8];

    // Face normal
    const e1x=bx-ax,e1y=by-ay,e1z=bz-az, e2x=cx-ax,e2y=cy-ay,e2z=cz-az;
    const nx=e1y*e2z-e1z*e2y, ny=e1z*e2x-e1x*e2z, nz=e1x*e2y-e1y*e2x;
    const nl=Math.sqrt(nx*nx+ny*ny+nz*nz)||1;

    // AABB of triangle in grid space
    const x0=Math.max(0,Math.floor((Math.min(ax,bx,cx)-bbox.min.x)/voxelSize)-1);
    const x1=Math.min(gridX-1,Math.ceil((Math.max(ax,bx,cx)-bbox.min.x)/voxelSize)+1);
    const y0=Math.max(0,Math.floor((Math.min(ay,by,cy)-bbox.min.y)/voxelSize)-1);
    const y1=Math.min(gridY-1,Math.ceil((Math.max(ay,by,cy)-bbox.min.y)/voxelSize)+1);
    const z0=Math.max(0,Math.floor((Math.min(az,bz,cz)-bbox.min.z)/voxelSize)-1);
    const z1=Math.min(gridZ-1,Math.ceil((Math.max(az,bz,cz)-bbox.min.z)/voxelSize)+1);

    for (let gz=z0;gz<=z1;gz++) for (let gy=y0;gy<=y1;gy++) for (let gx=x0;gx<=x1;gx++) {
      const pcx=bbox.min.x+(gx+.5)*voxelSize;
      const pcy=bbox.min.y+(gy+.5)*voxelSize;
      const pcz=bbox.min.z+(gz+.5)*voxelSize;
      if (closestDistToTriSq(pcx,pcy,pcz,ax,ay,az,bx,by,bz,cx,cy,cz) <= threshold) {
        const key = gz*gridY*gridX + gy*gridX + gx;
        const existing = grid.get(key);
        if (existing) { existing[0]+=nx/nl; existing[1]+=ny/nl; existing[2]+=nz/nl; }
        else grid.set(key, [nx/nl, ny/nl, nz/nl]);
      }
    }
  }

  const voxels: Voxel[] = [];
  const sizeZ = bbox.max.z - bbox.min.z;

  for (const [key, n] of grid.entries()) {
    const gz=Math.floor(key/(gridY*gridX)), rem=key%(gridY*gridX);
    const gy=Math.floor(rem/gridX), gx=rem%gridX;
    const posX=bbox.min.x+(gx+.5)*voxelSize;
    const posY=bbox.min.y+(gy+.5)*voxelSize;
    const posZ=bbox.min.z+(gz+.5)*voxelSize;
    const nl=Math.sqrt(n[0]**2+n[1]**2+n[2]**2)||1;
    const norm:[number,number,number]=[n[0]/nl,n[1]/nl,n[2]/nl];
    voxels.push({
      position:[posX,posY,posZ],
      normal: norm,
      color: [(norm[0]+1)/2,(norm[1]+1)/2,(norm[2]+1)/2],
      size: voxelSize*(1-gapRatio),
      z_height: posZ,
      rotation: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      curvature: 0,
    });
  }
  return voxels;
}

// ─── MAIN VOXELIZATION ────────────────────────────────────────────────────────

interface VoxelizeOptions {
  surface?: boolean;
  interior?: boolean;
  /** Tilt voxels to follow surface normal; size auto-fits cell to avoid overlap */
  curvedVoxels?: boolean;
}

export function voxelizeGeometry(
  geometry: THREE.BufferGeometry,
  targetBlocks: number,
  blockSizeMul: number,
  gapRatio: number,
  options: VoxelizeOptions = {}
): Voxel[] {
  const { surface = true, interior = true } = options;
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!;

  const sizeX = bbox.max.x - bbox.min.x;
  const sizeY = bbox.max.y - bbox.min.y;
  const sizeZ = bbox.max.z - bbox.min.z;
  const maxDim = Math.max(sizeX, sizeY, sizeZ);
  if (maxDim === 0) return [];

  const baseVoxelSize = (maxDim / Math.cbrt(targetBlocks)) * blockSizeMul;
  const gridX = Math.max(1, Math.ceil(sizeX / baseVoxelSize));
  const gridY = Math.max(1, Math.ceil(sizeY / baseVoxelSize));
  const gridZ = Math.max(1, Math.ceil(sizeZ / baseVoxelSize));

  const triData = extractTriangles(geometry);
  const { positions, colors, normals, indices } = triData;
  const triCount = Math.floor(indices.length / 3);
  if (triCount === 0) return [];

  // Build triangle data with positions, colors, and normals
  const triPosData: number[] = [];
  const triColorData: number[] = [];
  const triNormalData: number[] = [];
  const triCurvature: number[] = [];

  for (let i = 0; i < triCount; i++) {
    const i0 = indices[i*3], i1 = indices[i*3+1], i2 = indices[i*3+2];

    // Positions
    triPosData.push(
      positions[i0*3], positions[i0*3+1], positions[i0*3+2],
      positions[i1*3], positions[i1*3+1], positions[i1*3+2],
      positions[i2*3], positions[i2*3+1], positions[i2*3+2]
    );

    // Colors
    triColorData.push(
      colors[i0*3], colors[i0*3+1], colors[i0*3+2],
      colors[i1*3], colors[i1*3+1], colors[i1*3+2],
      colors[i2*3], colors[i2*3+1], colors[i2*3+2]
    );

    // Normals
    triNormalData.push(
      normals[i0*3], normals[i0*3+1], normals[i0*3+2],
      normals[i1*3], normals[i1*3+1], normals[i1*3+2],
      normals[i2*3], normals[i2*3+1], normals[i2*3+2]
    );

    // Curvature
    // Temporarily disable adaptive sizing to test base algorithm
    const curv = 0; // calculateCurvature(...);
    triCurvature.push(curv, curv, curv);
  }

  // Adaptive voxel size map based on curvature
  const voxelSizeMap = new Float32Array(gridX * gridY * gridZ);
  voxelSizeMap.fill(baseVoxelSize);

  // Mark surface voxels and calculate adaptive sizes
  const surfaceVoxels = new Set<number>();
  const voxelColors = new Map<number, [number,number,number]>();
  // Increased threshold to catch more surface details
  const SURFACE_THRESHOLD_SQ = ((baseVoxelSize * 0.866) ** 2);  // sqrt(3)/2 * voxelSize

  for (let ti = 0; ti < triCount; ti++) {
    const b = ti * 9;
    const ax=triPosData[b],ay=triPosData[b+1],az=triPosData[b+2];
    const bx=triPosData[b+3],by=triPosData[b+4],bz=triPosData[b+5];
    const cx=triPosData[b+6],cy=triPosData[b+7],cz=triPosData[b+8];

    // Disable adaptive sizing for testing
    const adaptiveSize = baseVoxelSize; // * (0.5 + 1.5 * Math.min(1, curv));

    const x0=Math.max(0,Math.floor((Math.min(ax,bx,cx)-bbox.min.x)/baseVoxelSize)-1);
    const x1=Math.min(gridX-1,Math.ceil((Math.max(ax,bx,cx)-bbox.min.x)/baseVoxelSize)+1);
    const y0=Math.max(0,Math.floor((Math.min(ay,by,cy)-bbox.min.y)/baseVoxelSize)-1);
    const y1=Math.min(gridY-1,Math.ceil((Math.max(ay,by,cy)-bbox.min.y)/baseVoxelSize)+1);
    const z0=Math.max(0,Math.floor((Math.min(az,bz,cz)-bbox.min.z)/baseVoxelSize)-1);
    const z1=Math.min(gridZ-1,Math.ceil((Math.max(az,bz,cz)-bbox.min.z)/baseVoxelSize)+1);

    for (let gz=z0;gz<=z1;gz++) {
      for (let gy=y0;gy<=y1;gy++) {
        for (let gx=x0;gx<=x1;gx++) {
          const cx_pos=bbox.min.x+(gx+.5)*baseVoxelSize;
          const cy_pos=bbox.min.y+(gy+.5)*baseVoxelSize;
          const cz_pos=bbox.min.z+(gz+.5)*baseVoxelSize;

          const distSq = closestDistToTriSq(cx_pos,cy_pos,cz_pos,ax,ay,az,bx,by,bz,cx,cy,cz);
          if (distSq <= SURFACE_THRESHOLD_SQ) {
            const idx = gz*gridY*gridX + gy*gridX + gx;
            surfaceVoxels.add(idx);
            voxelSizeMap[idx] = Math.min(voxelSizeMap[idx], adaptiveSize);

            if (!voxelColors.has(idx)) {
              const r = (triColorData[b] + triColorData[b + 3] + triColorData[b + 6]) / 3;
              const g = (triColorData[b + 1] + triColorData[b + 4] + triColorData[b + 7]) / 3;
              const bl = (triColorData[b + 2] + triColorData[b + 5] + triColorData[b + 8]) / 3;
              voxelColors.set(idx, [r, g, bl]);
            }
          }
        }
      }
    }
  }

  // Grid: 0=empty, 1=surface, 2=interior
  const grid = new Uint8Array(gridX * gridY * gridZ);

  // ── Step 1: Mark surface voxels ────────────────────────────────────────
  if (surface) {
    for (const idx of surfaceVoxels) {
      grid[idx] = 1;
    }
  }

  // ── Step 2: Interior fill via majority-voting raycast ────────────────────
  // For each grid point: cast rays in 3 directions, vote by parity rule
  if (interior) {
    const PERTURB = 0.000113 * baseVoxelSize;

    for (let gz = 0; gz < gridZ; gz++) {
      for (let gy = 0; gy < gridY; gy++) {
        for (let gx = 0; gx < gridX; gx++) {
          const idx = gz * gridY * gridX + gy * gridX + gx;
          if (grid[idx]) continue; // skip surface/filled voxels

          const cx = bbox.min.x + (gx + 0.5) * baseVoxelSize;
          const cy = bbox.min.y + (gy + 0.5) * baseVoxelSize;
          const cz = bbox.min.z + (gz + 0.5) * baseVoxelSize;

          // Apply small perturbation to avoid numerical issues
          const px = cx + PERTURB;
          const py = cy + PERTURB;
          const pz = cz + PERTURB;

          // Cast rays in 3 directions and count intersections
          const voteX = countRayIntersections(px, py, pz, 'x', triPosData, triCount, bbox, baseVoxelSize);
          const voteY = countRayIntersections(px, py, pz, 'y', triPosData, triCount, bbox, baseVoxelSize);
          const voteZ = countRayIntersections(px, py, pz, 'z', triPosData, triCount, bbox, baseVoxelSize);

          // Majority voting: at least 2/3 rays must say "inside"
          const insideCount = [voteX, voteY, voteZ].filter(v => v).length;
          if (insideCount >= 2) {
            grid[idx] = 2;
          }
        }
      }
    }
  }

  // ── Step 3: Build output with adaptive sizes and real colors ────────────
  const voxels: Voxel[] = [];
  for (let gz = 0; gz < gridZ; gz++) {
    for (let gy = 0; gy < gridY; gy++) {
      for (let gx = 0; gx < gridX; gx++) {
        const idx = gz * gridY * gridX + gy * gridX + gx;
        const state = grid[idx];
        if (state === 0) continue; // empty

        const posX = bbox.min.x + (gx + .5) * baseVoxelSize;
        const posY = bbox.min.y + (gy + .5) * baseVoxelSize;
        const posZ = bbox.min.z + (gz + .5) * baseVoxelSize;

        // Use uniform size for now (adaptive disabled for testing)
        const displaySize = baseVoxelSize * (1 - gapRatio);

        // Get sampled color or use position-based fallback
        let color: [number, number, number];
        if (voxelColors.has(idx)) {
          const col = voxelColors.get(idx)!;
          color = [Math.max(0.3, col[0]), Math.max(0.3, col[1]), Math.max(0.3, col[2])];
        } else {
          color = [0.8, 0.8, 0.8];
        }

        voxels.push({
          position: [posX, posY, posZ],
          normal:   [0, 1, 0],
          color,
          size:     displaySize,
          z_height: posZ,
          rotation: [0, 0, 0],
          quaternion: [0, 0, 0, 1],
          curvature: 0,
        });
      }
    }
  }
  return voxels;
}

/**
 * Flatten buffer attribute to N×3 floats (XYZ or RGB).
 * Handles interleaved buffers and COLOR accessors with itemSize 4 (drops alpha).
 */
function flattenAttributeVec3(geometry: THREE.BufferGeometry, name: string): Float32Array | null {
  const attr = geometry.getAttribute(name);
  if (!attr) return null;
  const n = attr.count;
  const out = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(attr, i);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  return out;
}

export async function voxelizeGeometryAsync(
  geometry: THREE.BufferGeometry,
  targetBlocks: number,
  blockSizeMul: number,
  gapRatio: number,
  options: VoxelizeOptions = {},
  onProgress?: (progress: number) => void
): Promise<Voxel[]> {
  return new Promise((resolve, reject) => {
    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox!;

    const posFlat = flattenAttributeVec3(geometry, 'position');
    if (!posFlat || posFlat.length < 9) {
      reject(new Error('Geometry has no valid position attribute'));
      return;
    }

    const idx = geometry.getIndex();
    let indices: ArrayLike<number>;

    if (idx?.array && (idx.array as ArrayLike<number>).length > 0) {
      indices = idx.array as ArrayLike<number>;
    } else {
      const seq = new Uint32Array(posFlat.length / 3);
      for (let i = 0; i < seq.length; i++) seq[i] = i;
      indices = seq;
    }

    try {
      const worker = new Worker(new URL('./voxelizer.worker.ts', import.meta.url), { type: 'module' });

      const timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error('Voxelization timeout - model too complex or too many voxels'));
      }, 300000);  // 5 minutes timeout

      worker.onmessage = (event: MessageEvent<any>) => {
        if (event.data.type === 'progress') {
          onProgress?.(event.data.value);
        } else if (event.data.type === 'complete') {
          clearTimeout(timeout);
          worker.terminate();
          const raw = event.data?.voxels;
          resolve(Array.isArray(raw) ? raw : []);
        }
      };

      worker.onerror = (error: ErrorEvent) => {
        clearTimeout(timeout);
        worker.terminate();
        reject(new Error(`Worker error: ${error.message}`));
      };

      const { surface = true, interior = true, curvedVoxels = true } = options;

      const colorFlat = flattenAttributeVec3(geometry, 'color');
      const normalFlat = flattenAttributeVec3(geometry, 'normal');

      const positionsCloned = new Float32Array(posFlat);
      const bboxMin: [number, number, number] = [bbox.min.x, bbox.min.y, bbox.min.z];
      const bboxMax: [number, number, number] = [bbox.max.x, bbox.max.y, bbox.max.z];

      let colorsForWorker: Float32Array;
      if (colorFlat && colorFlat.length === posFlat.length) {
        let energy = 0;
        const cap = Math.min(colorFlat.length, 9000);
        for (let i = 0; i < cap; i++) energy += Math.abs(colorFlat[i]);
        if (energy < 1e-5) {
          colorsForWorker = buildPreviewVertexColors(positionsCloned, bboxMin, bboxMax, null);
        } else {
          colorsForWorker = colorFlat;
        }
      } else {
        colorsForWorker = buildPreviewVertexColors(positionsCloned, bboxMin, bboxMax, null);
      }

      // Clone buffers to avoid detached ArrayBuffer errors on multiple calls
      const indicesCloned = new Uint32Array(indices as ArrayLike<number>);
      const colorsCloned = new Float32Array(colorsForWorker);
      const normalsCloned = new Float32Array(
        normalFlat && normalFlat.length === posFlat.length
          ? normalFlat
          : new Float32Array(posFlat.length),
      );

      // Get transferable buffers from cloned data
      const positionsBuffer = positionsCloned.buffer;
      const indicesBuffer = indicesCloned.buffer;
      const colorsBuffer = colorsCloned.buffer;
      const normalsBuffer = normalsCloned.buffer;

      worker.postMessage({
        geometry: {
          positions: positionsCloned,
          indices: indicesCloned,
          colors: colorsCloned,
          normals: normalsCloned,
          bbox: {
            min: [bbox.min.x, bbox.min.y, bbox.min.z],
            max: [bbox.max.x, bbox.max.y, bbox.max.z],
          },
        },
        params: {
          targetBlocks,
          blockSizeMul,
          gapRatio,
          surface,
          interior,
          curvedVoxels,
        },
      }, [positionsBuffer, indicesBuffer, colorsBuffer, normalsBuffer]);
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Failed to create worker'));
    }
  });
}
