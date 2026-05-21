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

export interface ParsedModel {
  geometry: THREE.BufferGeometry;
  surfaceColor: string;
}

const EPSILON = 1e-8;

// Map glTF componentType codes to byte sizes
function getComponentTypeSize(componentType: number): number {
  switch (componentType) {
    case 5120: // BYTE
    case 5121: // UNSIGNED_BYTE
      return 1;
    case 5122: // SHORT
    case 5123: // UNSIGNED_SHORT
      return 2;
    case 5125: // UNSIGNED_INT
    case 5126: // FLOAT
      return 4;
    default:
      console.warn(`Unknown componentType: ${componentType}, assuming 4 bytes`);
      return 4;
  }
}

// Extract dominant surface color from glTF JSON materials
function extractDominantSurfaceColor(json: any): string {
  if (!json.materials?.length) return '#cccccc';

  const material = json.materials[0];

  // Try baseColorFactor first (PBR)
  const bcf = material?.pbrMetallicRoughness?.baseColorFactor;
  if (bcf && bcf.length >= 3) {
    const r = Math.round(Math.max(0, Math.min(1, bcf[0] ?? 1)) * 255);
    const g = Math.round(Math.max(0, Math.min(1, bcf[1] ?? 1)) * 255);
    const b = Math.round(Math.max(0, Math.min(1, bcf[2] ?? 1)) * 255);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  // Fallback: direct color property
  if (material?.color && Array.isArray(material.color) && material.color.length >= 3) {
    const r = Math.round(Math.max(0, Math.min(1, material.color[0] ?? 1)) * 255);
    const g = Math.round(Math.max(0, Math.min(1, material.color[1] ?? 1)) * 255);
    const b = Math.round(Math.max(0, Math.min(1, material.color[2] ?? 1)) * 255);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  // Fallback: emissiveFactor
  if (material?.emissiveFactor && Array.isArray(material.emissiveFactor) && material.emissiveFactor.length >= 3) {
    const r = Math.round(Math.max(0, Math.min(1, material.emissiveFactor[0] ?? 1)) * 255);
    const g = Math.round(Math.max(0, Math.min(1, material.emissiveFactor[1] ?? 1)) * 255);
    const b = Math.round(Math.max(0, Math.min(1, material.emissiveFactor[2] ?? 1)) * 255);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  return '#cccccc';
}

// ─── FILE PARSERS ─────────────────────────────────────────────────────────────

export async function parseModelFile(file: File): Promise<ParsedModel> {
  const arrayBuffer = await file.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);
  const ext = file.name.toLowerCase();

  let result: ParsedModel;

  if (ext.endsWith('.glb') || ext.endsWith('.gltf')) {
    result = await parseGLB(uint8);
  } else if (ext.endsWith('.obj')) {
    result = { geometry: parseOBJ(new TextDecoder().decode(uint8)), surfaceColor: '#cccccc' };
  } else if (ext.endsWith('.stl')) {
    result = { geometry: parseSTL(uint8), surfaceColor: '#cccccc' };
  } else if (ext.endsWith('.fbx')) {
    result = await parseFBX(arrayBuffer);
  } else {
    throw new Error('Unsupported file format');
  }

  return result;
}

async function parseFBX(data: ArrayBuffer): Promise<ParsedModel> {
  const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
  const loader = new FBXLoader();
  const group = loader.parse(data, '');

  const allPositions: number[] = [];
  const allColors: number[] = [];
  const allIndices: number[] = [];
  let vertexOffset = 0;
  const v = new THREE.Vector3();

  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !child.geometry) return;
    const geo = child.geometry as THREE.BufferGeometry;
    const posAttr = geo.getAttribute('position');
    if (!posAttr || posAttr.count === 0) return;

    child.updateWorldMatrix(true, false);
    const m = child.matrixWorld;

    // Extract material color(s) — FBXLoader creates MeshPhong/LambertMaterial
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    const matColors: [number, number, number][] = mats.map((mat) => {
      const c = (mat as any).color as THREE.Color | undefined;
      return c ? [c.r, c.g, c.b] : [0.8, 0.8, 0.8];
    });

    // Groups map face indices to material slots
    const groups = geo.groups.length > 0 ? geo.groups : [{ start: 0, count: Infinity, materialIndex: 0 }];

    // Build per-vertex color from material, resolving via index buffer
    const idx = geo.getIndex();
    const vertexMat = new Uint8Array(posAttr.count); // materialIndex per vertex
    for (const g of groups) {
      const matIdx = g.materialIndex ?? 0;
      const end = g.start + g.count;
      if (idx) {
        for (let i = g.start; i < Math.min(end, idx.count); i++) {
          vertexMat[idx.getX(i)] = matIdx;
        }
      } else {
        for (let i = g.start; i < Math.min(end, posAttr.count); i++) {
          vertexMat[i] = matIdx;
        }
      }
    }

    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(m);
      allPositions.push(v.x, v.y, v.z);
      const [r, g, b] = matColors[Math.min(vertexMat[i], matColors.length - 1)] ?? [0.8, 0.8, 0.8];
      allColors.push(r, g, b);
    }

    if (idx) {
      for (let i = 0; i < idx.count; i++) allIndices.push(idx.getX(i) + vertexOffset);
    } else {
      for (let i = 0; i < posAttr.count; i++) allIndices.push(i + vertexOffset);
    }

    vertexOffset += posAttr.count;
  });

  if (allPositions.length === 0) throw new Error('No meshes found in FBX file');

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(allPositions, 3));
  merged.setAttribute('color', new THREE.Float32BufferAttribute(allColors, 3));
  merged.setIndex(allIndices);
  merged.computeVertexNormals();

  return { geometry: merged, surfaceColor: '#cccccc' };
}

async function parseGLB(data: Uint8Array): Promise<ParsedModel> {
  console.log('[GLB Parser] Starting GLB parse...');
  const view = new DataView(data.buffer, data.byteOffset);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('Invalid GLB file');

  const fileLength = view.getUint32(8, true);
  let offset = 12;
  let geometry: THREE.BufferGeometry | null = null;
  let surfaceColor = '#cccccc';
  let json: any = null;

  while (offset < fileLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType  = view.getUint32(offset + 4, true);
    offset += 8;

    if (chunkType === 0x4e4f534a /* JSON */) {
      json = JSON.parse(new TextDecoder().decode(data.subarray(offset, offset + chunkLength)));
      offset += chunkLength;

      // Extract surface color from materials
      surfaceColor = extractDominantSurfaceColor(json);
      console.log('[GLB Parser] Extracted surface color:', surfaceColor);

      // Find BIN chunk
      while (offset < fileLength) {
        const binLen  = view.getUint32(offset, true);
        const binType = view.getUint32(offset + 4, true);
        offset += 8;
        if (binType === 0x004e4942 /* BIN */) {
          // Pass the exact slice so byteOffset is always 0 inside helpers
          geometry = await parseGLTFMesh(json, data.slice(offset, offset + binLen));
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
  return { geometry, surfaceColor };
}

// Load and decode image data from GLB binary
async function loadImageFromGLB(json: any, binData: Uint8Array, imageIdx: number): Promise<ImageData | null> {
  try {
    const image = json.images?.[imageIdx];
    if (!image) return null;

    let imageData: Uint8Array | null = null;

    // Image data is in a bufferView
    if (image.bufferView !== undefined) {
      const bufferView = json.bufferViews?.[image.bufferView];
      if (!bufferView) return null;

      const offset = bufferView.byteOffset ?? 0;
      const length = bufferView.byteLength;
      imageData = binData.slice(offset, offset + length);
    }
    // Or image data is a data URI
    else if (image.uri && image.uri.startsWith('data:')) {
      const base64 = image.uri.split(',')[1];
      imageData = new Uint8Array(atob(base64).split('').map(c => c.charCodeAt(0)));
    }

    if (!imageData) return null;

    // Decode image using createImageBitmap
    const blob = new Blob([new Uint8Array(imageData)] as any, { type: image.mimeType || 'image/png' });
    const imageBitmap = await createImageBitmap(blob);

    // Draw to canvas to get ImageData
    // Try OffscreenCanvas first (worker-friendly), fallback to regular Canvas
    let imageResult: ImageData | null = null;

    try {
      const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
      if (ctx) {
        ctx.drawImage(imageBitmap, 0, 0);
        imageResult = ctx.getImageData(0, 0, imageBitmap.width, imageBitmap.height);
      }
    } catch (e) {
      // Fallback to regular Canvas
      const canvas = document.createElement('canvas');
      canvas.width = imageBitmap.width;
      canvas.height = imageBitmap.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(imageBitmap, 0, 0);
        imageResult = ctx.getImageData(0, 0, imageBitmap.width, imageBitmap.height);
      }
    }

    return imageResult;
  } catch (err) {
    console.error(`[Texture] Failed to load image ${imageIdx}:`, err);
    return null;
  }
}

// Sample a color from texture coordinates
function sampleTexture(imageData: ImageData | null, u: number, v: number, vertexIndex?: number): [number, number, number] {
  if (!imageData) return [1, 1, 1];

  // Clamp UV to [0, 1]
  u = Math.max(0, Math.min(1, u));
  v = Math.max(0, Math.min(1, v)); // Try without flipping first

  const x = Math.floor(u * (imageData.width - 1));
  const y = Math.floor(v * (imageData.height - 1));
  const idx = (y * imageData.width + x) * 4;

  const data = imageData.data;
  const r = (data[idx] ?? 255) / 255;
  const g = (data[idx + 1] ?? 255) / 255;
  const b = (data[idx + 2] ?? 255) / 255;

  // Log first few samples for debugging
  if (vertexIndex !== undefined && vertexIndex < 3) {
    console.log(`[Texture] Vertex ${vertexIndex}: UV=(${u.toFixed(3)}, ${v.toFixed(3)}) → PixelXY=(${x}, ${y}) → RGB=[${r.toFixed(2)}, ${g.toFixed(2)}, ${b.toFixed(2)}]`);
  }

  return [r, g, b];
}

async function parseGLTFMesh(json: any, binData: Uint8Array): Promise<THREE.BufferGeometry> {
  console.log('[GLB Parser] parseGLTFMesh called, nodes:', json.nodes?.length, 'meshes:', json.meshes?.length);
  console.log('[GLB Parser] BIN chunk size:', binData.byteLength, 'bytes');

  // Diagnostic: log all bufferViews
  if (json.bufferViews?.length) {
    console.log('[GLB Parser] BufferViews:');
    json.bufferViews.forEach((bv: any, idx: number) => {
      const offset = bv.byteOffset ?? 0;
      const length = bv.byteLength ?? '(not declared)';
      const stride = bv.byteStride ? ` stride:${bv.byteStride}` : '';
      console.log(`  [${idx}] offset:${offset}, length:${length}${stride}`);
    });
  }

  // Log high-level GLB structure
  console.log('[GLB Overview] Structure:', {
    meshes: json.meshes?.length || 0,
    materials: json.materials?.length || 0,
    textures: json.textures?.length || 0,
    images: json.images?.length || 0,
    nodes: json.nodes?.length || 0,
    accessors: json.accessors?.length || 0,
    bufferViews: json.bufferViews?.length || 0,
  });

  // List all materials briefly
  if (json.materials?.length) {
    console.log('[GLB Materials] Count:', json.materials.length);
    json.materials.forEach((mat: any, idx: number) => {
      const bcf = mat.pbrMetallicRoughness?.baseColorFactor;
      const hasTexture = !!mat.pbrMetallicRoughness?.baseColorTexture;
      const colorStr = bcf ? `[${bcf[0]?.toFixed(2)}, ${bcf[1]?.toFixed(2)}, ${bcf[2]?.toFixed(2)}]` : 'none';
      console.log(`  Material ${idx}: ${mat.name || '(unnamed)'}, baseColorFactor: ${colorStr}, hasTexture: ${hasTexture}`);
    });
  }

  const geo = new THREE.BufferGeometry();
  if (!json.meshes?.length) return geo;

  const { accessors, bufferViews } = json;
  const positions: Float32Array[] = [];
  const normals: Float32Array[] = [];
  const colors: Float32Array[] = [];
  const indices: (Uint32Array | null)[] = [];  // null if primitive has no indices
  let vertexCount = 0;
  let totalPositions = 0;

  // Debug: log transforms found
  const transformLog: string[] = [];

  // Build node transform matrix map with parent hierarchy support
  const nodeMatrices = new Map<number, number[]>();
  const accumulatedMatrices = new Map<number, number[]>();
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  if (json.nodes) {
    // First pass: build local transforms
    for (let i = 0; i < json.nodes.length; i++) {
      const node = json.nodes[i];
      const matrix = node.matrix || buildNodeMatrix(node);
      if (matrix) {
        nodeMatrices.set(i, matrix);
      } else {
        nodeMatrices.set(i, identity);
      }
    }

    // Second pass: accumulate transforms along hierarchy
    const visited = new Set<number>();
    const accumulate = (nodeIdx: number, parentMatrix: number[] = identity): number[] => {
      if (accumulatedMatrices.has(nodeIdx)) return accumulatedMatrices.get(nodeIdx)!;
      if (visited.has(nodeIdx)) {
        console.warn(`Circular reference detected in node ${nodeIdx}`);
        return parentMatrix;
      }

      visited.add(nodeIdx);
      const node = json.nodes[nodeIdx];
      const localMatrix = nodeMatrices.get(nodeIdx) || identity;
      const worldMatrix = multiplyMatrices(parentMatrix, localMatrix);
      accumulatedMatrices.set(nodeIdx, worldMatrix);

      // Recursively accumulate children
      if (node.children) {
        for (const childIdx of node.children) {
          accumulate(childIdx, worldMatrix);
        }
      }

      return worldMatrix;
    };

    // Find and accumulate from root nodes (nodes not referenced as children)
    const childSet = new Set<number>();
    for (const node of json.nodes) {
      if (node.children) {
        for (const childIdx of node.children) {
          childSet.add(childIdx);
        }
      }
    }

    for (let i = 0; i < json.nodes.length; i++) {
      if (!childSet.has(i)) {
        accumulate(i);
      }
    }

    // Ensure all nodes are processed (in case of orphaned nodes)
    for (let i = 0; i < json.nodes.length; i++) {
      if (!accumulatedMatrices.has(i)) {
        accumulatedMatrices.set(i, nodeMatrices.get(i) || identity);
      }
    }
  }

  // Build mesh-to-node mapping (which nodes use which meshes)
  const meshNodeMap = new Map<number, number[]>();
  if (json.nodes) {
    for (let nodeIdx = 0; nodeIdx < json.nodes.length; nodeIdx++) {
      const node = json.nodes[nodeIdx];
      if (node.mesh !== undefined) {
        if (!meshNodeMap.has(node.mesh)) {
          meshNodeMap.set(node.mesh, []);
        }
        meshNodeMap.get(node.mesh)!.push(nodeIdx);
        transformLog.push(`DEBUG: Node ${nodeIdx} → Mesh ${node.mesh}`);
      }
    }
  }

  transformLog.push(`DEBUG: Mesh-to-Node map: ${meshNodeMap.size} entries`);
  transformLog.push(`DEBUG: Accumulated matrices: ${accumulatedMatrices.size} entries`);

  // Merge all meshes and primitives
  for (let meshIdx = 0; meshIdx < json.meshes.length; meshIdx++) {
    const mesh = json.meshes[meshIdx];
    if (!mesh.primitives?.length) continue;

    // Get transform matrices for this mesh (if used by nodes)
    const nodeIndices = meshNodeMap.get(meshIdx) || [];
    const matrices = nodeIndices
      .map(idx => accumulatedMatrices.get(idx))
      .filter((m): m is number[] => m !== undefined);

    transformLog.push(`DEBUG: Mesh ${meshIdx}: found ${nodeIndices.length} nodes, ${matrices.length} matrices`);

    for (const prim of mesh.primitives) {
      if (prim.attributes?.POSITION === undefined) continue;

      // DEBUG: Log all attributes and material info
      const attrs = Object.keys(prim.attributes || {});
      console.log(`[GLB] Mesh ${meshIdx} Primitive:`, {
        attributes: attrs,
        hasMaterial: prim.material !== undefined,
        materialIdx: prim.material,
        materialName: prim.material !== undefined ? json.materials?.[prim.material]?.name : 'none',
      });

      // Log details for each attribute
      for (const attrName of attrs) {
        const accessorIdx = prim.attributes[attrName];
        const accessor = accessors[accessorIdx];
        if (accessor) {
          console.log(`  - ${attrName}: type=${accessor.type}, componentType=${accessor.componentType}, count=${accessor.count}`);
        }
      }

      if (prim.material !== undefined && json.materials?.[prim.material]) {
        const mat = json.materials[prim.material];
        console.log(`[GLB] Material[${prim.material}] full structure:`, JSON.stringify(mat, null, 2));

        // Extra logging for texture references
        if (mat.pbrMetallicRoughness?.baseColorTexture) {
          console.log(`  → baseColorTexture index: ${mat.pbrMetallicRoughness.baseColorTexture.index}`);
        }
        if (mat.normalTexture) {
          console.log(`  → normalTexture index: ${mat.normalTexture.index}`);
        }
      } else if (prim.material !== undefined) {
        console.warn(`[GLB] Material index ${prim.material} referenced but not found in json.materials`);
      }

      // Read positions
      let pos = readFloats(binData, accessors[prim.attributes.POSITION], bufferViews);

      // Apply transform matrices if available
      if (matrices.length > 0) {
        const nodeIdx = nodeIndices[0];
        const node = json.nodes?.[nodeIdx];
        transformLog.push(
          `✓ Mesh ${meshIdx} (Node ${nodeIdx}): applying transform ` +
          `[T: ${node?.translation || [0,0,0]}, R: ${node?.rotation || [0,0,0,1]}, S: ${node?.scale || [1,1,1]}]`
        );
        pos = applyMatrixToPositions(pos, matrices[0]);
      } else {
        transformLog.push(`✗ Mesh ${meshIdx}: NO TRANSFORM FOUND`);
      }

      positions.push(pos);
      totalPositions += pos.length;

      // Read normals if available
      if (prim.attributes?.NORMAL !== undefined) {
        let norm = readFloats(binData, accessors[prim.attributes.NORMAL], bufferViews);
        // Apply normal transformation (rotation only, no translation/scale)
        if (matrices.length > 0) {
          norm = applyMatrixToNormals(norm, matrices[0]);
        }
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
        console.log(`[Color] Mesh ${meshIdx} Prim ${prim}: baseColorFactor = [${baseColor}]`);
      }
      // Fallback: try direct color property
      else if (material?.color) {
        baseColor = [
          Math.max(0, Math.min(1, material.color[0] ?? 1)),
          Math.max(0, Math.min(1, material.color[1] ?? 1)),
          Math.max(0, Math.min(1, material.color[2] ?? 1)),
        ];
        console.log(`[Color] Mesh ${meshIdx} Prim ${prim}: material.color = [${baseColor}]`);
      }
      // Fallback: try emissive color if available
      else if (material?.emissiveFactor) {
        baseColor = [
          Math.max(0, Math.min(1, material.emissiveFactor[0] ?? 1)),
          Math.max(0, Math.min(1, material.emissiveFactor[1] ?? 1)),
          Math.max(0, Math.min(1, material.emissiveFactor[2] ?? 1)),
        ];
        console.log(`[Color] Mesh ${meshIdx} Prim ${prim}: emissiveFactor = [${baseColor}]`);
      } else {
        console.log(`[Color] Mesh ${meshIdx} Prim ${prim}: No material color found, using [1,1,1]`);
      }

      // Read vertex colors if available
      if (prim.attributes?.COLOR_0 !== undefined) {
        const col = readFloats(binData, accessors[prim.attributes.COLOR_0], bufferViews);
        const componentCount = accessors[prim.attributes.COLOR_0].type === 'VEC4' ? 4 : 3;
        const baked = new Float32Array(Math.floor(col.length / componentCount) * 3);

        console.log(`[Color] Mesh ${meshIdx} Prim ${prim}: Has vertex colors (${baked.length / 3} vertices)`);
        console.log(`[Color] Sample raw vertex colors: [${col[0]?.toFixed(2)}, ${col[1]?.toFixed(2)}, ${col[2]?.toFixed(2)}]`);

        // Extract RGB and ignore alpha
        for (let i = 0; i < baked.length; i += 3) {
          const srcIdx = i / 3 * componentCount;
          baked[i] = (col[srcIdx] ?? 1) * baseColor[0];
          baked[i + 1] = (col[srcIdx + 1] ?? 1) * baseColor[1];
          baked[i + 2] = (col[srcIdx + 2] ?? 1) * baseColor[2];
        }
        console.log(`[Color] Sample baked colors: [${baked[0]?.toFixed(2)}, ${baked[1]?.toFixed(2)}, ${baked[2]?.toFixed(2)}]`);
        colors.push(baked);
      }
      // Check for texture-based colors
      else if (material?.pbrMetallicRoughness?.baseColorTexture && prim.attributes?.TEXCOORD_0 !== undefined) {
        const textureIdx = material.pbrMetallicRoughness.baseColorTexture.index;
        const imageIdx = json.textures?.[textureIdx]?.source;

        console.log(`[Texture] Sampling texture ${textureIdx} (image ${imageIdx}) using TEXCOORD_0`);

        if (imageIdx !== undefined) {
          const imageData = await loadImageFromGLB(json, binData, imageIdx);
          if (imageData) {
            const uvs = readFloats(binData, accessors[prim.attributes.TEXCOORD_0], bufferViews);
            const vertexCount = Math.floor(uvs.length / 2);
            const baked = new Float32Array(vertexCount * 3);

            console.log(`[Texture] Loaded image ${imageIdx}, UV count: ${vertexCount}`);

            // Sample texture at each vertex's UV coordinates
            for (let i = 0; i < vertexCount; i++) {
              const u = uvs[i * 2];
              const v = uvs[i * 2 + 1];
              const [r, g, b] = sampleTexture(imageData, u, v, i);
              baked[i * 3] = r * baseColor[0];
              baked[i * 3 + 1] = g * baseColor[1];
              baked[i * 3 + 2] = b * baseColor[2];
            }

            console.log(`[Texture] Sampled ${vertexCount} vertices from texture, sample: [${baked[0]?.toFixed(2)}, ${baked[1]?.toFixed(2)}, ${baked[2]?.toFixed(2)}]`);
            colors.push(baked);
          } else {
            console.warn(`[Texture] Failed to load image, using material color`);
            const baked = new Float32Array(pos.length);
            for (let i = 0; i < baked.length; i += 3) {
              baked[i] = baseColor[0];
              baked[i + 1] = baseColor[1];
              baked[i + 2] = baseColor[2];
            }
            colors.push(baked);
          }
        } else {
          console.warn(`[Texture] Texture referenced but image index not found`);
          const baked = new Float32Array(pos.length);
          for (let i = 0; i < baked.length; i += 3) {
            baked[i] = baseColor[0];
            baked[i + 1] = baseColor[1];
            baked[i + 2] = baseColor[2];
          }
          colors.push(baked);
        }
      }
      // No vertex colors - use material color for all vertices
      else {
        const baked = new Float32Array(pos.length);
        for (let i = 0; i < baked.length; i += 3) {
          baked[i] = baseColor[0];
          baked[i + 1] = baseColor[1];
          baked[i + 2] = baseColor[2];
        }
        console.log(`[Color] Mesh ${meshIdx} Prim ${prim}: No vertex/texture colors, using material color for all ${baked.length / 3} vertices`);
        colors.push(baked);
      }

      // Read indices or create sequential ones
      if (prim.indices !== undefined) {
        const idxAccessor = accessors[prim.indices];
        console.log(`[GLB Parser] Reading indices: accessor count=${idxAccessor.count}, componentType=${idxAccessor.componentType}, bufferView=${idxAccessor.bufferView}`);
        const idx = readIndices(binData, idxAccessor, bufferViews);
        console.log(`[GLB Parser] Read ${idx.length} indices`);
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

  console.log(`[Color] Merge stage: positions=${positions.length}, colors=${colors.length}, normals=${normals.length}`);

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
  if (colors.length > 0) {
    if (colors.length === positions.length) {
      console.log(`[Color] ✓ Merging colors (length match: ${colors.length} == ${positions.length})`);
      const mergedColors = new Float32Array(totalPositions);
      let offset = 0;
      for (let i = 0; i < colors.length; i++) {
        const col = colors[i];
        if (col && col.length > 0) {
          mergedColors.set(col, offset);
        }
        offset += positions[i].length;
      }
      console.log(`[Color] Sample merged colors: [${mergedColors[0]?.toFixed(2)}, ${mergedColors[1]?.toFixed(2)}, ${mergedColors[2]?.toFixed(2)}]`);
      geo.setAttribute('color', new THREE.BufferAttribute(mergedColors, 3));
      console.log(`[Color] ✓ Color attribute set on geometry`);
    } else {
      console.warn(`[Color] ✗ Colors.length (${colors.length}) !== positions.length (${positions.length}) - COLORS NOT MERGED!`);
    }
  } else {
    console.log(`[Color] No colors to merge`);
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

  // Log transform application
  if (transformLog.length > 0) {
    console.log('=== GLB TRANSFORM APPLICATION ===');
    transformLog.forEach(log => console.log(log));
    console.log('================================');
  }

  return geo;
}

function multiplyMatrices(a: number[], b: number[]): number[] {
  const result = new Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[i * 4 + k] * b[k * 4 + j];
      }
      result[i * 4 + j] = sum;
    }
  }
  return result;
}

function buildNodeMatrix(node: any): number[] | null {
  const m = new Array(16).fill(0);
  m[0] = m[5] = m[10] = m[15] = 1;

  const t = node.translation || [0, 0, 0];
  const r = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];

  // Build TRS matrix: translate × rotate × scale
  const qx = r[0], qy = r[1], qz = r[2], qw = r[3];
  const xx = qx * qx, yy = qy * qy, zz = qz * qz;
  const xy = qx * qy, xz = qx * qz, yz = qy * qz;
  const wx = qw * qx, wy = qw * qy, wz = qw * qz;

  const rot = [
    [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
    [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
    [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)],
  ];

  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      m[i * 4 + j] = rot[i][j] * s[j];
    }
  }

  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];

  return m;
}

function applyMatrixToPositions(positions: Float32Array, matrix: number[]): Float32Array {
  const result = new Float32Array(positions.length);
  const m = matrix;

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];

    result[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    result[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    result[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }

  return result;
}

function applyMatrixToNormals(normals: Float32Array, matrix: number[]): Float32Array {
  const result = new Float32Array(normals.length);
  const m = matrix;

  // Inverse transpose of rotation/scale part (3x3 submatrix)
  const m00 = m[0], m01 = m[4], m02 = m[8];
  const m10 = m[1], m11 = m[5], m12 = m[9];
  const m20 = m[2], m21 = m[6], m22 = m[10];

  // Compute inverse transpose (simplified for TRS matrices)
  const det = m00 * (m11 * m22 - m12 * m21)
            - m01 * (m10 * m22 - m12 * m20)
            + m02 * (m10 * m21 - m11 * m20);

  const invDet = Math.abs(det) < 1e-10 ? 1 : 1 / det;

  const inv = [
    (m11 * m22 - m12 * m21) * invDet,
    (m02 * m21 - m01 * m22) * invDet,
    (m01 * m12 - m02 * m11) * invDet,
    (m12 * m20 - m10 * m22) * invDet,
    (m00 * m22 - m02 * m20) * invDet,
    (m02 * m10 - m00 * m12) * invDet,
    (m10 * m21 - m11 * m20) * invDet,
    (m01 * m20 - m00 * m21) * invDet,
    (m00 * m11 - m01 * m10) * invDet,
  ];

  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i];
    const y = normals[i + 1];
    const z = normals[i + 2];

    result[i] = inv[0] * x + inv[3] * y + inv[6] * z;
    result[i + 1] = inv[1] * x + inv[4] * y + inv[7] * z;
    result[i + 2] = inv[2] * x + inv[5] * y + inv[8] * z;

    const nl = Math.sqrt(result[i] ** 2 + result[i + 1] ** 2 + result[i + 2] ** 2) || 1;
    result[i] /= nl;
    result[i + 1] /= nl;
    result[i + 2] /= nl;
  }

  return result;
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
  const elemBytes  = getComponentTypeSize(accessor.componentType);
  const effectiveStride = stride || components * elemBytes;
  const baseOffset = bvOffset + accOffset;

  // Ensure we don't exceed buffer bounds
  if (baseOffset >= binData.byteLength) {
    console.warn(`readFloats: offset ${baseOffset} exceeds buffer length ${binData.byteLength}`);
    return out;
  }

  // Use bufferView.byteLength if available, otherwise use remaining bytes from base
  const bvByteLength = bv.byteLength ?? (binData.byteLength - bvOffset);
  const accessorByteSize = Math.max(
    (count - 1) * effectiveStride + components * elemBytes,
    0
  );

  if (accOffset + accessorByteSize > bvByteLength) {
    console.warn(
      `readFloats: accessor exceeds bufferView bounds (byteOffset: ${accOffset}, size: ${accessorByteSize}, bufferView.byteLength: ${bvByteLength})`
    );
  }

  // Create a new DataView that is scoped to the remaining data
  const remainingBytes = Math.min(bvByteLength - accOffset, binData.byteLength - baseOffset);
  const dv = new DataView(binData.buffer, binData.byteOffset + baseOffset, remainingBytes);

  for (let i = 0; i < count; i++) {
    for (let j = 0; j < components; j++) {
      const pos = i * effectiveStride + j * elemBytes;
      // Check bounds before reading
      const requiredBytes = elemBytes;
      if (pos + requiredBytes > remainingBytes) {
        out[i * components + j] = 0;
        continue;
      }

      if (accessor.componentType === 5126) {          // FLOAT
        out[i * components + j] = dv.getFloat32(pos, true);
      } else if (accessor.componentType === 5125) {   // UNSIGNED_INT
        out[i * components + j] = dv.getUint32(pos, true);
      } else if (accessor.componentType === 5123) {   // UNSIGNED_SHORT
        out[i * components + j] = dv.getUint16(pos, true);
      } else if (accessor.componentType === 5121) {   // UNSIGNED_BYTE
        out[i * components + j] = dv.getUint8(pos) / 255;
      } else if (accessor.componentType === 5120) {   // BYTE
        out[i * components + j] = Math.max(-1, dv.getInt8(pos) / 127);
      }
    }
  }
  return out;
}

function readIndices(binData: Uint8Array, accessor: any, bufferViews: any[]): Uint32Array {
  const bv         = bufferViews[accessor.bufferView];
  const bvOffset   = bv.byteOffset ?? 0;
  const accOffset  = accessor.byteOffset ?? 0;
  const base       = bvOffset + accOffset;
  const n          = accessor.count;
  const out        = new Uint32Array(n);
  const elemSize   = getComponentTypeSize(accessor.componentType);

  // Ensure we don't exceed buffer bounds
  if (base >= binData.byteLength) {
    console.warn(`readIndices: offset ${base} exceeds buffer length ${binData.byteLength}`);
    return out;
  }

  // Use bufferView.byteLength if available, otherwise use remaining bytes from buffer start
  const bvByteLength = bv.byteLength ?? (binData.byteLength - bvOffset);
  const requiredSize = n * elemSize;

  if (accOffset + requiredSize > bvByteLength) {
    const shortage = accOffset + requiredSize - bvByteLength;
    console.warn(
      `readIndices: accessor exceeds bufferView bounds (count: ${n}, elemSize: ${elemSize}, required: ${requiredSize}, byteOffset: ${accOffset}, bufferView.byteLength: ${bvByteLength}, shortage: ${shortage} bytes)`
    );
  }

  // Take the minimum of available bytes in bufferView and remaining buffer space
  const remainingBytes = Math.min(bvByteLength - accOffset, binData.byteLength - base);
  const dv = new DataView(binData.buffer, binData.byteOffset + base, remainingBytes);

  let successCount = 0;
  for (let i = 0; i < n; i++) {
    const pos = i * elemSize;
    // Check bounds before reading
    if (pos + elemSize > remainingBytes) {
      out[i] = 0;
      continue;
    }
    successCount++;

    // Read based on component type
    if (accessor.componentType === 5125) {        // UNSIGNED_INT
      out[i] = dv.getUint32(pos, true);
    } else if (accessor.componentType === 5123) { // UNSIGNED_SHORT
      out[i] = dv.getUint16(pos, true);
    } else if (accessor.componentType === 5121) { // UNSIGNED_BYTE
      out[i] = dv.getUint8(pos);
    } else if (accessor.componentType === 5120) { // BYTE (sign-extend)
      out[i] = dv.getInt8(pos);
    } else {
      out[i] = dv.getUint16(pos, true); // fallback to UNSIGNED_SHORT
    }
  }

  if (successCount < n) {
    console.warn(
      `readIndices: read ${successCount}/${n} indices (${n - successCount} failed due to buffer bounds)`
    );
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
  gridX:number, gridY:number, gridZ:number, voxelSize:number
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
      size: voxelSize * 0.98,
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

  const baseVoxelSize = maxDim / Math.cbrt(targetBlocks);
  const gridX = Math.max(1, Math.ceil(sizeX / baseVoxelSize));
  const gridY = Math.max(1, Math.ceil(sizeY / baseVoxelSize));
  const gridZ = Math.max(1, Math.ceil(sizeZ / baseVoxelSize));

  // Center the grid around bboxCenter (same as worker)
  const bboxCenter = [
    (bbox.min.x + bbox.max.x) * 0.5,
    (bbox.min.y + bbox.max.y) * 0.5,
    (bbox.min.z + bbox.max.z) * 0.5,
  ];
  const gridOffset = [
    bboxCenter[0] - (gridX * baseVoxelSize) * 0.5,
    bboxCenter[1] - (gridY * baseVoxelSize) * 0.5,
    bboxCenter[2] - (gridZ * baseVoxelSize) * 0.5,
  ];

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
  const SURFACE_THRESHOLD_SQ = ((baseVoxelSize * 1.5) ** 2);  // More generous threshold

  for (let ti = 0; ti < triCount; ti++) {
    const b = ti * 9;
    const ax=triPosData[b],ay=triPosData[b+1],az=triPosData[b+2];
    const bx=triPosData[b+3],by=triPosData[b+4],bz=triPosData[b+5];
    const cx=triPosData[b+6],cy=triPosData[b+7],cz=triPosData[b+8];

    // Disable adaptive sizing for testing
    const adaptiveSize = baseVoxelSize; // * (0.5 + 1.5 * Math.min(1, curv));

    const x0=Math.max(0,Math.floor((Math.min(ax,bx,cx)-gridOffset[0])/baseVoxelSize)-1);
    const x1=Math.min(gridX-1,Math.ceil((Math.max(ax,bx,cx)-gridOffset[0])/baseVoxelSize)+1);
    const y0=Math.max(0,Math.floor((Math.min(ay,by,cy)-gridOffset[1])/baseVoxelSize)-1);
    const y1=Math.min(gridY-1,Math.ceil((Math.max(ay,by,cy)-gridOffset[1])/baseVoxelSize)+1);
    const z0=Math.max(0,Math.floor((Math.min(az,bz,cz)-gridOffset[2])/baseVoxelSize)-1);
    const z1=Math.min(gridZ-1,Math.ceil((Math.max(az,bz,cz)-gridOffset[2])/baseVoxelSize)+1);

    for (let gz=z0;gz<=z1;gz++) {
      for (let gy=y0;gy<=y1;gy++) {
        for (let gx=x0;gx<=x1;gx++) {
          // Calculate from center outward to avoid floating point accumulation bias
          const cx_pos=bboxCenter[0] + (gx - gridX*0.5 + 0.5)*baseVoxelSize;
          const cy_pos=bboxCenter[1] + (gy - gridY*0.5 + 0.5)*baseVoxelSize;
          const cz_pos=bboxCenter[2] + (gz - gridZ*0.5 + 0.5)*baseVoxelSize;

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
    for (let gz = 0; gz < gridZ; gz++) {
      for (let gy = 0; gy < gridY; gy++) {
        for (let gx = 0; gx < gridX; gx++) {
          const idx = gz * gridY * gridX + gy * gridX + gx;
          if (grid[idx]) continue; // skip surface/filled voxels

          // Calculate from center outward to avoid floating point accumulation bias
          const cx = bboxCenter[0] + (gx - gridX*0.5 + 0.5)*baseVoxelSize;
          const cy = bboxCenter[1] + (gy - gridY*0.5 + 0.5)*baseVoxelSize;
          const cz = bboxCenter[2] + (gz - gridZ*0.5 + 0.5)*baseVoxelSize;

          // Cast rays in 3 directions from voxel center (no perturbation bias)
          const voteX = countRayIntersections(cx, cy, cz, 'x', triPosData, triCount, bbox, baseVoxelSize);
          const voteY = countRayIntersections(cx, cy, cz, 'y', triPosData, triCount, bbox, baseVoxelSize);
          const voteZ = countRayIntersections(cx, cy, cz, 'z', triPosData, triCount, bbox, baseVoxelSize);

          // Relaxed voting: at least 1/3 rays says "inside" (previously 2/3)
          const insideCount = [voteX, voteY, voteZ].filter(v => v).length;
          if (insideCount >= 1) {
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

        // Calculate from center outward to avoid floating point accumulation bias
        const posX = bboxCenter[0] + (gx - gridX*0.5 + 0.5)*baseVoxelSize;
        const posY = bboxCenter[1] + (gy - gridY*0.5 + 0.5)*baseVoxelSize;
        const posZ = bboxCenter[2] + (gz - gridZ*0.5 + 0.5)*baseVoxelSize;

        // Use uniform size for now (adaptive disabled for testing)
        const displaySize = baseVoxelSize * 0.98;

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
