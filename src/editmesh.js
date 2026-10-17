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
