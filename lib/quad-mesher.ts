import * as THREE from 'three';

export type V3 = [number, number, number];
export type V4 = [number, number, number, number];

export interface Panel {
  center: V3;
  normal: V3;
  quaternion: V4;
  size: number;
  color: V3;
  distFromCenter: number;
}

/** A quad face — vertices ordered around perimeter (no shared-edge diagonal) */
export interface QuadFace {
  v: [V3, V3, V3, V3]; // [u1, s1, u2, s2] where s1-s2 was the shared edge
  normal: V3;
  center: V3;
}

/** An unpaired triangle (couldn't find a coplanar neighbour) */
export interface OrphanTri {
  v: [V3, V3, V3];
  normal: V3;
  center: V3;
}

export interface QuadMeshData {
  panels: Panel[];
  quads: QuadFace[];
  orphans: OrphanTri[];
  stats: { triCount: number; quadCount: number; orphanCount: number };
}

// ─── Main entry point ────────────────────────────────────────────────────────

export function buildQuadMesh(
  geometry: THREE.BufferGeometry,
  maxTris = 16000,
): QuadMeshData {
  const posAttr = geometry.attributes.position;
  if (!posAttr) return empty();

  const indexAttr = geometry.index;
  const totalTris = indexAttr
    ? Math.floor(indexAttr.count / 3)
    : Math.floor(posAttr.count / 3);
  if (totalTris === 0) return empty();

  // Stride to stay within maxTris budget
  const stride = Math.max(1, Math.ceil(totalTris / maxTris));

  // ── Extract triangles ──────────────────────────────────────────────────────
  interface Tri {
    vi: [number, number, number]; // welded vertex indices for edge lookup
    rawVi: [number, number, number]; // original buffer indices for positions
    pos: [V3, V3, V3];
    normal: V3;
    center: V3;
  }

  // Weld vertices: deduplicate by rounded position so we can detect shared edges
  // in non-indexed or badly-indexed geometries
  const WELD = 1e5;
  const weldMap = new Map<string, number>();
  const weld = (i: number): number => {
    const key = `${Math.round(posAttr.getX(i) * WELD)},${Math.round(posAttr.getY(i) * WELD)},${Math.round(posAttr.getZ(i) * WELD)}`;
    let wi = weldMap.get(key);
    if (wi === undefined) { wi = weldMap.size; weldMap.set(key, wi); }
    return wi;
  };

  const tris: Tri[] = [];
  for (let t = 0; t < totalTris; t += stride) {
    const base = t * 3;
    const r0 = indexAttr ? indexAttr.getX(base)     : base;
    const r1 = indexAttr ? indexAttr.getX(base + 1) : base + 1;
    const r2 = indexAttr ? indexAttr.getX(base + 2) : base + 2;

    const p0: V3 = [posAttr.getX(r0), posAttr.getY(r0), posAttr.getZ(r0)];
    const p1: V3 = [posAttr.getX(r1), posAttr.getY(r1), posAttr.getZ(r1)];
    const p2: V3 = [posAttr.getX(r2), posAttr.getY(r2), posAttr.getZ(r2)];

    const ex = p1[0]-p0[0], ey = p1[1]-p0[1], ez = p1[2]-p0[2];
    const fx = p2[0]-p0[0], fy = p2[1]-p0[1], fz = p2[2]-p0[2];
    let nx = ey*fz - ez*fy, ny = ez*fx - ex*fz, nz = ex*fy - ey*fx;
    const nl = Math.sqrt(nx*nx + ny*ny + nz*nz);
    if (nl < 1e-10) { nx = 0; ny = 1; nz = 0; } else { nx /= nl; ny /= nl; nz /= nl; }

    tris.push({
      vi: [weld(r0), weld(r1), weld(r2)],
      rawVi: [r0, r1, r2],
      pos: [p0, p1, p2],
      normal: [nx, ny, nz],
      center: [(p0[0]+p1[0]+p2[0])/3, (p0[1]+p1[1]+p2[1])/3, (p0[2]+p1[2]+p2[2])/3],
    });
  }

  const triCount = tris.length;

  // ── Edge adjacency map (by welded vertex indices) ──────────────────────────
  const edgeMap = new Map<string, number[]>();
  const addEdge = (a: number, b: number, ti: number) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const list = edgeMap.get(key);
    if (list) list.push(ti); else edgeMap.set(key, [ti]);
  };
  for (let i = 0; i < triCount; i++) {
    const [w0, w1, w2] = tris[i].vi;
    addEdge(w0, w1, i); addEdge(w1, w2, i); addEdge(w2, w0, i);
  }

  // ── QEM-based tri→quad pairing ────────────────────────────────────────────
  // Build weld-index → raw-index map for O(1) position access
  const weldToRaw = new Map<number, number>();
  for (let i = 0; i < triCount; i++)
    for (let k = 0; k < 3; k++)
      if (!weldToRaw.has(tris[i].vi[k])) weldToRaw.set(tris[i].vi[k], tris[i].rawVi[k]);

  const posW = (wi: number): V3 => {
    const ri = weldToRaw.get(wi)!;
    return [posAttr.getX(ri), posAttr.getY(ri), posAttr.getZ(ri)];
  };

  // Per-vertex 4×4 quadric matrix Q_v = Σ (p·pᵀ) over adjacent face planes
  const vertQ = new Map<number, Float64Array>();
  const getQ  = (wi: number) => {
    let q = vertQ.get(wi);
    if (!q) { q = new Float64Array(16); vertQ.set(wi, q); }
    return q;
  };
  for (const t of tris) {
    const [nx, ny, nz] = t.normal;
    const d = -(nx*t.pos[0][0] + ny*t.pos[0][1] + nz*t.pos[0][2]);
    const p = [nx, ny, nz, d];
    for (const wi of t.vi) {
      const q = getQ(wi);
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) q[r*4+c] += p[r]*p[c];
    }
  }

  // Collect every adjacent triangle pair, score each by QEM error at centroid
  interface Pair { t1: number; t2: number; wA: number; wB: number; cost: number }
  const candidates: Pair[] = [];

  for (let i = 0; i < triCount; i++) {
    const t1 = tris[i];
    const [w0, w1, w2] = t1.vi;
    for (const [ea, eb] of [[w0,w1],[w1,w2],[w2,w0]] as [number,number][]) {
      const key = ea < eb ? `${ea},${eb}` : `${eb},${ea}`;
      const nbrs = edgeMap.get(key);
      if (!nbrs) continue;
      for (const j of nbrs) {
        if (j <= i) continue; // each pair once
        const t2 = tris[j];
        // Never merge triangles facing opposite directions
        const dot12 = t1.normal[0]*t2.normal[0]+t1.normal[1]*t2.normal[1]+t1.normal[2]*t2.normal[2];
        if (dot12 < 0) continue;

        const wA = ea < eb ? ea : eb, wB = ea < eb ? eb : ea;
        const u1wi = t1.vi.find(w => w !== wA && w !== wB)!;
        const u2wi = t2.vi.find(w => w !== wA && w !== wB)!;
        if (u1wi === undefined || u2wi === undefined) continue;

        // Q₄ = sum of quadrics for the 4 quad vertices
        const Q4 = new Float64Array(16);
        for (const wi of [u1wi, wA, wB, u2wi]) {
          const q = vertQ.get(wi); if (!q) continue;
          for (let k = 0; k < 16; k++) Q4[k] += q[k];
        }

        // QEM error at quad centroid — measures planarity of the resulting quad
        const [u1p, sAp, sBp, u2p] = [posW(u1wi), posW(wA), posW(wB), posW(u2wi)];
        const cx = (u1p[0]+sAp[0]+u2p[0]+sBp[0])*0.25;
        const cy = (u1p[1]+sAp[1]+u2p[1]+sBp[1])*0.25;
        const cz = (u1p[2]+sAp[2]+u2p[2]+sBp[2])*0.25;
        const v  = [cx, cy, cz, 1];
        let cost = 0;
        for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) cost += Q4[r*4+c]*v[r]*v[c];

        candidates.push({ t1: i, t2: j, wA, wB, cost });
      }
    }
  }

  // Sort ascending by QEM cost — flattest (best) quads first
  candidates.sort((a, b) => a.cost - b.cost);

  // Greedy matching: pick best non-overlapping pairs
  const pairedSet = new Set<number>();
  const pairs: Pair[] = [];
  for (const cand of candidates) {
    if (!pairedSet.has(cand.t1) && !pairedSet.has(cand.t2)) {
      pairs.push(cand);
      pairedSet.add(cand.t1);
      pairedSet.add(cand.t2);
    }
  }

  // ── Build QuadFace list ───────────────────────────────────────────────────
  const quads: QuadFace[] = [];
  const orphans: OrphanTri[] = [];

  for (const { t1, t2, wA, wB } of pairs) {
    const tri1 = tris[t1];
    const tri2 = tris[t2];

    // u1 = tri1's vertex NOT in shared edge, u2 = tri2's same
    const u1wi = tri1.vi.find(w => w !== wA && w !== wB)!;
    const u2wi = tri2.vi.find(w => w !== wA && w !== wB)!;

    // Map welded → raw buffer index → position
    const wToRaw1 = new Map(tri1.vi.map((w, k) => [w, tri1.rawVi[k]]));
    const wToRaw2 = new Map(tri2.vi.map((w, k) => [w, tri2.rawVi[k]]));
    const allWToRaw = new Map([...wToRaw1, ...wToRaw2]);

    const getPos = (wi: number): V3 => {
      const ri = allWToRaw.get(wi)!;
      return [posAttr.getX(ri), posAttr.getY(ri), posAttr.getZ(ri)];
    };

    const u1 = getPos(u1wi), sA = getPos(wA), u2 = getPos(u2wi), sB = getPos(wB);

    let nx = (tri1.normal[0]+tri2.normal[0])*0.5;
    let ny = (tri1.normal[1]+tri2.normal[1])*0.5;
    let nz = (tri1.normal[2]+tri2.normal[2])*0.5;
    const nl = Math.sqrt(nx*nx+ny*ny+nz*nz);
    if (nl > 1e-10) { nx/=nl; ny/=nl; nz/=nl; }

    // Sort vertices into proper CCW winding so we never get hourglass/bowtie shapes
    const ordered = sortQuadCCW(u1, sA, u2, sB, [nx, ny, nz]);

    quads.push({
      v: ordered,
      normal: [nx, ny, nz],
      center: [
        (u1[0]+sA[0]+u2[0]+sB[0])*0.25,
        (u1[1]+sA[1]+u2[1]+sB[1])*0.25,
        (u1[2]+sA[2]+u2[2]+sB[2])*0.25,
      ],
    });
  }

  for (let i = 0; i < triCount; i++) {
    if (!pairedSet.has(i)) {
      const t = tris[i];
      orphans.push({ v: t.pos, normal: t.normal, center: t.center });
    }
  }

  // ── Build panels from quads + orphans ─────────────────────────────────────
  const panels: Panel[] = [];

  for (const q of quads) {
    const [v0,,v2, v3] = q.v;
    // size from cross-diagonal span
    const d02 = dist(v0, v2), d13 = dist(q.v[1], v3);
    const size = Math.max(d02, d13) * 0.87;
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1), new THREE.Vector3(...q.normal));
    panels.push({
      center: [...q.center] as V3,
      normal: [...q.normal] as V3,
      quaternion: [quat.x, quat.y, quat.z, quat.w],
      size: Math.max(size, 1e-4),
      color: normalToColor(q.normal),
      distFromCenter: 0,
    });
  }

  for (const o of orphans) {
    const d01 = dist(o.v[0], o.v[1]), d12 = dist(o.v[1], o.v[2]), d20 = dist(o.v[2], o.v[0]);
    const size = Math.max(d01, d12, d20) * 0.70;
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1), new THREE.Vector3(...o.normal));
    panels.push({
      center: [...o.center] as V3,
      normal: [...o.normal] as V3,
      quaternion: [quat.x, quat.y, quat.z, quat.w],
      size: Math.max(size, 1e-4),
      color: normalToColor(o.normal),
      distFromCenter: 0,
    });
  }

  // Compute distFromCenter
  if (panels.length > 0) {
    const cx = panels.reduce((s,p)=>s+p.center[0],0)/panels.length;
    const cy = panels.reduce((s,p)=>s+p.center[1],0)/panels.length;
    const cz = panels.reduce((s,p)=>s+p.center[2],0)/panels.length;
    for (const p of panels) {
      const dx=p.center[0]-cx, dy=p.center[1]-cy, dz=p.center[2]-cz;
      p.distFromCenter = Math.sqrt(dx*dx+dy*dy+dz*dz);
    }
  }

  return {
    panels,
    quads,
    orphans,
    stats: { triCount, quadCount: quads.length, orphanCount: orphans.length },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Sort four coplanar vertices into CCW winding order around their centroid. */
function sortQuadCCW(a: V3, b: V3, c: V3, d: V3, normal: V3): [V3, V3, V3, V3] {
  const cx = (a[0]+b[0]+c[0]+d[0])*0.25;
  const cy = (a[1]+b[1]+c[1]+d[1])*0.25;
  const cz = (a[2]+b[2]+c[2]+d[2])*0.25;
  const n  = new THREE.Vector3(normal[0], normal[1], normal[2]);
  const t  = new THREE.Vector3(a[0]-cx, a[1]-cy, a[2]-cz).normalize();
  const bt = new THREE.Vector3().crossVectors(n, t);
  const verts: [V3, number][] = [a,b,c,d].map(v => {
    const dx=v[0]-cx, dy=v[1]-cy, dz=v[2]-cz;
    return [v, Math.atan2(bt.x*dx+bt.y*dy+bt.z*dz, t.x*dx+t.y*dy+t.z*dz)];
  });
  verts.sort((x,y) => x[1]-y[1]);
  return verts.map(x=>x[0]) as [V3,V3,V3,V3];
}

function dist(a: V3, b: V3): number {
  return Math.sqrt((b[0]-a[0])**2 + (b[1]-a[1])**2 + (b[2]-a[2])**2);
}

function normalToColor(n: V3): V3 {
  const h = ((Math.atan2(n[2], n[0]) / (2*Math.PI)) + 1) % 1;
  return hslToRgb(h, 0.60, 0.40 + n[1] * 0.18);
}

function hslToRgb(h: number, s: number, l: number): V3 {
  const a = s * Math.min(l, 1-l);
  const f = (n: number) => { const k = (n + h*12) % 12; return l - a * Math.max(-1, Math.min(k-3, 9-k, 1)); };
  return [f(0), f(8), f(4)];
}

function empty(): QuadMeshData {
  return { panels:[], quads:[], orphans:[], stats:{ triCount:0, quadCount:0, orphanCount:0 } };
}
