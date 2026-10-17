import * as THREE from 'three';

// Mesh editing helpers. Geometry is a non-indexed triangle soup with a per-vertex
// `face` attribute: every triangle of one face carries the same id. A "face" is what
// the kid sees (one side of a box, one quad of a ball); an "edge" is a line where two
// faces meet (or a face ends); a "dot" is every vertex at one spot.

const K = (a, i) => `${Math.round(a[i] * 1000)},${Math.round(a[i + 1] * 1000)},${Math.round(a[i + 2] * 1000)}`;
const edgeKey = (ka, kb) => (ka < kb ? ka + '|' + kb : kb + '|' + ka);

function triNormal(P, t, out) {
  const o = t * 9;
  const ux = P[o + 3] - P[o], uy = P[o + 4] - P[o + 1], uz = P[o + 5] - P[o + 2];
  const vx = P[o + 6] - P[o], vy = P[o + 7] - P[o + 1], vz = P[o + 8] - P[o + 2];
  return out.set(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx); // length = 2 * area
}

// Fallback / initial faces: neighbouring triangles on the same plane form one face.
export function groupCoplanar(g) {
  const P = g.attributes.position.array;
  const tn = P.length / 9;
  const parent = Array.from({ length: tn }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const nrm = [];
  const tmp = new THREE.Vector3();
  for (let t = 0; t < tn; t++) {
    triNormal(P, t, tmp);
    const len = tmp.length();
    nrm.push(len > 1e-9 ? tmp.clone().divideScalar(len) : null);
  }
  const edges = new Map();
  for (let t = 0; t < tn; t++)
    for (let k = 0; k < 3; k++) {
      const ek = edgeKey(K(P, t * 9 + k * 3), K(P, t * 9 + ((k + 1) % 3) * 3));
      if (!edges.has(ek)) edges.set(ek, []);
      edges.get(ek).push(t);
    }
  for (const ts of edges.values())
    for (let i = 0; i < ts.length; i++)
      for (let j = i + 1; j < ts.length; j++) {
        const a = nrm[ts[i]];
        const b = nrm[ts[j]];
        if (a && b && a.dot(b) > 0.9995) parent[find(ts[i])] = find(ts[j]);
      }
  const ids = new Map();
  const out = new Float32Array(tn * 3);
  for (let t = 0; t < tn; t++) {
    const r = find(t);
    if (!ids.has(r)) ids.set(r, ids.size);
    out.fill(ids.get(r), t * 3, t * 3 + 3);
  }
  return out;
}

export function attachFaces(g, perVertex = null) {
  g.setAttribute('face', new THREE.BufferAttribute(perVertex || groupCoplanar(g), 1));
}
export function ensureFaces(g) {
  const f = g.attributes.face;
  if (!f || f.count !== g.attributes.position.count) attachFaces(g);
}
// one id per triangle (3x smaller) for saving
export const facesToTris = (g) => Array.from({ length: g.attributes.face.count / 3 }, (_, t) => g.attributes.face.getX(t * 3));
export const trisToFaces = (tris) => {
  const a = new Float32Array(tris.length * 3);
  tris.forEach((id, t) => a.fill(id, t * 3, t * 3 + 3));
  return a;
};

// ball: quads of two triangles (the generic coplanar rule would leave single triangles)
export function sphereFaces(widthSeg, heightSeg) {
  const ids = [];
  let face = 0;
  for (let iy = 0; iy < heightSeg; iy++)
    for (let ix = 0; ix < widthSeg; ix++) {
      const count = iy === 0 || iy === heightSeg - 1 ? 1 : 2; // pole rows have one triangle per quad
      for (let k = 0; k < count; k++) ids.push(face);
      face++;
    }
  return trisToFaces(ids);
}

// ---- topology the editor uses to draw handles ----
export function buildTopology(g) {
  const P = g.attributes.position.array;
  const F = g.attributes.face.array;
  const n = P.length / 3;
  const keyToGroup = new Map();
  const groups = [];
  const groupOf = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const k = K(P, i * 3);
    let gi = keyToGroup.get(k);
    if (gi === undefined) {
      gi = groups.length;
      keyToGroup.set(k, gi);
      groups.push([]);
    }
    groups[gi].push(i);
    groupOf[i] = gi;
  }
  const faceMap = new Map();
  const edgeMap = new Map();
  for (let t = 0; t < n / 3; t++) {
    const id = F[t * 3];
    if (!faceMap.has(id)) faceMap.set(id, { id, tris: [], gs: new Set() });
    const f = faceMap.get(id);
    f.tris.push(t);
    for (let k = 0; k < 3; k++) {
      const a = groupOf[t * 3 + k];
      const b = groupOf[t * 3 + ((k + 1) % 3)];
      f.gs.add(a);
      if (a === b) continue;
      const ek = a < b ? a + '_' + b : b + '_' + a;
      if (!edgeMap.has(ek)) edgeMap.set(ek, { a: Math.min(a, b), b: Math.max(a, b), ids: new Set(), count: 0 });
      const e = edgeMap.get(ek);
      e.ids.add(id);
      e.count++;
    }
  }
  const faces = [...faceMap.values()].map((f) => ({ id: f.id, tris: f.tris, gs: [...f.gs] }));
  // edges between faces, or on the rim of a face. Lines inside one face don't count.
  const edges = [...edgeMap.values()]
    .filter((e) => e.ids.size > 1 || e.count === 1)
    .map((e) => ({ gs: [e.a, e.b], faces: [...e.ids] }));
  const dots = groups.map((_, gi) => ({ gs: [gi] }));
  const edgesAt = groups.map(() => []);
  const faceEdges = new Map();
  edges.forEach((e, i) => {
    edgesAt[e.gs[0]].push(i);
    edgesAt[e.gs[1]].push(i);
    for (const id of e.faces) {
      if (!faceEdges.has(id)) faceEdges.set(id, []);
      faceEdges.get(id).push(i);
    }
  });
  const faceIndex = new Map(faces.map((f, i) => [f.id, i]));
  return { groups, groupOf, keyToGroup, dots, edges, faces, edgesAt, faceEdges, faceIndex };
}
export const keyOf = (v) => `${Math.round(v.x * 1000)},${Math.round(v.y * 1000)},${Math.round(v.z * 1000)}`;

function pack(P, F, extraPos, extraFace) {
  const position = new Float32Array(P.length + extraPos.length);
  position.set(P);
  position.set(extraPos, P.length);
  const face = new Float32Array(F.length + extraFace.length);
  face.set(F);
  face.set(extraFace, F.length);
  return { position, face };
}
const maxId = (F) => F.reduce((m, v) => (v > m ? v : m), -1);

// Push the chosen faces out along their average normal; wall quads join them to the shape.
export function extrudeFaces(g, idSet, dist) {
  const P = g.attributes.position.array;
  const F = g.attributes.face.array;
  const sel = [];
  const n = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  for (let t = 0; t < P.length / 9; t++)
    if (idSet.has(F[t * 3])) {
      sel.push(t);
      n.add(triNormal(P, t, tmp));
    }
  if (!sel.length) return null;
  if (n.lengthSq() < 1e-12) n.set(0, 1, 0);
  n.normalize().multiplyScalar(dist);
  // rim = edges used by exactly one selected triangle
  const edges = new Map();
  for (const t of sel)
    for (let k = 0; k < 3; k++) {
      const i = t * 9 + k * 3;
      const j = t * 9 + ((k + 1) % 3) * 3;
      const ka = K(P, i);
      const kb = K(P, j);
      if (ka === kb) continue;
      const ek = edgeKey(ka, kb);
      const e = edges.get(ek);
      if (e) e.n++;
      else edges.set(ek, { n: 1, a: Array.from(P.subarray(i, i + 3)), b: Array.from(P.subarray(j, j + 3)) });
    }
  const walls = [...edges.values()].filter((e) => e.n === 1);
  let next = maxId(F) + 1;
  const extraPos = [];
  const extraFace = [];
  for (const w of walls) {
    const a2 = [w.a[0] + n.x, w.a[1] + n.y, w.a[2] + n.z];
    const b2 = [w.b[0] + n.x, w.b[1] + n.y, w.b[2] + n.z];
    extraPos.push(...w.a, ...w.b, ...a2, ...w.b, ...b2, ...a2);
    extraFace.push(next, next, next, next, next, next);
    next++;
  }
  const out = pack(P, F, new Float32Array(extraPos), new Float32Array(extraFace));
  for (const t of sel) for (let v = 0; v < 3; v++) {
    out.position[t * 9 + v * 3] += n.x;
    out.position[t * 9 + v * 3 + 1] += n.y;
    out.position[t * 9 + v * 3 + 2] += n.z;
  }
  return out;
}

// Pull a flap out of one edge. pa / pb are the edge's two end points (local space).
export function extrudeEdge(g, pa, pb, dist) {
  const P = g.attributes.position.array;
  const F = g.attributes.face.array;
  const ka = keyOf(pa);
  const kb = keyOf(pb);
  const n = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  for (let t = 0; t < P.length / 9; t++) {
    const ks = [0, 1, 2].map((k) => K(P, t * 9 + k * 3));
    if (ks.includes(ka) && ks.includes(kb)) n.add(triNormal(P, t, tmp));
  }
  if (n.lengthSq() < 1e-12) n.set(0, 1, 0);
  n.normalize().multiplyScalar(dist);
  const a2 = pa.clone().add(n);
  const b2 = pb.clone().add(n);
  const id = maxId(F) + 1;
  const out = pack(
    P,
    F,
    new Float32Array([...pa.toArray(), ...pb.toArray(), ...a2.toArray(), ...pb.toArray(), ...b2.toArray(), ...a2.toArray()]),
    new Float32Array(6).fill(id),
  );
  out.keys = [keyOf(a2), keyOf(b2)];
  return out;
}

// ---------------------------------------------------------------- loops and rings
// Edge loop: from a clicked edge keep going straight through every 4-way corner
// (the edge that shares no face with the one we came in on). At a 3-way corner,
// like a cube's, follow the outline of `preferFace` instead. Poles end the loop.
export function edgeLoop(topo, e0, preferFace) {
  const E = topo.edges;
  const out = new Set([e0]);
  const walk = (v0) => {
    let v = v0;
    let e = e0;
    let face = preferFace;
    for (let guard = 0; guard < 5000; guard++) {
      const here = topo.edgesAt[v];
      const cand = here.filter((i) => i !== e);
      let next;
      if (here.length === 4) {
        const used = new Set(E[e].faces);
        next = cand.find((i) => !E[i].faces.some((f) => used.has(f)));
      } else if (here.length === 3) {
        if (!E[e].faces.includes(face)) face = E[e].faces[0];
        next = cand.find((i) => E[i].faces.includes(face));
      }
      if (next === undefined || out.has(next)) break;
      out.add(next);
      v = E[next].gs[0] === v ? E[next].gs[1] : E[next].gs[0];
      e = next;
    }
  };
  walk(E[e0].gs[0]);
  walk(E[e0].gs[1]);
  return [...out];
}

// Face loop: a belt of four-sided faces. Start on face `f0` and cross edge `via`;
// the belt runs through that edge and the edge opposite it.
export function faceLoop(topo, f0, via) {
  const E = topo.edges;
  const chain = new Set([f0]);
  const touches = (a, b) => E[a].gs.some((g) => E[b].gs.includes(g));
  const go = (face, entry) => {
    let cur = face;
    let ein = entry;
    for (let guard = 0; guard < 5000; guard++) {
      const fe = topo.faceEdges.get(cur) || [];
      if (fe.length !== 4) break;
      const eout = fe.find((i) => i !== ein && !touches(i, ein));
      if (eout === undefined) break;
      const nxt = E[eout].faces.find((id) => id !== cur);
      if (nxt === undefined || chain.has(nxt)) break;
      chain.add(nxt);
      cur = nxt;
      ein = eout;
    }
  };
  go(f0, via); // out through the opposite edge
  const across = E[via].faces.find((id) => id !== f0);
  if (across !== undefined && !chain.has(across)) {
    chain.add(across);
    go(across, via);
  }
  return [...chain];
}

// ---------------------------------------------------------------- delete and inset
export function deleteFaces(g, idSet) {
  const P = g.attributes.position.array;
  const F = g.attributes.face.array;
  const keep = [];
  for (let t = 0; t < P.length / 9; t++) if (!idSet.has(F[t * 3])) keep.push(t);
  if (!keep.length) return null;
  const position = new Float32Array(keep.length * 9);
  const face = new Float32Array(keep.length * 3);
  keep.forEach((t, i) => {
    position.set(P.subarray(t * 9, t * 9 + 9), i * 9);
    face.set(F.subarray(t * 3, t * 3 + 3), i * 3);
  });
  return { position, face };
}

// Shrink each picked face toward its middle and fill the gap with a ring of faces.
export function insetFaces(g, idSet, amount) {
  const P = g.attributes.position.array;
  const F = g.attributes.face.array;
  let next = maxId(F) + 1;
  const extraPos = [];
  const extraFace = [];
  const moves = []; // [triangle, vertex, newX, newY, newZ]
  for (const id of idSet) {
    const tris = [];
    for (let t = 0; t < P.length / 9; t++) if (F[t * 3] === id) tris.push(t);
    if (!tris.length) continue;
    const seen = new Map();
    for (const t of tris) for (let v = 0; v < 3; v++) seen.set(K(P, t * 9 + v * 3), P.subarray(t * 9 + v * 3, t * 9 + v * 3 + 3));
    const c = new THREE.Vector3();
    for (const q of seen.values()) c.add(new THREE.Vector3(q[0], q[1], q[2]));
    c.divideScalar(seen.size);
    const inner = (a) => [a[0] + (c.x - a[0]) * amount, a[1] + (c.y - a[1]) * amount, a[2] + (c.z - a[2]) * amount];
    const rim = new Map();
    for (const t of tris)
      for (let k = 0; k < 3; k++) {
        const i = t * 9 + k * 3;
        const j = t * 9 + ((k + 1) % 3) * 3;
        const ka = K(P, i);
        const kb = K(P, j);
        if (ka === kb) continue;
        const ek = edgeKey(ka, kb);
        const e = rim.get(ek);
        if (e) e.n++;
        else rim.set(ek, { n: 1, a: Array.from(P.subarray(i, i + 3)), b: Array.from(P.subarray(j, j + 3)) });
      }
    for (const w of rim.values()) {
      if (w.n !== 1) continue;
      const a2 = inner(w.a);
      const b2 = inner(w.b);
      extraPos.push(...w.a, ...w.b, ...a2, ...w.b, ...b2, ...a2);
      extraFace.push(next, next, next, next, next, next);
      next++;
    }
    for (const t of tris) for (let v = 0; v < 3; v++) moves.push([t, v, inner(Array.from(P.subarray(t * 9 + v * 3, t * 9 + v * 3 + 3)))]);
  }
  if (!moves.length) return null;
  const out = pack(P, F, new Float32Array(extraPos), new Float32Array(extraFace));
  for (const [t, v, q] of moves) out.position.set(q, t * 9 + v * 3);
  return out;
}

// ---------------------------------------------------------------- advanced: merge, dot extrude, fill, bevel
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const vecAt = (A, i) => new THREE.Vector3(A[i], A[i + 1], A[i + 2]);
const triArea2 = (P, t) => triNormal(P, t, new THREE.Vector3()).length();
const partCentroid = (P) => {
  const c = new THREE.Vector3();
  for (let i = 0; i < P.length; i += 3) c.add(vecAt(P, i));
  return c.divideScalar(P.length / 3);
};

// A "loose edge" is a triangle with a repeated corner (a, b, b). It draws nothing, but
// it keeps an edge in the mesh so you can pull dots out and then fill them in.
export const isLoose = (P, t) => triArea2(P, t) < 1e-10 && new Set([0, 1, 2].map((k) => K(P, t * 9 + k * 3))).size === 2;

// Triangles and loose edges are only kept if they are still real after a merge.
function keepAfterMerge(P0, P1, F) {
  const keep = [];
  for (let t = 0; t < P1.length / 9; t++) {
    const wasLoose = triArea2(P0, t) < 1e-10;
    const keys = new Set([0, 1, 2].map((k) => K(P1, t * 9 + k * 3))).size;
    if (wasLoose ? keys === 2 : triArea2(P1, t) > 1e-10) keep.push(t);
  }
  if (!keep.length) return null;
  const position = new Float32Array(keep.length * 9);
  const face = new Float32Array(keep.length * 3);
  keep.forEach((t, i) => {
    position.set(P1.subarray(t * 9, t * 9 + 9), i * 9);
    face.set(F.subarray(t * 3, t * 3 + 3), i * 3);
  });
  return { position, face };
}

// Squash the chosen dots into one dot at their middle.
export function mergeDots(g, topo, gs) {
  const P0 = g.attributes.position.array;
  const F = g.attributes.face.array;
  const P1 = Float32Array.from(P0);
  const c = new THREE.Vector3();
  for (const gi of gs) c.add(vecAt(P0, topo.groups[gi][0] * 3));
  c.divideScalar(gs.length);
  for (const gi of gs) for (const i of topo.groups[gi]) P1.set([c.x, c.y, c.z], i * 3);
  return keepAfterMerge(P0, P1, F);
}

// Pull a loose edge out of each dot. Returns the keys of the new dots.
export function extrudeDots(g, topo, gs, dist) {
  const P = g.attributes.position.array;
  const F = g.attributes.face.array;
  let next = maxId(F) + 1;
  const extraPos = [];
  const extraFace = [];
  const keys = [];
  const tmp = new THREE.Vector3();
  for (const gi of gs) {
    const mine = new Set(topo.groups[gi].map((i) => Math.floor(i / 3)));
    const n = new THREE.Vector3();
    for (const t of mine) n.add(triNormal(P, t, tmp));
    if (n.lengthSq() < 1e-12) n.set(0, 1, 0);
    n.normalize().multiplyScalar(dist);
    const p = vecAt(P, topo.groups[gi][0] * 3);
    const q = p.clone().add(n);
    extraPos.push(...p.toArray(), ...q.toArray(), ...q.toArray());
    extraFace.push(next, next, next);
    next++;
    keys.push(keyOf(q));
  }
  const out = pack(P, F, new Float32Array(extraPos), new Float32Array(extraFace));
  out.keys = keys;
  return out;
}

// Make one face out of three or more dots (like Blender's F).
export function fillDots(g, topo, gs) {
  if (gs.length < 3) return null;
  const P = g.attributes.position.array;
  const F = g.attributes.face.array;
  const pts = gs.map((gi) => vecAt(P, topo.groups[gi][0] * 3));
  const c = new THREE.Vector3();
  pts.forEach((v) => c.add(v));
  c.divideScalar(pts.length);
  // best-fit normal (Newell), then sort the dots around the middle
  const n = new THREE.Vector3();
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  });
  if (n.lengthSq() < 1e-12) return null;
  n.normalize();
  const u = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0).cross(n).normalize() : new THREE.Vector3(1, 0, 0);
  const v = n.clone().cross(u);
  const ordered = pts
    .map((p) => ({ p, a: Math.atan2(p.clone().sub(c).dot(v), p.clone().sub(c).dot(u)) }))
    .sort((x, y) => x.a - y.a)
    .map((o) => o.p);
  // wind it so it faces away from the middle of the shape
  if (n.dot(c.clone().sub(partCentroid(P))) < 0) ordered.reverse();
  const id = maxId(F) + 1;
  const extra = [];
  for (let i = 1; i < ordered.length - 1; i++) extra.push(...ordered[0].toArray(), ...ordered[i].toArray(), ...ordered[i + 1].toArray());
  return pack(P, F, new Float32Array(extra), new Float32Array((ordered.length - 2) * 3).fill(id));
}

// Chamfer: slide the faces beside each picked edge back by `width` and fill the gap with a strip.
// Corners where several edges meet get a patch. Returns { position, face } or { error }.
export function bevelEdges(g, topo, selEdges, width) {
  const P = g.attributes.position.array;
  const F = g.attributes.face.array;
  const E = topo.edges;
  const gp = (gi) => vecAt(P, topo.groups[gi][0] * 3);
  const sel = new Set(selEdges.filter((i) => E[i].faces.length === 2));
  if (!sel.size) return { error: 'Bevel needs edges that sit between two faces.' };
  const faceNormal = (id) => {
    const n = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    for (const t of topo.faces[topo.faceIndex.get(id)].tris) n.add(triNormal(P, t, tmp));
    return n;
  };
  // every (face, corner) next to a picked edge, with the face's two rim edges at that corner
  const pairs = new Map();
  let w = width;
  for (const e of sel)
    for (const x of E[e].gs)
      for (const f of E[e].faces) {
        const k = f + ':' + x;
        if (pairs.has(k)) continue;
        const at = (topo.faceEdges.get(f) || []).filter((i) => E[i].gs.includes(x));
        if (at.length !== 2) return { error: 'That corner is too tricky to bevel. Try other edges.' };
        const far = (i) => (E[i].gs[0] === x ? E[i].gs[1] : E[i].gs[0]);
        const X = gp(x);
        const up = gp(far(at[0])).sub(X);
        const uq = gp(far(at[1])).sub(X);
        w = Math.min(w, 0.45 * up.length(), 0.45 * uq.length());
        pairs.set(k, { f, x, X, at, up: up.normalize(), uq: uq.normalize() });
      }
  const np = new Map();
  for (const [k, v] of pairs) {
    const off = new THREE.Vector3();
    if (sel.has(v.at[0])) off.addScaledVector(v.uq, w);
    if (sel.has(v.at[1])) off.addScaledVector(v.up, w);
    np.set(k, v.X.clone().add(off));
  }
  const P2 = Float32Array.from(P);
  for (const [, v] of pairs) {
    const q = np.get(v.f + ':' + v.x);
    for (const t of topo.faces[topo.faceIndex.get(v.f)].tris)
      for (let k = 0; k < 3; k++) if (topo.groupOf[t * 3 + k] === v.x) P2.set(q.toArray(), (t * 3 + k) * 3);
  }
  const centre = partCentroid(P);
  const extraPos = [];
  const extraFace = [];
  let next = maxId(F) + 1;
  const emit = (pts, ref) => {
    // fan of triangles, wound to face the same way as `ref`
    const flat = [];
    for (let i = 1; i < pts.length - 1; i++) flat.push(pts[0], pts[i], pts[i + 1]);
    const n = new THREE.Vector3();
    for (let i = 0; i < flat.length; i += 3) n.add(flat[i + 1].clone().sub(flat[i]).cross(flat[i + 2].clone().sub(flat[i])));
    if (n.dot(ref) < 0) for (let i = 0; i < flat.length; i += 3) [flat[i + 1], flat[i + 2]] = [flat[i + 2], flat[i + 1]];
    for (const v of flat) extraPos.push(...v.toArray());
    flat.forEach(() => extraFace.push(next));
    next++;
  };
  for (const e of sel) {
    const [a, b] = E[e].gs;
    const [f1, f2] = E[e].faces;
    const quad = [np.get(f1 + ':' + a), np.get(f1 + ':' + b), np.get(f2 + ':' + b), np.get(f2 + ':' + a)];
    emit(quad, faceNormal(f1).add(faceNormal(f2)));
  }
  // corner patches: join the new corner points of every face around a touched dot
  const touched = new Set();
  sel.forEach((e) => E[e].gs.forEach((x) => touched.add(x)));
  for (const x of touched) {
    const around = topo.faces.filter((f) => f.gs.includes(x)).map((f) => f.id);
    const link = new Map(around.map((id) => [id, []]));
    for (const ei of topo.edgesAt[x]) {
      const fs = E[ei].faces;
      if (fs.length === 2 && link.has(fs[0]) && link.has(fs[1])) {
        link.get(fs[0]).push(fs[1]);
        link.get(fs[1]).push(fs[0]);
      }
    }
    if ([...link.values()].some((l) => l.length !== 2)) continue; // open corner: nothing to patch
    const order = [around[0]];
    for (let guard = 0; guard < around.length; guard++) {
      const nxt = link.get(order[order.length - 1]).find((id) => !order.includes(id));
      if (nxt === undefined) break;
      order.push(nxt);
    }
    if (order.length !== around.length) continue;
    const X = gp(x);
    const ring = [];
    for (const id of order) {
      const q = np.get(id + ':' + x) || X;
      if (!ring.length || ring[ring.length - 1].distanceToSquared(q) > 1e-12) ring.push(q);
    }
    if (ring.length > 1 && ring[0].distanceToSquared(ring[ring.length - 1]) <= 1e-12) ring.pop();
    if (ring.length >= 3) emit(ring, X.clone().sub(centre));
  }
  const out = pack(P2, F, new Float32Array(extraPos), new Float32Array(extraFace));
  out.width = w;
  return out;
}

// For export: only real triangles, only position / normal / uv.
export function exportGeometry(g) {
  const P = g.attributes.position;
  const N = g.attributes.normal;
  const U = g.attributes.uv;
  const keep = [];
  for (let t = 0; t < P.count / 3; t++) if (triArea2(P.array, t) > 1e-10) keep.push(t);
  const out = new THREE.BufferGeometry();
  const pick = (attr, size) => {
    const a = new Float32Array(keep.length * 3 * size);
    keep.forEach((t, i) => a.set(attr.array.subarray(t * 3 * size, t * 3 * size + 3 * size), i * 3 * size));
    return new THREE.BufferAttribute(a, size);
  };
  out.setAttribute('position', pick(P, 3));
  if (N) out.setAttribute('normal', pick(N, 3));
  if (U) out.setAttribute('uv', pick(U, 2));
  if (g.attributes.color) out.setAttribute('color', pick(g.attributes.color, 3));
  return out;
}
