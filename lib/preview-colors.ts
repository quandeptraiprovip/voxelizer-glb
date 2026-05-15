/** Vertex colors for model preview: use mesh colors or position gradient. */

export function buildPreviewVertexColors(
  positions: Float32Array,
  boundingMin: [number, number, number],
  boundingMax: [number, number, number],
  existingColors?: Float32Array | null
): Float32Array {
  if (existingColors && existingColors.length >= positions.length) {
    return new Float32Array(existingColors.subarray(0, positions.length));
  }

  const [minX, minY, minZ] = boundingMin;
  const [maxX, maxY, maxZ] = boundingMax;
  const sizeX = maxX - minX || 1;
  const sizeY = maxY - minY || 1;
  const sizeZ = maxZ - minZ || 1;

  const colors = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const nx = (positions[i] - minX) / sizeX;
    const ny = (positions[i + 1] - minY) / sizeY;
    const nz = (positions[i + 2] - minZ) / sizeZ;
    colors[i] = Math.max(0.3, Math.min(1, nx * 1.2));
    colors[i + 1] = Math.max(0.3, Math.min(1, ny * 1.2));
    colors[i + 2] = Math.max(0.3, Math.min(1, nz * 1.2));
  }
  return colors;
}

/** Yield to the event loop every `chunkVerts` vertices. */
export async function buildPreviewVertexColorsAsync(
  positions: Float32Array,
  boundingMin: [number, number, number],
  boundingMax: [number, number, number],
  existingColors?: Float32Array | null,
  chunkVerts = 80_000
): Promise<Float32Array> {
  if (existingColors && existingColors.length >= positions.length) {
    return new Float32Array(existingColors.subarray(0, positions.length));
  }

  const [minX, minY, minZ] = boundingMin;
  const [maxX, maxY, maxZ] = boundingMax;
  const sizeX = maxX - minX || 1;
  const sizeY = maxY - minY || 1;
  const sizeZ = maxZ - minZ || 1;

  const colors = new Float32Array(positions.length);
  const stride = chunkVerts * 3;

  for (let start = 0; start < positions.length; start += stride) {
    const end = Math.min(positions.length, start + stride);
    for (let i = start; i < end; i += 3) {
      const nx = (positions[i] - minX) / sizeX;
      const ny = (positions[i + 1] - minY) / sizeY;
      const nz = (positions[i + 2] - minZ) / sizeZ;
      colors[i] = Math.max(0.3, Math.min(1, nx * 1.2));
      colors[i + 1] = Math.max(0.3, Math.min(1, ny * 1.2));
      colors[i + 2] = Math.max(0.3, Math.min(1, nz * 1.2));
    }
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  return colors;
}
