// Web Worker for model parsing (GLB/OBJ/STL)
// Prevents UI freeze when parsing large files

interface ParseMessage {
  fileData: ArrayBuffer;
  fileName: string;
}

interface ParseResult {
  positions: number[];
  indices: number[];
  colors: number[];
  normals: number[];
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

// No EPSILON needed in parser worker

function readFloats(binData: Uint8Array, accessor: any, bufferViews: any[]): Float32Array {
  const bv = bufferViews[accessor.bufferView];
  const bvOffset = bv.byteOffset ?? 0;
  const accOffset = accessor.byteOffset ?? 0;
  const stride = bv.byteStride ?? 0;
  const components = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[accessor.type] ?? 1;
  const count = accessor.count;
  const out = new Float32Array(count * components);
  const dv = new DataView(binData.buffer, binData.byteOffset + bvOffset);
  const elemBytes = accessor.componentType === 5123 ? 2 : 4;
  const effectiveStride = stride || components * elemBytes;

  for (let i = 0; i < count; i++) {
    for (let j = 0; j < components; j++) {
      const pos = accOffset + i * effectiveStride + j * elemBytes;
      if (accessor.componentType === 5126) {
        out[i * components + j] = dv.getFloat32(pos, true);
      } else if (accessor.componentType === 5125) {
        out[i * components + j] = dv.getUint32(pos, true);
      } else if (accessor.componentType === 5123) {
        out[i * components + j] = dv.getUint16(pos, true);
      }
    }
  }
  return out;
}

function readIndices(binData: Uint8Array, accessor: any, bufferViews: any[]): Uint32Array {
  const bv = bufferViews[accessor.bufferView];
  const base = (bv.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const n = accessor.count;
  const out = new Uint32Array(n);
  const dv = new DataView(binData.buffer, binData.byteOffset + base);

  for (let i = 0; i < n; i++) {
    out[i] = accessor.componentType === 5125 ? dv.getUint32(i * 4, true) : dv.getUint16(i * 2, true);
  }
  return out;
}

function parseGLB(data: Uint8Array): ParseResult {
  const view = new DataView(data.buffer, data.byteOffset);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('Invalid GLB file');

  const fileLength = view.getUint32(8, true);
  let offset = 12;
  let json: any = null;
  let binData: Uint8Array | null = null;

  while (offset < fileLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    offset += 8;

    if (chunkType === 0x4e4f534a) {
      json = JSON.parse(new TextDecoder().decode(data.subarray(offset, offset + chunkLength)));
      offset += chunkLength;
    } else if (chunkType === 0x004e4942) {
      binData = data.slice(offset, offset + chunkLength);
      break;
    } else {
      offset += chunkLength;
    }
  }

  if (!json || !binData) throw new Error('Invalid GLB structure');

  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  const normals: number[] = [];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  const { accessors, bufferViews } = json;

  for (const mesh of json.meshes || []) {
    for (const prim of mesh.primitives || []) {
      if (prim.attributes?.POSITION === undefined) continue;

      const pos = readFloats(binData, accessors[prim.attributes.POSITION], bufferViews);
      for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i], y = pos[i + 1], z = pos[i + 2];
        positions.push(x, y, z);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        maxZ = Math.max(maxZ, z);
      }

      if (prim.attributes?.COLOR_0 !== undefined) {
        const col = readFloats(binData, accessors[prim.attributes.COLOR_0], bufferViews);
        colors.push(...Array.from(col));
      } else {
        colors.push(...new Array(pos.length).fill(1));
      }

      if (prim.attributes?.NORMAL !== undefined) {
        const norm = readFloats(binData, accessors[prim.attributes.NORMAL], bufferViews);
        normals.push(...Array.from(norm));
      } else {
        normals.push(...new Array(pos.length).fill(0));
      }

      if (prim.indices !== undefined) {
        const idx = readIndices(binData, accessors[prim.indices], bufferViews);
        indices.push(...Array.from(idx));
      } else {
        for (let i = 0; i < pos.length / 3; i++) indices.push(i);
      }
    }
  }

  return {
    positions,
    indices,
    colors,
    normals,
    bbox: {
      min: [minX === Infinity ? 0 : minX, minY === Infinity ? 0 : minY, minZ === Infinity ? 0 : minZ],
      max: [maxX === -Infinity ? 1 : maxX, maxY === -Infinity ? 1 : maxY, maxZ === -Infinity ? 1 : maxZ],
    },
  };
}

function parseOBJ(text: string): ParseResult {
  const vertices: [number, number, number][] = [];
  const vNormals: [number, number, number][] = [];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const line of text.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'v' && p.length >= 4) {
      const x = +p[1], y = +p[2], z = +p[3];
      vertices.push([x, y, z]);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    }
    if (p[0] === 'vn' && p.length >= 4) vNormals.push([+p[1], +p[2], +p[3]]);
    if (p[0] === 'f' && p.length >= 4) {
      for (let i = 1; i <= p.length - 2; i++) {
        for (const idx of [p[1], p[i + 1], p[i + 2]]) {
          if (!idx) continue;
          const parts = idx.split('/');
          const vi = parseInt(parts[0]) - 1;
          const ni = parts[2] ? parseInt(parts[2]) - 1 : -1;
          if (vi >= 0 && vi < vertices.length) {
            const [x, y, z] = vertices[vi];
            positions.push(x, y, z);
            indices.push(indices.length / 3);
            if (ni >= 0 && ni < vNormals.length) {
              const [nx, ny, nz] = vNormals[ni];
              normals.push(nx, ny, nz);
            } else {
              normals.push(0, 0, 0);
            }
          }
        }
      }
    }
  }

  return {
    positions,
    indices,
    colors: new Array(positions.length).fill(1),
    normals,
    bbox: {
      min: [minX === Infinity ? 0 : minX, minY === Infinity ? 0 : minY, minZ === Infinity ? 0 : minZ],
      max: [maxX === -Infinity ? 1 : maxX, maxY === -Infinity ? 1 : maxY, maxZ === -Infinity ? 1 : maxZ],
    },
  };
}

function parseSTL(data: Uint8Array): ParseResult {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const view = new DataView(data.buffer, data.byteOffset);
  const triCount = view.getUint32(80, true);
  let off = 84;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < triCount && off + 50 <= data.length; i++) {
    const nx = view.getFloat32(off, true), ny = view.getFloat32(off + 4, true), nz = view.getFloat32(off + 8, true);
    off += 12;
    for (let j = 0; j < 3; j++) {
      const x = view.getFloat32(off, true), y = view.getFloat32(off + 4, true), z = view.getFloat32(off + 8, true);
      positions.push(x, y, z);
      indices.push(positions.length / 3 - 1);
      normals.push(nx, ny, nz);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
      off += 12;
    }
    off += 2;
  }

  return {
    positions,
    indices,
    colors: new Array(positions.length).fill(1),
    normals,
    bbox: {
      min: [minX === Infinity ? 0 : minX, minY === Infinity ? 0 : minY, minZ === Infinity ? 0 : minZ],
      max: [maxX === -Infinity ? 1 : maxX, maxY === -Infinity ? 1 : maxY, maxZ === -Infinity ? 1 : maxZ],
    },
  };
}

self.onmessage = (event: MessageEvent<ParseMessage>) => {
  const { fileData, fileName } = event.data;
  const uint8 = new Uint8Array(fileData);
  const ext = fileName.toLowerCase();

  try {
    let result: ParseResult;

    if (ext.endsWith('.glb') || ext.endsWith('.gltf')) {
      result = parseGLB(uint8);
    } else if (ext.endsWith('.obj')) {
      result = parseOBJ(new TextDecoder().decode(uint8));
    } else if (ext.endsWith('.stl')) {
      result = parseSTL(uint8);
    } else {
      throw new Error('Unsupported file format');
    }

    self.postMessage({ success: true, result });
  } catch (error) {
    self.postMessage({ success: false, error: error instanceof Error ? error.message : 'Parse failed' });
  }
};
