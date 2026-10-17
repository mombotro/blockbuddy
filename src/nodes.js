import * as THREE from 'three';
import { makeGeometry, mirroredGeometry, mirrorInto, refreshGeometry, shapeLabel } from './geom.js';
import { makeMaterial } from './textures.js';
import { attachFaces, facesToTris, trisToFaces } from './editmesh.js';

// A model is a tree of nodes:
//   joint = empty Object3D (a bone you can pose)
//   part  = Mesh (a shape). Parts can sit under joints or under other parts.
// Everything else (markers, outlines) is a "helper" and never saved/exported.

export const flags = { bones: false };
export const registry = new Map();
let counter = 1;
const nid = () => 'n' + counter++;
const bump = (id) => {
  const n = parseInt(String(id).slice(1), 10);
  if (n >= counter) counter = n + 1;
};
export const resetRegistry = () => registry.clear();
export const isNode = (o) => !!(o && o.userData && o.userData.kind);
export const isPart = (o) => !!o && o.userData && o.userData.kind === 'part';
export const isJoint = (o) => !!o && o.userData && o.userData.kind === 'joint';
export const byId = (id) => (id ? registry.get(id) : null);
export const twinOf = (n) => (n ? byId(n.userData.twin) : null);
export const kids = (n) => n.children.filter(isNode);

const nameCounts = {};
const nextName = (type) => {
  nameCounts[type] = (nameCounts[type] || 0) + 1;
  return `${shapeLabel(type)} ${nameCounts[type]}`;
};
export const swapSide = (n) =>
  /Left/.test(n) ? n.replace('Left', 'Right') : /Right/.test(n) ? n.replace('Right', 'Left') : n + ' mirror';

// ---------- mirror math (mirror plane is x = 0) ----------
const MX = new THREE.Matrix4().makeScale(-1, 1, 1);
export function worldOf(n) {
  n.updateWorldMatrix(true, false);
  return n.matrixWorld.clone();
}
export function mirroredWorld(n) {
  return MX.clone().multiply(worldOf(n)).multiply(MX);
}
export function setWorld(n, W) {
  const p = n.parent;
  p.updateWorldMatrix(true, false);
  const L = p.matrixWorld.clone().invert().multiply(W);
  L.decompose(n.position, n.quaternion, n.scale);
}
export const worldPos = (n) => {
  n.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(n.matrixWorld);
};

// ---------- joint markers (the orange dots) ----------
let markerGeo, markerMat, lineMat;
function attachMarker(j) {
  markerGeo = markerGeo || new THREE.SphereGeometry(0.03, 12, 8);
  markerMat = markerMat || new THREE.MeshBasicMaterial({ color: 0xff9f1c, depthTest: false, transparent: true });
  lineMat = lineMat || new THREE.LineBasicMaterial({ color: 0xff9f1c, depthTest: false, transparent: true });
  const m = new THREE.Mesh(markerGeo, markerMat.clone());
  m.userData = { helper: true, markerFor: j };
  m.renderOrder = 20;
  m.visible = flags.bones;
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const line = new THREE.Line(lg, lineMat);
  line.userData = { helper: true };
  line.renderOrder = 19;
  line.frustumCulled = false;
  m.add(line);
  m.userData.line = line;
  j.add(m);
  j.userData.marker = m;
}
export function updateBoneLine(j) {
  const m = j.userData.marker;
  if (!m) return;
  const a = m.userData.line.geometry.attributes.position;
  if (isNode(j.parent)) {
    const v = j.position.clone().negate().applyQuaternion(j.quaternion.clone().invert());
    a.setXYZ(1, v.x, v.y, v.z);
  } else a.setXYZ(1, 0, 0, 0);
  a.needsUpdate = true;
}
export function setMarkerColor(j, hex) {
  if (j.userData.marker) j.userData.marker.material.color.set(hex);
}

// ---------- creating nodes ----------
function register(n) {
  registry.set(n.userData.id, n);
}

export function makeJoint(name, parent, wp) {
  const j = new THREE.Object3D();
  j.name = name;
  j.userData = { kind: 'joint', id: nid(), twin: null };
  parent.add(j);
  parent.updateWorldMatrix(true, false);
  j.position.copy(parent.worldToLocal(new THREE.Vector3(wp[0], wp[1], wp[2])));
  attachMarker(j);
  updateBoneLine(j);
  register(j);
  return j;
}

export function makePart(type, parent, wp, size, opts = {}) {
  const o = { color: '#e5e7eb', pattern: 'none', image: null, texScale: 2, rot: [0, 0, 0], name: null, ...opts };
  const mesh = new THREE.Mesh(makeGeometry(type, size, o.texScale), makeMaterial(o));
  mesh.name = o.name || nextName(type);
  mesh.userData = {
    kind: 'part',
    id: nid(),
    type,
    color: o.color,
    pattern: o.pattern,
    image: o.image,
    texScale: o.texScale,
    twin: null,
    faceColors: {},
  };
  mesh.rotation.set(...o.rot.map((d) => (d * Math.PI) / 180));
  parent.add(mesh);
  parent.updateWorldMatrix(true, false);
  mesh.position.copy(parent.worldToLocal(new THREE.Vector3(wp[0], wp[1], wp[2])));
  register(mesh);
  return mesh;
}

export function setPaint(n, props) {
  Object.assign(n.userData, props);
  n.material.dispose();
  n.material = makeMaterial(n.userData);
  if ('texScale' in props) refreshGeometry(n.geometry, n.userData.texScale);
  const t = twinOf(n);
  if (t) {
    Object.assign(t.userData, props);
    t.material.dispose();
    t.material = makeMaterial(t.userData);
    if ('texScale' in props) refreshGeometry(t.geometry, t.userData.texScale);
  }
}

export function setShape(n, type, size) {
  n.geometry.dispose();
  n.geometry = makeGeometry(type, size, n.userData.texScale);
  n.userData.type = type;
  syncTwin(n, true);
}

// Make a mirrored copy of `src` (and its add-ons) on the other side, linked as twins.
export function mirrorSubtree(src, newParent) {
  const u = src.userData;
  let c;
  if (u.kind === 'joint') {
    c = new THREE.Object3D();
    c.userData = { kind: 'joint', id: nid(), twin: u.id };
    attachMarker(c);
  } else {
    c = new THREE.Mesh(mirroredGeometry(src.geometry, u.texScale), makeMaterial(u));
    c.userData = {
      kind: 'part',
      id: nid(),
      type: u.type,
      color: u.color,
      pattern: u.pattern,
      image: u.image,
      texScale: u.texScale,
      twin: u.id,
      faceColors: { ...(u.faceColors || {}) },
    };
  }
  c.name = swapSide(src.name);
  u.twin = c.userData.id;
  register(c);
  newParent.add(c);
  setWorld(c, mirroredWorld(src));
  for (const k of kids(src)) if (!k.userData.twin) mirrorSubtree(k, c);
  if (isJoint(c)) updateBoneLine(c);
  return c;
}

// Copy an edit from `n` onto its twin. full=true also rebuilds the shape.
export function syncTwin(n, full = false, carry = false) {
  const t = twinOf(n);
  if (!t) return;
  if (isJoint(n)) {
    // twin joint moves, but whatever hangs off it stays where it is
    const held = carry ? [] : kids(t).map((k) => [k, worldOf(k)]);
    setWorld(t, mirroredWorld(n));
    held.forEach(([k, W]) => setWorld(k, W));
    updateBoneLine(t);
    return;
  }
  setWorld(t, mirroredWorld(n));
  const g = n.geometry;
  const tg = t.geometry;
  if (full || tg.attributes.position.count !== g.attributes.position.count) {
    tg.dispose();
    t.geometry = mirroredGeometry(g, n.userData.texScale);
  } else mirrorInto(tg, g, n.userData.texScale);
}

// is `a` the same node as `b`, or somewhere inside it?
export function isInside(a, b) {
  for (let o = a; o; o = o.parent) if (o === b) return true;
  return false;
}

// Move `n` under `newParent`, keeping it exactly where it is in the world.
export function reparent(n, newParent) {
  const W = worldOf(n);
  newParent.add(n);
  setWorld(n, W);
}

export function unlink(n) {
  const t = twinOf(n);
  if (t) t.userData.twin = null;
  n.userData.twin = null;
}

export function removeNode(n) {
  const t = twinOf(n);
  if (t) t.userData.twin = null;
  n.traverse((o) => {
    if (o.userData && o.userData.id) registry.delete(o.userData.id);
    if (o.geometry && !o.userData.helper) o.geometry.dispose();
  });
  n.parent.remove(n);
}

// ---------- save / load ----------
const r4 = (a) => Array.from(a, (v) => Math.round(v * 10000) / 10000);

export function serializeNode(n) {
  const u = n.userData;
  const d = {
    id: u.id,
    kind: u.kind,
    name: n.name,
    pos: r4(n.position.toArray()),
    quat: r4(n.quaternion.toArray()),
    twin: u.twin || null,
    kids: kids(n).map(serializeNode),
  };
  if (u.kind === 'part') {
    d.type = u.type;
    d.color = u.color;
    d.pattern = u.pattern;
    d.image = u.image;
    d.texScale = u.texScale;
    d.verts = r4(n.geometry.attributes.position.array);
    d.faces = facesToTris(n.geometry);
    if (u.faceColors && Object.keys(u.faceColors).length) d.fcol = u.faceColors;
  }
  return d;
}

export function deserialize(d, parent, opt = {}) {
  const id = opt.fresh ? nid() : d.id;
  if (!opt.fresh) bump(id);
  let n;
  if (d.kind === 'joint') {
    n = new THREE.Object3D();
    n.userData = { kind: 'joint', id, twin: null };
    attachMarker(n);
  } else {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(d.verts), 3));
    // old save files have no face ids: work them out from the shape
    attachFaces(g, d.faces && d.faces.length * 9 === d.verts.length ? trisToFaces(d.faces) : null);
    refreshGeometry(g, d.texScale);
    n = new THREE.Mesh(g, makeMaterial(d));
    n.userData = {
      kind: 'part',
      id,
      type: d.type,
      color: d.color,
      pattern: d.pattern,
      image: d.image || null,
      texScale: d.texScale,
      twin: null,
      faceColors: { ...(d.fcol || {}) },
    };
  }
  if (!opt.fresh) n.userData.twin = d.twin || null;
  n.name = d.name;
  n.position.fromArray(d.pos);
  n.quaternion.fromArray(d.quat);
  parent.add(n);
  register(n);
  for (const k of d.kids || []) deserialize(k, n, opt);
  if (isJoint(n)) updateBoneLine(n);
  return n;
}
