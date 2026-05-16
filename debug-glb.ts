import * as THREE from 'three';
import { parseModelFile } from '@/lib/voxelizer';

/**
 * Debug script to inspect GLB parsing structure
 * Run this in browser console after uploading a GLB file
 */
export async function debugGLBImport(file: File) {
  console.log('=== GLB Debug Info ===');
  console.log('File:', file.name, `(${(file.size / 1024).toFixed(2)} KB)`);

  try {
    // Parse the file manually to inspect JSON structure
    const arrayBuffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    const view = new DataView(uint8.buffer, uint8.byteOffset);

    // Parse GLB header
    const magic = view.getUint32(0, true);
    const version = view.getUint32(4, true);
    const fileLength = view.getUint32(8, true);

    console.log('Magic:', '0x' + magic.toString(16), magic === 0x46546c67 ? '✓' : '✗');
    console.log('Version:', version);
    console.log('File Length:', fileLength);

    // Find JSON chunk
    let offset = 12;
    let jsonData: any = null;
    let binData: Uint8Array | null = null;

    while (offset < fileLength) {
      const chunkLength = view.getUint32(offset, true);
      const chunkType = view.getUint32(offset + 4, true);
      offset += 8;

      if (chunkType === 0x4e4f534a) { // JSON
        jsonData = JSON.parse(new TextDecoder().decode(uint8.subarray(offset, offset + chunkLength)));
        console.log('\n--- JSON Structure ---');
        console.log('asset:', jsonData.asset);
        console.log('scene:', jsonData.scene);
        console.log('scenes:', jsonData.scenes);
        console.log('nodes count:', jsonData.nodes?.length);
        console.log('meshes count:', jsonData.meshes?.length);
        console.log('materials count:', jsonData.materials?.length);
        console.log('accessors count:', jsonData.accessors?.length);
        console.log('bufferViews count:', jsonData.bufferViews?.length);

        // Inspect each mesh
        if (jsonData.meshes) {
          console.log('\n--- Meshes Detail ---');
          jsonData.meshes.forEach((mesh: any, idx: number) => {
            console.log(`Mesh ${idx}:`, mesh.name || 'unnamed');
            if (mesh.primitives) {
              mesh.primitives.forEach((prim: any, pidx: number) => {
                console.log(`  Primitive ${pidx}:`, {
                  material: prim.material,
                  hasIndices: prim.indices !== undefined,
                  hasNormal: prim.attributes?.NORMAL !== undefined,
                  hasColor: prim.attributes?.COLOR_0 !== undefined,
                  positionAccessor: prim.attributes?.POSITION,
                });
              });
            }
          });
        }

        // Inspect nodes & transforms
        if (jsonData.nodes) {
          console.log('\n--- Nodes & Transforms ---');
          jsonData.nodes.forEach((node: any, idx: number) => {
            if (node.matrix || node.translation || node.rotation || node.scale || node.mesh !== undefined) {
              console.log(`Node ${idx}:`, {
                name: node.name,
                mesh: node.mesh,
                matrix: node.matrix,
                translation: node.translation,
                rotation: node.rotation,
                scale: node.scale,
                children: node.children,
              });
            }
          });
        }

        offset += chunkLength;
      } else if (chunkType === 0x004e4942) { // BIN
        binData = uint8.slice(offset, offset + chunkLength);
        console.log(`\nBinary chunk: ${(chunkLength / 1024).toFixed(2)} KB`);
        offset += chunkLength;
      } else {
        offset += chunkLength;
      }
    }

    // Now parse with the actual function
    const parsed = await parseModelFile(file);
    const geometry = parsed.geometry;
    const surfaceColor = parsed.surfaceColor;

    console.log('\n--- Parsed Geometry ---');
    console.log('Surface Color:', surfaceColor);
    console.log('Position count:', (geometry.getAttribute('position')?.count || 0) + ' vertices');
    console.log('Normal count:', (geometry.getAttribute('normal')?.count || 0) + ' normals');
    console.log('Color count:', (geometry.getAttribute('color')?.count || 0) + ' colors');
    console.log('Index count:', geometry.getIndex()?.count || 'none', 'indices');

    // Show bounding box
    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox!;
    console.log('Bounding Box:');
    console.log('  min:', bbox.min);
    console.log('  max:', bbox.max);
    console.log('  size:', {
      x: bbox.max.x - bbox.min.x,
      y: bbox.max.y - bbox.min.y,
      z: bbox.max.z - bbox.min.z,
    });

    return { jsonData, geometry, surfaceColor };
  } catch (error) {
    console.error('Debug error:', error);
    throw error;
  }
}
