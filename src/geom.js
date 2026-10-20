import * as THREE from 'three';
import { attachFaces, ensureFaces, sphereFaces } from './editmesh.js';

// [id, label, emoji]
export const SHAPES = [
  ['box', 'Box', '🟦'],
  ['ball', 'Ball', '🔴'],
  ['cylinder', 'Can', '🥫'],
  ['cone', 'Cone', '🔺'],
  ['pyramid', 'Pyramid', '⛰️'],
  ['wedge', 'Ramp', '📐'],
];
export const shapeLabel = (t) => (SHAPES.find((s) => s[0] === t) || SHAPES[0])[1];

// All geometry is non-indexed (a "triangle soup") so every face is flat shaded
// and every triangle can get its own UVs. Mirroring and point editing rely on
// vertex i staying vertex i, so never reorder.
function unit(type) {
  let g;
  switch (type) {
    case 'ball':
      g = new THREE.SphereGeometry(0.5, 10, 7);
      break;
    case 'cylinder':
      g = new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1);
      break;
    case 'cone':
      g = new THREE.CylinderGeometry(0, 0.5, 1, 10, 1);
      break;
    case 'pyramid':
      g = new THREE.CylinderGeometry(0, 0.5 * Math.SQRT2, 1, 4, 1);
      g.rotateY(Math.PI / 4);
      break;
    case 'wedge': {
      const s = new THREE.Shape();
      s.moveTo(0, 0);
      s.lineTo(1, 0);
      s.lineTo(0, 1);
      s.closePath();
      g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
      g.translate(-0.5, -0.5, -0.5);
      break;
    }
    default:
      g = new THREE.BoxGeometry(1, 1, 1);
  }
  if (g.index) g = g.toNonIndexed();
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  attachFaces(g, type === 'ball' ? sphereFaces(10, 7) : null);
  return g;
}

export function makeGeometry(type, size = [1, 1, 1], texScale = 2) {
  const g = unit(type);
  g.scale(size[0], size[1], size[2]);
  refreshGeometry(g, texScale);
  return g;
}

// box-projected UVs so patterns keep the same size on every face and every part
export function autoUV(g, scale = 2) {
  const p = g.attributes.position;
  const n = g.attributes.normal;
  let uv = g.attributes.uv;
  if (!uv || uv.count !== p.count) {
    uv = new THREE.BufferAttribute(new Float32Array(p.count * 2), 2);
    g.setAttribute('uv', uv);
  }
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i));
    const ay = Math.abs(n.getY(i));
    const az = Math.abs(n.getZ(i));
    let u, v;
    if (ax >= ay && ax >= az) {
      u = p.getZ(i);
      v = p.getY(i);
    } else if (ay >= az) {
      u = p.getX(i);
      v = p.getZ(i);
    } else {
      u = p.getX(i);
      v = p.getY(i);
    }
    uv.setXY(i, u * scale, v * scale);
  }
  uv.needsUpdate = true;
}

export function refreshGeometry(g, texScale = 2) {
  g.attributes.position.needsUpdate = true;
  g.computeVertexNormals(); // non-indexed => flat normals
  autoUV(g, texScale);
  g.computeBoundingBox();
  g.computeBoundingSphere();
}

export function geometrySize(g) {
  g.computeBoundingBox();
  const s = new THREE.Vector3();
  g.boundingBox.getSize(s);
  return [Math.max(s.x, 0.02), Math.max(s.y, 0.02), Math.max(s.z, 0.02)];
}

export function bakeScale(g, s, texScale) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * s.x, p.getY(i) * s.y, p.getZ(i) * s.z);
  refreshGeometry(g, texScale);
}

// Mirror across x=0 (in the shared parent space). Swapping vertices 1 and 2 of
// each triangle keeps the faces pointing outward.
const perm = (i) => {
  const j = i % 3;
  return j === 0 ? i : j === 1 ? i + 1 : i - 1;
};

export function mirrorInto(dst, src, texScale) {
  const sp = src.attributes.position;
  const dp = dst.attributes.position;
  for (let i = 0; i < sp.count; i++) {
    const j = perm(i);
    dp.setXYZ(i, -sp.getX(j), sp.getY(j), sp.getZ(j));
  }
  ensureFaces(src);
  if (!dst.attributes.face || dst.attributes.face.count !== sp.count) dst.setAttribute('face', src.attributes.face.clone());
  else dst.attributes.face.array.set(src.attributes.face.array);
  refreshGeometry(dst, texScale);
}

export function mirroredGeometry(src, texScale) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(src.attributes.position.count * 3), 3));
  mirrorInto(g, src, texScale);
  return g;
}

// ---- loop cut: slice every triangle with the plane (axis = c) ----
// axis 0/1/2 = local x/y/z. New dots appear wherever the plane crosses an edge,
// so you get a ring of dots you can drag. Winding order is kept.
const EPS = 1e-5;
function clipPoly(tri, d, side, axis, c) {
  const res = [];
  for (let i = 0; i < 3; i++) {
    const a = tri[i];
    const b = tri[(i + 1) % 3];
    const da = d[i] * side;
    const db = d[(i + 1) % 3] * side;
    if (da >= -EPS) res.push(a);
    if ((da > EPS && db < -EPS) || (da < -EPS && db > EPS)) {
      const t = da / (da - db);
      const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      q[axis] = c;
      res.push(q);
    }
  }
  return res;
}

// ---- faces as whole polygons, so a quad is cut as a quad (no stray dot where a triangle diagonal crosses the cut)
const PK = (x, y, z) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
// one ordered loop of corner positions per face id, or null when a face is not one simple loop
function facePolys(g) {
  const p = g.attributes.position;
  const fa = g.attributes.face;
  const byFace = new Map();
  for (let t = 0; t < p.count / 3; t++) {
    const id = fa.getX(t * 3);
    if (!byFace.has(id)) byFace.set(id, []);
    byFace.get(id).push(t);
  }
  const polys = new Map();
  for (const [id, tl] of byFace) {
    const pos = new Map();
    const edges = new Map(); // "a>b" -> [a, b]
    for (const t of tl) {
      const ks = [0, 1, 2].map((k) => {
        const x = p.getX(t * 3 + k);
        const y = p.getY(t * 3 + k);
        const z = p.getZ(t * 3 + k);
        const key = PK(x, y, z);
        if (!pos.has(key)) pos.set(key, [x, y, z]);
        return key;
      });
      for (let k = 0; k < 3; k++) edges.set(ks[k] + '>' + ks[(k + 1) % 3], [ks[k], ks[(k + 1) % 3]]);
    }
    const next = new Map();
    let bad = false;
    let nb = 0;
    for (const [, [a0, b0]] of edges) {
      if (edges.has(b0 + '>' + a0)) continue; // inside the face
      nb++;
      if (next.has(a0)) bad = true;
      next.set(a0, b0);
    }
    if (bad || !nb) {
      polys.set(id, null);
      continue;
    }
    const start = next.keys().next().value;
    const loop = [start];
    let cur = next.get(start);
    while (cur !== start && loop.length <= nb) {
      loop.push(cur);
      cur = next.get(cur);
      if (cur === undefined) break;
    }
    polys.set(id, cur === start && loop.length === nb ? loop.map((k) => pos.get(k)) : null);
  }
  return { polys, byFace };
}
function clipLoop(poly, axis, c, side) {
  const res = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = (a[axis] - c) * side;
    const db = (b[axis] - c) * side;
    if (da >= -EPS) res.push(a);
    if ((da > EPS && db < -EPS) || (da < -EPS && db > EPS)) {
      const t = da / (da - db);
      const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      q[axis] = c;
      res.push(q);
    }
  }
  return res;
}
// polygon -> triangles with the same winding as the polygon
function triangulate(poly) {
  const n = poly.length;
  if (n < 3) return [];
  if (n === 3) return [poly];
  const N = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    N.x += (a[1] - b[1]) * (a[2] + b[2]);
    N.y += (a[2] - b[2]) * (a[0] + b[0]);
    N.z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  if (N.lengthSq() < 1e-14) return [];
  N.normalize();
  const u = Math.abs(N.x) < 0.9 ? new THREE.Vector3(1, 0, 0).cross(N).normalize() : new THREE.Vector3(0, 1, 0).cross(N).normalize();
  const v = N.clone().cross(u);
  const flat = poly.map((q) => new THREE.Vector2(q[0] * u.x + q[1] * u.y + q[2] * u.z, q[0] * v.x + q[1] * v.y + q[2] * v.z));
  const idx = THREE.ShapeUtils.triangulateShape(flat, []);
  return idx.map(([i, j, k]) => {
    const t = [poly[i], poly[j], poly[k]];
    const nn = new THREE.Vector3(t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]).cross(new THREE.Vector3(t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]));
    return nn.dot(N) < 0 ? [t[0], t[2], t[1]] : t;
  });
}

// the lines where the plane crosses the faces, for the live preview: [[a, b], ...]
export function cutSegments(g, axis, c) {
  ensureFaces(g);
  const { polys } = facePolys(g);
  const segs = [];
  for (const [, poly] of polys) {
    if (!poly) continue;
    const d = poly.map((v) => v[axis] - c);
    if (!(d.some((x) => x < -EPS) && d.some((x) => x > EPS))) continue;
    const hit = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const da = d[i];
      const db = d[(i + 1) % poly.length];
      if ((da > EPS && db < -EPS) || (da < -EPS && db > EPS)) {
        const t = da / (da - db);
        const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        q[axis] = c;
        hit.push(q);
      } else if (Math.abs(da) <= EPS) hit.push(a);
    }
    if (hit.length >= 2) segs.push([hit[0], hit[hit.length - 1]]);
  }
  return segs;
}

export function sliceGeometry(g, axis, c, texScale) {
  ensureFaces(g);
  const p = g.attributes.position;
  const fa = g.attributes.face;
  const { polys, byFace } = facePolys(g);
  const tri = (t) => [0, 1, 2].map((k) => [p.getX(t * 3 + k), p.getY(t * 3 + k), p.getZ(t * 3 + k)]);
  // which faces end up on both sides
  let maxId = -1;
  const farId = new Map();
  for (const [id, tl] of byFace) {
    maxId = Math.max(maxId, id);
    let neg = false;
    let pos = false;
    for (const t of tl) for (const v of tri(t)) {
      if (v[axis] - c < -EPS) neg = true;
      if (v[axis] - c > EPS) pos = true;
    }
    if (neg && pos) farId.set(id, null);
  }
  for (const id of farId.keys()) farId.set(id, ++maxId);
  const out = [];
  const outFace = [];
  for (const [id, tl] of byFace) {
    if (!farId.has(id)) {
      for (const t of tl) {
        out.push(...tri(t));
        outFace.push(id);
      }
      continue;
    }
    const poly = polys.get(id);
    if (poly) {
      // cut the whole polygon: a quad becomes two quads
      for (const side of [-1, 1]) {
        const pid = side === 1 ? farId.get(id) : id;
        for (const t of triangulate(clipLoop(poly, axis, c, side))) {
          out.push(...t);
          outFace.push(pid);
        }
      }
      continue;
    }
    // odd faces (holes etc): cut triangle by triangle
    for (const t of tl) {
      const tr = tri(t);
      const d = tr.map((v) => v[axis] - c);
      if (d.every((x) => x >= -EPS) || d.every((x) => x <= EPS)) {
        out.push(...tr);
        outFace.push(d.some((x) => x > EPS) ? farId.get(id) : id);
        continue;
      }
      for (const side of [-1, 1]) {
        const pl = clipPoly(tr, d, side, axis, c);
        for (let k = 1; k < pl.length - 1; k++) {
          out.push(pl[0], pl[k], pl[k + 1]);
          outFace.push(side === 1 ? farId.get(id) : id);
        }
      }
    }
  }
  const arr = new Float32Array(out.length * 3);
  out.forEach((v, i) => arr.set(v, i * 3));
  const ng = new THREE.BufferGeometry();
  ng.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  const fArr = new Float32Array(out.length);
  outFace.forEach((id, t) => fArr.fill(id, t * 3, t * 3 + 3));
  ng.setAttribute('face', new THREE.BufferAttribute(fArr, 1));
  refreshGeometry(ng, texScale);
  ng.userData.farIds = farId; // old face id -> new id of its far half
  return ng;
}

// where to cut next: the middle of the widest gap between existing dots
export function gapMiddle(g, axis) {
  const p = g.attributes.position;
  const vals = new Set();
  for (let i = 0; i < p.count; i++) vals.add(Math.round([p.getX(i), p.getY(i), p.getZ(i)][axis] * 1e4) / 1e4);
  const s = [...vals].sort((a, b) => a - b);
  if (s.length < 2) return s[0] || 0;
  let best = 0;
  let mid = (s[0] + s[1]) / 2;
  for (let i = 1; i < s.length; i++) {
    if (s[i] - s[i - 1] > best + 1e-6) {
      best = s[i] - s[i - 1];
      mid = (s[i] + s[i - 1]) / 2;
    }
  }
  return mid;
}

// group vertices that sit at the same spot so one handle moves them all
export function groupVertices(g) {
  const p = g.attributes.position;
  const map = new Map();
  for (let i = 0; i < p.count; i++) {
    const k = `${Math.round(p.getX(i) * 1000)},${Math.round(p.getY(i) * 1000)},${Math.round(p.getZ(i) * 1000)}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(i);
  }
  return [...map.values()];
}
