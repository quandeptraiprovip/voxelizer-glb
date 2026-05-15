interface ProcessGeometryMessage {
  type: 'process';
  data: {
    positions: Float32Array;
    boundingMin: [number, number, number];
    boundingMax: [number, number, number];
  };
}

interface ProcessedGeometry {
  colors: Float32Array;
}

self.onmessage = (event: MessageEvent<ProcessGeometryMessage>) => {
  if (event.data.type === 'process') {
    const { positions, boundingMin, boundingMax } = event.data.data;

    const [minX, minY, minZ] = boundingMin;
    const [maxX, maxY, maxZ] = boundingMax;
    const sizeX = maxX - minX || 1;
    const sizeY = maxY - minY || 1;
    const sizeZ = maxZ - minZ || 1;

    // Generate colors based on position gradient
    const colors = new Float32Array(positions.length);

    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const y = positions[i + 1];
      const z = positions[i + 2];

      const nx = (x - minX) / sizeX;
      const ny = (y - minY) / sizeY;
      const nz = (z - minZ) / sizeZ;

      colors[i] = Math.max(0.3, Math.min(1, nx * 1.2));
      colors[i + 1] = Math.max(0.3, Math.min(1, ny * 1.2));
      colors[i + 2] = Math.max(0.3, Math.min(1, nz * 1.2));
    }

    const result: ProcessedGeometry = {
      colors,
    };

    const transferables: Transferable[] = [result.colors.buffer];
    (self as any).postMessage({ type: 'processed', data: result }, transferables);
  }
};
