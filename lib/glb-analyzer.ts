/**
 * Comprehensive GLB File Analyzer
 * Inspects every aspect of GLB structure to diagnose import issues
 */

export interface GLBAnalysis {
  header: {
    magic: string;
    version: number;
    fileSize: number;
    isValid: boolean;
  };
  json: {
    asset: any;
    scene: number | undefined;
    scenes: any[];
    nodes: any[];
    meshes: any[];
    materials: any[];
    accessors: any[];
    bufferViews: any[];
    buffers: any[];
    animations: any[];
  };
  meshDetails: {
    meshCount: number;
    totalPrimitives: number;
    primitiveDetails: Array<{
      meshIdx: number;
      primIdx: number;
      material: number | undefined;
      hasIndices: boolean;
      vertexCount: number;
      indexCount: number;
      hasNormals: boolean;
      hasColors: boolean;
      hasTexCoords: boolean;
    }>;
  };
  nodeHierarchy: {
    nodeCount: number;
    rootNodes: number[];
    nodeDetails: Array<{
      nodeIdx: number;
      name: string;
      hasMesh: boolean;
      meshIdx: number | undefined;
      hasTransform: boolean;
      transform: {
        hasMatrix: boolean;
        hasTranslation: boolean;
        hasRotation: boolean;
        hasScale: boolean;
        values: {
          translation: [number, number, number] | undefined;
          rotation: [number, number, number, number] | undefined;
          scale: [number, number, number] | undefined;
          matrix: number[] | undefined;
        };
      };
      children: number[];
    }>;
  };
  issues: {
    critical: string[];
    warnings: string[];
    info: string[];
  };
}

export function analyzeGLB(file: File): Promise<GLBAnalysis> {
  return file.arrayBuffer().then(buffer => {
    const uint8 = new Uint8Array(buffer);
    const view = new DataView(buffer);

    // === HEADER ===
    const magic = view.getUint32(0, true);
    const version = view.getUint32(4, true);
    const fileSize = view.getUint32(8, true);
    const isValid = magic === 0x46546c67;

    const analysis: GLBAnalysis = {
      header: {
        magic: '0x' + magic.toString(16),
        version,
        fileSize,
        isValid,
      },
      json: {
        asset: undefined,
        scene: undefined,
        scenes: [],
        nodes: [],
        meshes: [],
        materials: [],
        accessors: [],
        bufferViews: [],
        buffers: [],
        animations: [],
      },
      meshDetails: {
        meshCount: 0,
        totalPrimitives: 0,
        primitiveDetails: [],
      },
      nodeHierarchy: {
        nodeCount: 0,
        rootNodes: [],
        nodeDetails: [],
      },
      issues: {
        critical: [],
        warnings: [],
        info: [],
      },
    };

    if (!isValid) {
      analysis.issues.critical.push('Invalid GLB magic number');
      return analysis;
    }

    // === FIND JSON CHUNK ===
    let offset = 12;
    let jsonData: any = null;

    while (offset < fileSize) {
      const chunkLength = view.getUint32(offset, true);
      const chunkType = view.getUint32(offset + 4, true);
      offset += 8;

      if (chunkType === 0x4e4f534a) {
        // JSON chunk
        const jsonText = new TextDecoder().decode(uint8.subarray(offset, offset + chunkLength));
        try {
          jsonData = JSON.parse(jsonText);
        } catch (e) {
          analysis.issues.critical.push(`JSON parse error: ${e}`);
          return analysis;
        }
        break;
      }
      offset += chunkLength;
    }

    if (!jsonData) {
      analysis.issues.critical.push('No JSON chunk found');
      return analysis;
    }

    // === EXTRACT JSON DATA ===
    analysis.json.asset = jsonData.asset;
    analysis.json.scene = jsonData.scene;
    analysis.json.scenes = jsonData.scenes || [];
    analysis.json.nodes = jsonData.nodes || [];
    analysis.json.meshes = jsonData.meshes || [];
    analysis.json.materials = jsonData.materials || [];
    analysis.json.accessors = jsonData.accessors || [];
    analysis.json.bufferViews = jsonData.bufferViews || [];
    analysis.json.buffers = jsonData.buffers || [];
    analysis.json.animations = jsonData.animations || [];

    // === ANALYZE MESHES ===
    analysis.meshDetails.meshCount = jsonData.meshes?.length || 0;

    if (analysis.meshDetails.meshCount === 0) {
      analysis.issues.critical.push('No meshes found in GLB');
    } else {
      for (let meshIdx = 0; meshIdx < jsonData.meshes.length; meshIdx++) {
        const mesh = jsonData.meshes[meshIdx];
        if (!mesh.primitives) continue;

        for (let primIdx = 0; primIdx < mesh.primitives.length; primIdx++) {
          const prim = mesh.primitives[primIdx];
          const posAccessor = jsonData.accessors?.[prim.attributes?.POSITION];
          const idxAccessor = jsonData.accessors?.[prim.indices];

          analysis.meshDetails.totalPrimitives++;
          analysis.meshDetails.primitiveDetails.push({
            meshIdx,
            primIdx,
            material: prim.material,
            hasIndices: prim.indices !== undefined,
            vertexCount: posAccessor?.count || 0,
            indexCount: idxAccessor?.count || 0,
            hasNormals: prim.attributes?.NORMAL !== undefined,
            hasColors: prim.attributes?.COLOR_0 !== undefined,
            hasTexCoords: prim.attributes?.TEXCOORD_0 !== undefined,
          });
        }
      }
    }

    // === ANALYZE NODE HIERARCHY ===
    analysis.nodeHierarchy.nodeCount = jsonData.nodes?.length || 0;

    if (analysis.nodeHierarchy.nodeCount > 0) {
      // Find root nodes (not referenced as children)
      const childSet = new Set<number>();
      for (const node of jsonData.nodes) {
        if (node.children) {
          for (const childIdx of node.children) {
            childSet.add(childIdx);
          }
        }
      }

      for (let i = 0; i < jsonData.nodes.length; i++) {
        if (!childSet.has(i)) {
          analysis.nodeHierarchy.rootNodes.push(i);
        }
      }

      // Detailed node analysis
      for (let nodeIdx = 0; nodeIdx < jsonData.nodes.length; nodeIdx++) {
        const node = jsonData.nodes[nodeIdx];
        const hasMesh = node.mesh !== undefined;

        const hasTransform = !!(
          node.matrix ||
          node.translation ||
          node.rotation ||
          node.scale
        );

        const transform = {
          hasMatrix: !!node.matrix,
          hasTranslation: !!node.translation,
          hasRotation: !!node.rotation,
          hasScale: !!node.scale,
          values: {
            translation: node.translation as [number, number, number] | undefined,
            rotation: node.rotation as [number, number, number, number] | undefined,
            scale: node.scale as [number, number, number] | undefined,
            matrix: node.matrix ? (Array.from(node.matrix) as number[]) : undefined,
          },
        };

        analysis.nodeHierarchy.nodeDetails.push({
          nodeIdx,
          name: node.name || `Node_${nodeIdx}`,
          hasMesh,
          meshIdx: node.mesh,
          hasTransform,
          transform,
          children: node.children || [],
        });

        if (hasMesh && !hasTransform) {
          analysis.issues.info.push(
            `Node ${nodeIdx} (${node.name}) references mesh but has no transform`
          );
        }
      }
    }

    // === ISSUE DETECTION ===

    // Check for unused meshes
    const meshesUsedByNodes = new Set(
      jsonData.nodes?.filter((n: any) => n.mesh !== undefined).map((n: any) => n.mesh) || []
    );
    for (let i = 0; i < analysis.meshDetails.meshCount; i++) {
      if (!meshesUsedByNodes.has(i)) {
        analysis.issues.warnings.push(`Mesh ${i} is not referenced by any node`);
      }
    }

    // Check for unreferenced nodes
    if (analysis.nodeHierarchy.rootNodes.length === 0 && analysis.nodeHierarchy.nodeCount > 0) {
      analysis.issues.warnings.push('No root nodes found - possible circular reference');
    }

    // Check for meshes with no primitives
    for (let i = 0; i < jsonData.meshes.length; i++) {
      if (!jsonData.meshes[i].primitives || jsonData.meshes[i].primitives.length === 0) {
        analysis.issues.warnings.push(`Mesh ${i} has no primitives`);
      }
    }

    // Check for missing data
    if (analysis.meshDetails.totalPrimitives === 0) {
      analysis.issues.critical.push('No primitives found - empty mesh');
    }

    // Check for transforms that might scale mesh
    for (const nodeDetail of analysis.nodeHierarchy.nodeDetails) {
      if (nodeDetail.transform.values.scale) {
        const [sx, sy, sz] = nodeDetail.transform.values.scale;
        if (sx !== 1 || sy !== 1 || sz !== 1) {
          analysis.issues.info.push(
            `Node ${nodeDetail.nodeIdx} has non-uniform scale [${sx}, ${sy}, ${sz}]`
          );
        }
      }
      if (nodeDetail.transform.values.translation) {
        const [tx, ty, tz] = nodeDetail.transform.values.translation;
        if (tx !== 0 || ty !== 0 || tz !== 0) {
          analysis.issues.info.push(
            `Node ${nodeDetail.nodeIdx} has translation [${tx.toFixed(2)}, ${ty.toFixed(2)}, ${tz.toFixed(2)}]`
          );
        }
      }
    }

    return analysis;
  });
}

export function formatAnalysisReport(analysis: GLBAnalysis): string {
  let report = '';

  report += '=== GLB ANALYSIS REPORT ===\n\n';

  // Header
  report += '--- HEADER ---\n';
  report += `Magic: ${analysis.header.magic} (${analysis.header.isValid ? '✓ Valid' : '✗ Invalid'})\n`;
  report += `Version: ${analysis.header.version}\n`;
  report += `File Size: ${(analysis.header.fileSize / 1024).toFixed(2)} KB\n\n`;

  // Critical Issues
  if (analysis.issues.critical.length > 0) {
    report += '--- 🚨 CRITICAL ISSUES ---\n';
    analysis.issues.critical.forEach(issue => {
      report += `  ✗ ${issue}\n`;
    });
    report += '\n';
  }

  // Meshes
  report += '--- MESHES ---\n';
  report += `Total Meshes: ${analysis.meshDetails.meshCount}\n`;
  report += `Total Primitives: ${analysis.meshDetails.totalPrimitives}\n`;

  if (analysis.meshDetails.primitiveDetails.length > 0) {
    report += '\nPrimitive Details:\n';
    analysis.meshDetails.primitiveDetails.forEach((prim, idx) => {
      report += `  Primitive ${idx} (Mesh ${prim.meshIdx}.${prim.primIdx}):\n`;
      report += `    Vertices: ${prim.vertexCount}\n`;
      report += `    Indices: ${prim.indexCount} ${!prim.hasIndices ? '(MISSING!)' : ''}\n`;
      report += `    Normals: ${prim.hasNormals ? '✓' : '✗'}\n`;
      report += `    Colors: ${prim.hasColors ? '✓' : '✗'}\n`;
      report += `    TexCoords: ${prim.hasTexCoords ? '✓' : '✗'}\n`;
      if (prim.material !== undefined) {
        report += `    Material: ${prim.material}\n`;
      }
    });
  }
  report += '\n';

  // Nodes
  report += '--- NODES & HIERARCHY ---\n';
  report += `Total Nodes: ${analysis.nodeHierarchy.nodeCount}\n`;
  report += `Root Nodes: ${analysis.nodeHierarchy.rootNodes.join(', ') || 'none'}\n\n`;

  if (analysis.nodeHierarchy.nodeDetails.length > 0) {
    report += 'Node Details:\n';
    analysis.nodeHierarchy.nodeDetails.forEach((node, idx) => {
      report += `  ${node.name} (idx: ${idx}):\n`;
      if (node.hasMesh) {
        report += `    Mesh: ${node.meshIdx}\n`;
      }
      if (node.hasTransform) {
        const t = node.transform.values;
        if (t.translation) {
          report += `    Translation: [${t.translation.map(v => v.toFixed(2)).join(', ')}]\n`;
        }
        if (t.rotation) {
          report += `    Rotation: [${t.rotation.map(v => v.toFixed(3)).join(', ')}]\n`;
        }
        if (t.scale) {
          report += `    Scale: [${t.scale.map(v => v.toFixed(2)).join(', ')}]\n`;
        }
        if (t.matrix) {
          report += `    Matrix: [${t.matrix.slice(0, 4).map(v => v.toFixed(2)).join(', ')}...]\n`;
        }
      } else {
        report += `    (no transform)\n`;
      }
      if (node.children.length > 0) {
        report += `    Children: [${node.children.join(', ')}]\n`;
      }
    });
  }
  report += '\n';

  // Warnings
  if (analysis.issues.warnings.length > 0) {
    report += '--- ⚠️  WARNINGS ---\n';
    analysis.issues.warnings.forEach(issue => {
      report += `  ⚠️  ${issue}\n`;
    });
    report += '\n';
  }

  // Info
  if (analysis.issues.info.length > 0) {
    report += '--- ℹ️  INFO ---\n';
    analysis.issues.info.forEach(issue => {
      report += `  ℹ️  ${issue}\n`;
    });
    report += '\n';
  }

  return report;
}
