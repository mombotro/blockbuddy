import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import {
  SHAPES,
  refreshGeometry,
  geometrySize,
  bakeScale,
  sliceGeometry,
  gapMiddle,
} from './geom.js';
import { PATTERN_LIST, patternThumb } from './textures.js';
import {
  flags,
  registry,
  resetRegistry,
  isNode,
  isPart,
  isJoint,
  byId,
  twinOf,
  kids,
  worldOf,
  setWorld,
  worldPos,
  makePart,
  makeJoint,
  setPaint,
  setShape,
  mirrorSubtree,
  syncTwin,
  unlink,
  removeNode,
  serializeNode,
  deserialize,
  updateBoneLine,
  setMarkerColor,
  reparent,
  isInside,
} from './nodes.js';
import { STARTERS, posesFor } from './rigs.js';
import { buildTopology, extrudeFaces, extrudeEdge, ensureFaces, keyOf } from './editmesh.js';

const $ = (s) => document.querySelector(s);
const PALETTE = [
  '#ef4444', '#f97316', '#facc15', '#84cc16', '#22c55e', '#14b8a6', '#38bdf8', '#3b82f6',
  '#8b5cf6', '#ec4899', '#ffffff', '#d1d5db', '#6b7280', '#1f2937', '#92400e', '#fcd5b0',
];

// ---------------------------------------------------------------- scene
const canvas = $('#c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe6f4ff);
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
camera.position.set(2.4, 1.7, 3.4);
const orbit = new OrbitControls(camera, canvas);
orbit.target.set(0, 0.7, 0);
orbit.enableDamping = true;
orbit.autoRotateSpeed = 3;
orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

scene.add(new THREE.HemisphereLight(0xffffff, 0x8a9bb0, 1.7));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(3, 5, 4);
scene.add(sun);
const grid = new THREE.GridHelper(10, 20, 0x9fb7c9, 0xc4d6e3);
scene.add(grid);
const mirrorLine = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.002, -5), new THREE.Vector3(0, 0.002, 5)]),
  new THREE.LineBasicMaterial({ color: 0xff6fb5 }),
);
scene.add(mirrorLine);

const model = new THREE.Group();
model.name = 'model';
scene.add(model);

const transform = new TransformControls(camera, canvas);
transform.size = 0.9;
scene.add(transform.getHelper());

function resize() {
  const r = $('#stage').getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(r.height, 1);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe($('#stage'));

// ---------------------------------------------------------------- state
const state = {
  mode: 'build', // build | pose
  tool: 'move', // move | turn | size | points
  emode: 'dot', // inside points: dot | edge | face
  pgizmo: 'move', // inside points: move | turn | size
  selected: null,
  rig: null,
  snap: true,
  bonesUser: false,
  name: 'my-model',
  keepPose: false,
  poseIdx: 0,
  stickNew: false, // new shapes stick onto the picked part
  sticking: null, // id of the part waiting to be stuck onto something
};

let outline = null;
let drag = null;

// ---------------------------------------------------------------- history (undo/redo)
let hist = [];
let hi = -1;
const AUTOSAVE = 'blockbuddy-autosave-v1';

function docJSON() {
  return JSON.stringify({
    app: 'blockbuddy',
    v: 1,
    name: state.name,
    rig: state.rig,
    nodes: kids(model).map(serializeNode),
  });
}
function commit() {
  const snap = docJSON();
  if (hist[hi] === snap) return;
  hist = hist.slice(0, hi + 1);
  hist.push(snap);
  if (hist.length > 80) hist.shift();
  hi = hist.length - 1;
  try {
    localStorage.setItem(AUTOSAVE, snap);
  } catch (e) {
    /* storage full or blocked: fine */
  }
  refresh();
}
function clearModel() {
  setOutline(null);
  clearPoints();
  transform.detach();
  for (const c of [...model.children]) {
    c.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && !o.userData.helper) o.material.dispose?.();
    });
    model.remove(c);
  }
  resetRegistry();
}
function loadDoc(doc, selId = null) {
  clearModel();
  state.rig = doc.rig || null;
  if (doc.name) state.name = doc.name;
  for (const n of doc.nodes) deserialize(n, model);
  state.selected = byId(selId);
  applyBoneVisibility();
}
function undo() {
  if (hi <= 0) return;
  hi--;
  const id = state.selected && state.selected.userData.id;
  loadDoc(JSON.parse(hist[hi]), id);
  refresh();
}
function redo() {
  if (hi >= hist.length - 1) return;
  hi++;
  const id = state.selected && state.selected.userData.id;
  loadDoc(JSON.parse(hist[hi]), id);
  refresh();
}

// ---------------------------------------------------------------- selection / outline / handles
const outlineMat = new THREE.LineBasicMaterial({ color: 0xfbbf24, depthTest: false, transparent: true });
function setOutline(part) {
  if (outline) {
    outline.parent && outline.parent.remove(outline);
    outline.geometry.dispose();
    outline = null;
  }
  if (part && isPart(part)) {
    outline = new THREE.LineSegments(new THREE.EdgesGeometry(part.geometry, 20), outlineMat);
    outline.userData.helper = true;
    outline.renderOrder = 15;
    part.add(outline);
  }
}
// ---------------------------------------------------------------- points mode: dots, edges, faces
// All the dots / edge diamonds / face squares are children of the part (so they follow it).
// Whatever is picked is moved by one gizmo (the "pivot") sitting at its middle.
const HANDLE_COLOR = { dot: 0xffffff, edge: 0x7dd3fc, face: 0x86efac };
const SEL_COLOR = 0xf97316;
const handleGeos = {
  dot: new THREE.SphereGeometry(0.024, 10, 8),
  edge: new THREE.OctahedronGeometry(0.032),
  face: new THREE.BoxGeometry(0.046, 0.046, 0.046),
};
const pivot = new THREE.Object3D();
scene.add(pivot);
let pts = null; // { part, geo, mode, topo, els, root, handles, lines, sel }
let psel = []; // picked elements (indexes into pts.els)

function clearPoints() {
  if (pts) {
    pts.root.parent && pts.root.parent.remove(pts.root);
    pts.root.traverse((o) => {
      if (o.material) o.material.dispose();
      if (o.userData.ownGeo) o.geometry.dispose();
    });
  }
  pts = null;
  psel = [];
}
const posOf = (gi) => {
  const a = pts.part.geometry.attributes.position;
  const i = pts.topo.groups[gi][0];
  return new THREE.Vector3(a.getX(i), a.getY(i), a.getZ(i));
};
function elCenter(el) {
  const c = new THREE.Vector3();
  el.gs.forEach((gi) => c.add(posOf(gi)));
  return c.divideScalar(el.gs.length);
}
const lineMat = (color) => new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
function buildPoints(part) {
  clearPoints();
  ensureFaces(part.geometry);
  const topo = buildTopology(part.geometry);
  const root = new THREE.Group();
  root.userData.helper = true;
  part.add(root);
  const els = topo[state.emode === 'dot' ? 'dots' : state.emode === 'edge' ? 'edges' : 'faces'];
  pts = { part, geo: part.geometry, mode: state.emode, topo, els, root, handles: [], lines: null, sel: null };
  if (state.emode === 'edge') {
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(els.length * 6), 3));
    pts.lines = new THREE.LineSegments(lg, lineMat(HANDLE_COLOR.edge));
    pts.lines.userData = { helper: true, ownGeo: true };
    pts.lines.renderOrder = 25;
    pts.lines.frustumCulled = false;
    root.add(pts.lines);
  }
  els.forEach((el, i) => {
    const m = new THREE.Mesh(
      handleGeos[state.emode],
      new THREE.MeshBasicMaterial({ color: HANDLE_COLOR[state.emode], depthTest: false, transparent: true }),
    );
    m.renderOrder = 30;
    m.userData = { helper: true, pel: i };
    root.add(m);
    pts.handles.push(m);
  });
  updatePoints();
}
// reposition everything after the shape or the picks changed
function updatePoints() {
  if (!pts) return;
  const { els, handles, lines } = pts;
  els.forEach((el, i) => {
    handles[i].position.copy(elCenter(el));
    handles[i].material.color.set(psel.includes(i) ? SEL_COLOR : HANDLE_COLOR[pts.mode]);
    handles[i].scale.setScalar(psel.includes(i) ? 1.35 : 1);
  });
  if (lines) {
    const a = lines.geometry.attributes.position;
    els.forEach((el, i) => {
      const p0 = posOf(el.gs[0]);
      const p1 = posOf(el.gs[1]);
      a.setXYZ(i * 2, p0.x, p0.y, p0.z);
      a.setXYZ(i * 2 + 1, p1.x, p1.y, p1.z);
    });
    a.needsUpdate = true;
  }
  if (pts.sel) {
    pts.root.remove(pts.sel);
    pts.sel.geometry.dispose();
    pts.sel.material.dispose();
    pts.sel = null;
  }
  if (psel.length && pts.mode === 'face') {
    const pos = [];
    const g = pts.part.geometry.attributes.position;
    for (const i of psel)
      for (const t of els[i].tris) for (let k = 0; k < 3; k++) pos.push(g.getX(t * 3 + k), g.getY(t * 3 + k), g.getZ(t * 3 + k));
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    pts.sel = new THREE.Mesh(
      sg,
      new THREE.MeshBasicMaterial({ color: SEL_COLOR, transparent: true, opacity: 0.45, depthTest: false, side: THREE.DoubleSide }),
    );
    pts.sel.renderOrder = 22;
  } else if (psel.length && pts.mode === 'edge') {
    const pos = [];
    for (const i of psel) pos.push(...posOf(els[i].gs[0]).toArray(), ...posOf(els[i].gs[1]).toArray());
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    pts.sel = new THREE.LineSegments(sg, lineMat(SEL_COLOR));
    pts.sel.renderOrder = 26;
    pts.sel.frustumCulled = false;
  }
  if (pts.sel) {
    pts.sel.userData = { helper: true, ownGeo: true };
    pts.root.add(pts.sel);
  }
}
function selectEls(list, additive) {
  if (!pts) return;
  if (!additive) psel = [];
  for (const i of list) {
    const k = psel.indexOf(i);
    if (k >= 0) {
      if (additive) psel.splice(k, 1);
    } else psel.push(i);
  }
  updatePoints();
  attachPivot();
  renderToolbar();
}
const selGroups = () => [...new Set(psel.flatMap((i) => pts.els[i].gs))];
function attachPivot() {
  if (!pts || !psel.length) {
    transform.detach();
    return;
  }
  const gs = selGroups();
  const c = new THREE.Vector3();
  gs.forEach((gi) => c.add(posOf(gi)));
  c.divideScalar(gs.length);
  pts.part.updateWorldMatrix(true, false);
  pivot.position.copy(pts.part.localToWorld(c));
  pivot.quaternion.identity();
  pivot.scale.set(1, 1, 1);
  transform.attach(pivot);
  transform.setMode(state.pgizmo === 'turn' ? 'rotate' : state.pgizmo === 'size' ? 'scale' : 'translate');
  transform.setSpace('world');
}

function select(node) {
  state.selected = node || null;
  if (state.mode === 'pose' && node && isPart(node)) state.selected = nearestJoint(node);
  if (state.selected && isJoint(state.selected) && state.mode === 'build' && state.tool !== 'move') state.tool = 'move';
  refresh();
}
const nearestJoint = (n) => {
  for (let o = n.parent; o && isNode(o); o = o.parent) if (isJoint(o)) return o;
  return null;
};

function applyTool() {
  const n = state.selected;
  setOutline(n);
  if (!(state.mode === 'build' && state.tool === 'points' && n && isPart(n))) clearPoints();
  for (const j of jointsList()) setMarkerColor(j, j === n ? 0xff4d00 : 0xff9f1c);
  transform.setTranslationSnap(state.snap ? 0.05 : null);
  transform.setRotationSnap(state.snap ? THREE.MathUtils.degToRad(15) : null);
  transform.setScaleSnap(state.snap ? 0.1 : null);
  if (!n) {
    transform.detach();
    return;
  }
  if (state.mode === 'pose') {
    transform.attach(n);
    transform.setMode('rotate');
    transform.setSpace('local');
    return;
  }
  if (isJoint(n)) {
    transform.attach(n);
    transform.setMode('translate');
    transform.setSpace('world');
    return;
  }
  if (state.tool === 'points') {
    if (!pts || pts.part !== n || pts.geo !== n.geometry || pts.mode !== state.emode) buildPoints(n);
    else updatePoints();
    attachPivot();
    return;
  }
  transform.attach(n);
  transform.setMode(state.tool === 'turn' ? 'rotate' : state.tool === 'size' ? 'scale' : 'translate');
  transform.setSpace(state.tool === 'move' ? 'world' : 'local');
}

// ---------------------------------------------------------------- gizmo drag handling
transform.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !e.value;
  if (e.value) onDragStart();
  else onDragEnd();
});
transform.addEventListener('objectChange', onObjectChange);

function onDragStart() {
  const o = transform.object;
  drag = { obj: o };
  if (o && isJoint(o) && state.mode === 'build') drag.held = kids(o).map((k) => [k, worldOf(k)]);
  if (o === pivot && pts) {
    pts.part.updateWorldMatrix(true, false);
    drag.pts = { C: pivot.position.clone(), W0: selGroups().map((gi) => [gi, pts.part.localToWorld(posOf(gi))]) };
  }
}
function onObjectChange() {
  const o = transform.object;
  if (!o) return;
  if (o === pivot) return onPivotChange();
  if (state.mode === 'pose') return;
  if (isJoint(o)) {
    if (drag && drag.held) drag.held.forEach(([k, W]) => setWorld(k, W));
    updateBoneLine(o);
    syncTwin(o);
  } else syncTwin(o);
}
function onPivotChange() {
  if (!pts || !drag || !drag.pts) return;
  const part = pts.part;
  part.updateWorldMatrix(true, false);
  const { C, W0 } = drag.pts;
  const a = part.geometry.attributes.position;
  const w = new THREE.Vector3();
  for (const [gi, W] of W0) {
    if (state.pgizmo === 'turn') w.copy(W).sub(C).applyQuaternion(pivot.quaternion).add(C);
    else if (state.pgizmo === 'size') w.copy(W).sub(C).multiply(pivot.scale).add(C);
    else w.copy(W).add(pivot.position).sub(C);
    const l = part.worldToLocal(w.clone());
    for (const i of pts.topo.groups[gi]) a.setXYZ(i, l.x, l.y, l.z);
  }
  refreshGeometry(part.geometry, part.userData.texScale);
  syncTwin(part);
  updatePoints();
  setOutline(part);
}
function onDragEnd() {
  const o = drag && drag.obj;
  drag = null;
  if (!o || state.mode === 'pose') return;
  if (o === pivot) {
    commit();
    attachPivot();
    return;
  }
  if (isPart(o) && !(o.scale.x === 1 && o.scale.y === 1 && o.scale.z === 1)) {
    bakeScale(o.geometry, o.scale, o.userData.texScale);
    o.scale.set(1, 1, 1);
    syncTwin(o, true);
    setOutline(o);
  }
  commit();
}

// ---------------------------------------------------------------- picking
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();
let down = null;
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, onGizmo: !!transform.axis, button: e.button };
});
canvas.addEventListener('pointerup', (e) => {
  if (!down || down.onGizmo || down.button !== 0 || transform.dragging) return;
  if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
  pick(e);
});
function pick(e) {
  const r = canvas.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  if (state.sticking) {
    const part = byId(state.sticking);
    let target = null;
    const ms = jointsList().map((j) => j.userData.marker).filter((m) => m && m.visible);
    const mh = ray.intersectObjects(ms, false)[0];
    if (mh) target = mh.object.userData.markerFor;
    else {
      const parts = [];
      model.traverse((o) => isPart(o) && parts.push(o));
      const ph = ray.intersectObjects(parts, false)[0];
      if (ph) target = ph.object;
    }
    state.sticking = null;
    applyBoneVisibility();
    if (part && target) stickTo(part, target);
    else toast('Nothing picked. Nothing changed.');
    return refresh();
  }
  if (state.tool === 'points' && state.mode === 'build' && pts) {
    const hit = ray.intersectObjects(pts.handles, false)[0];
    if (hit) return selectEls([hit.object.userData.pel], e.shiftKey);
    if (state.emode === 'face') {
      // click right on a face of the shape
      const sh = ray.intersectObject(pts.part, false)[0];
      if (sh) {
        const id = pts.part.geometry.attributes.face.getX(sh.faceIndex * 3);
        const idx = pts.els.findIndex((f) => f.id === id);
        if (idx >= 0) return selectEls([idx], e.shiftKey);
      }
    }
  }
  if (flags.bones) {
    const ms = jointsList().map((j) => j.userData.marker).filter((m) => m && m.visible);
    const hit = ray.intersectObjects(ms, false)[0];
    if (hit) return select(hit.object.userData.markerFor);
  }
  const parts = [];
  model.traverse((o) => isPart(o) && parts.push(o));
  const hit = ray.intersectObjects(parts, false)[0];
  if (hit) return select(hit.object);
  if (state.tool === 'points' && psel.length) return selectEls([], false);
  select(null);
}

// ---------------------------------------------------------------- actions
function jointsList() {
  const a = [];
  model.traverse((o) => isJoint(o) && a.push(o));
  return a;
}
function partCount() {
  let n = 0;
  model.traverse((o) => isPart(o) && n++);
  return n;
}
let paletteIdx = 0;
function addShape(type) {
  const sel = state.selected;
  if (state.stickNew && sel && isPart(sel)) return stickOn(type);
  const parent = sel && isJoint(sel) ? sel : model;
  const free = parent === model;
  const n = kids(model).filter(isPart).length;
  const wp = free ? [((n % 5) - 2) * 0.6, 0.25, 0] : worldPos(parent).toArray().map((v, i) => (i === 1 ? v + 0.1 : v));
  const p = makePart(type, parent, wp, [0.5, 0.5, 0.5], { color: PALETTE[paletteIdx++ % 10] });
  state.tool = 'move';
  select(p);
  commit();
}
function stickOn(type) {
  const par = state.selected;
  if (!par || !isPart(par)) return;
  const sz = geometrySize(par.geometry);
  const wp = worldPos(par).toArray();
  wp[1] += sz[1] / 2 + 0.08;
  const c = makePart(type, par, wp, [0.16, 0.16, 0.16], { color: PALETTE[paletteIdx++ % 10] });
  // a part with a twin: the add-on gets a mirrored twin on the other side, too
  const pt = twinOf(par);
  if (pt) mirrorSubtree(c, pt);
  state.tool = 'move';
  select(c);
  commit();
}
// Move a part under another part or bone. It stays where it is; from now on it follows its new parent.
function stickTo(part, target) {
  if (isInside(target, part)) return toast("A part can't stick to itself or to something stuck on it.");
  const twin = twinOf(part);
  reparent(part, target);
  if (twin) {
    // the twin goes to the mirror of the new parent (or the same parent if that one is in the middle)
    const tt = target === model ? model : twinOf(target) || target;
    if (isInside(tt, twin) || isInside(tt, part)) unlink(part);
    else reparent(twin, tt);
  }
  select(part);
  toast(`Stuck to ${target === model ? 'nothing (free)' : target.name}! 📎`);
  commit();
}
function startStick() {
  const n = state.selected;
  if (!n || !isPart(n)) return;
  state.sticking = n.userData.id;
  applyBoneVisibility();
  refresh();
}
function cancelStick() {
  state.sticking = null;
  applyBoneVisibility();
  refresh();
}
// Extrude: push picked faces out (with side walls), or pull a flap out of one edge.
function extrudeSel() {
  if (!pts || !psel.length) return toast('Pick a face or an edge first! ▣');
  const part = pts.part;
  const g = part.geometry;
  const sz = geometrySize(g);
  const dist = Math.max(0.05, 0.25 * Math.min(...sz));
  let res;
  let faceIds = null;
  if (state.emode === 'face') {
    faceIds = new Set(psel.map((i) => pts.els[i].id));
    res = extrudeFaces(g, faceIds, dist);
  } else if (state.emode === 'edge') {
    if (psel.length !== 1) return toast('Extrude one edge at a time.');
    const [a, b] = pts.els[psel[0]].gs;
    res = extrudeEdge(g, posOf(a), posOf(b), dist);
  } else return toast('Extrude works on faces ▣ and edges ➖. Switch the mode below.');
  if (!res) return;
  const ng = new THREE.BufferGeometry();
  ng.setAttribute('position', new THREE.BufferAttribute(res.position, 3));
  ng.setAttribute('face', new THREE.BufferAttribute(res.face, 1));
  refreshGeometry(ng, part.userData.texScale);
  g.dispose();
  part.geometry = ng;
  syncTwin(part, true);
  commit(); // rebuilds the handles for the new shape
  if (pts) {
    if (faceIds) selectEls(pts.els.map((el, i) => (faceIds.has(el.id) ? i : -1)).filter((i) => i >= 0), false);
    else {
      const i = pts.els.findIndex((el) => {
        const ks = el.gs.map((gi) => keyOf(posOf(gi)));
        return res.keys.every((k) => ks.includes(k));
      });
      if (i >= 0) selectEls([i], false);
    }
  }
  toast('Extruded! Drag the arrows to pull it out. ⬆️');
}
// Loop cut: add a new ring of dots across the width, height or depth of a part.
function sliceSelected(axis) {
  const n = state.selected;
  if (!n || !isPart(n)) return;
  const g = sliceGeometry(n.geometry, axis, gapMiddle(n.geometry, axis), n.userData.texScale);
  n.geometry.dispose();
  n.geometry = g;
  syncTwin(n, true);
  state.tool = 'points';
  toast('New ring of dots! Drag them to reshape. ✏️');
  commit();
}

function startWith(id) {
  if (partCount() > 0 && !confirm('Start something new? Your current model will be replaced. (You can undo.)')) return;
  clearModel();
  const st = STARTERS[id];
  st.build(model);
  state.rig = st.rig;
  state.name = id;
  state.selected = null;
  state.mode = 'build';
  state.tool = 'move';
  applyBoneVisibility();
  frameModel();
  commit();
  refresh();
}
function newBlank() {
  if (partCount() > 0 && !confirm('Start over with an empty scene? (You can undo.)')) return;
  clearModel();
  state.rig = null;
  state.selected = null;
  state.mode = 'build';
  applyBoneVisibility();
  commit();
}
function frameModel() {
  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3()).length();
  orbit.target.copy(c);
  camera.position.copy(c).add(new THREE.Vector3(0.6, 0.35, 1).normalize().multiplyScalar(Math.max(s * 1.6, 1.5)));
}
function duplicate() {
  const n = state.selected;
  if (!n || !isPart(n)) return;
  const d = serializeNode(n);
  const c = deserialize(d, n.parent, { fresh: true });
  c.position.x += 0.15;
  c.name = n.name + ' copy';
  select(c);
  commit();
}
function del() {
  const n = state.selected;
  if (!n || !isPart(n)) return;
  state.selected = null;
  removeNode(n);
  commit();
}
function makeMirror() {
  const n = state.selected;
  if (!n || !isPart(n) || n.userData.twin) return;
  if (Math.abs(worldPos(n).x) < 0.03) return toast('This part is in the middle. Move it to one side first, then mirror it!');
  const pt = isNode(n.parent) ? twinOf(n.parent) : null;
  const m = mirrorSubtree(n, pt || n.parent);
  toast('Mirror twin made! Change one, the other follows. 🪞');
  select(n);
  void m;
  commit();
}
function swapShapeTo(type) {
  const n = state.selected;
  if (!n || !isPart(n)) return;
  setShape(n, type, geometrySize(n.geometry));
  setOutline(n);
  select(n);
  commit();
}

// ---------------------------------------------------------------- pose mode
function setMode(m) {
  if (m === state.mode) return;
  if (m === 'pose') {
    if (!state.rig) {
      toast('Pose needs a buddy with bones! Pick a Person, Dog or Bird first. 🐶');
      return;
    }
    jointsList().forEach((j) => (j.userData.rest = { p: j.position.clone(), q: j.quaternion.clone() }));
    state.mode = 'pose';
    state.poseIdx = 0;
    state.selected = state.selected && isPart(state.selected) ? nearestJoint(state.selected) : state.selected;
  } else {
    restoreRest();
    state.mode = 'build';
  }
  applyBoneVisibility();
  refresh();
}
function restoreRest() {
  jointsList().forEach((j) => {
    if (j.userData.rest) {
      j.position.copy(j.userData.rest.p);
      j.quaternion.copy(j.userData.rest.q);
    }
  });
}
function applyPose(i) {
  const pose = posesFor(state.rig)[i];
  if (!pose) return;
  state.poseIdx = i;
  restoreRest();
  const byName = new Map(jointsList().map((j) => [j.name, j]));
  const e = new THREE.Euler();
  for (const [name, deg] of Object.entries(pose.rot)) {
    const j = byName.get(name);
    if (!j) continue;
    e.set(...deg.map((d) => THREE.MathUtils.degToRad(d)));
    j.quaternion.copy(j.userData.rest.q).multiply(new THREE.Quaternion().setFromEuler(e));
  }
  const root = byName.get('Hips');
  if (root && pose.drop) root.position.y = root.userData.rest.p.y + pose.drop;
  renderLeft();
}
function applyBoneVisibility() {
  flags.bones = state.mode === 'pose' || state.bonesUser || !!state.sticking;
  for (const j of jointsList()) if (j.userData.marker) j.userData.marker.visible = flags.bones;
}

// ---------------------------------------------------------------- export / save / load
function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const safeName = () => (state.name || 'model').trim().replace(/[^a-z0-9_-]+/gi, '_') || 'model';
// While exporting: names lose spaces (so game code can use getObjectByName) and
// userData is emptied (ours holds editor-only data, some of it circular).
function nameForExport(root) {
  const saved = [];
  root.traverse((o) => {
    if (!isNode(o)) return;
    saved.push([o, o.name, o.userData]);
    o.name = o.name.replace(/[^A-Za-z0-9_-]+/g, '_');
    o.userData = {};
  });
  return saved;
}
function restoreNames(saved) {
  for (const [o, name, ud] of saved) {
    o.name = name;
    o.userData = ud;
  }
}
async function exportGLB() {
  if (partCount() === 0) return toast('Nothing to export yet. Add a shape first!');
  const posed = state.mode === 'pose' && !state.keepPose;
  const saved = jointsList().map((j) => [j, j.position.clone(), j.quaternion.clone()]);
  if (posed) restoreRest();
  const hidden = [];
  model.traverse((o) => {
    if (o.userData.helper && o.visible) {
      o.visible = false;
      hidden.push(o);
    }
  });
  const oldName = model.name;
  model.name = safeName();
  const savedNames = nameForExport(model);
  try {
    const glb = await new GLTFExporter().parseAsync(model, { binary: true, onlyVisible: true });
    download(new Blob([glb], { type: 'model/gltf-binary' }), safeName() + '.glb');
    toast(`Saved ${safeName()}.glb — ready for three.js! 🎮`);
  } catch (err) {
    console.error(err);
    toast('Export had a problem: ' + err.message);
  } finally {
    restoreNames(savedNames);
    model.name = oldName;
    hidden.forEach((o) => (o.visible = true));
    if (posed) saved.forEach(([j, p, q]) => (j.position.copy(p), j.quaternion.copy(q)));
  }
}
function saveProject() {
  // save the starting pose, not whatever pose is on screen
  const posed = state.mode === 'pose';
  if (posed) restoreRest();
  const json = docJSON();
  if (posed) applyPose(state.poseIdx);
  download(new Blob([json], { type: 'application/json' }), safeName() + '.blockbuddy.json');
  toast('Project saved! 💾');
}
function openProject(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const doc = JSON.parse(fr.result);
      if (doc.app !== 'blockbuddy') throw new Error('not a BlockBuddy file');
      state.mode = 'build';
      state.selected = null;
      loadDoc(doc);
      frameModel();
      commit();
      refresh();
    } catch (e) {
      toast("Couldn't open that file: " + e.message);
    }
  };
  fr.readAsText(file);
}

// ---------------------------------------------------------------- camera helpers
function viewFrom(dir) {
  const d = camera.position.distanceTo(orbit.target);
  camera.position.copy(orbit.target).add(dir.clone().normalize().multiplyScalar(d));
}
const VIEWS = {
  front: new THREE.Vector3(0, 0.15, 1),
  side: new THREE.Vector3(1, 0.15, 0),
  back: new THREE.Vector3(0, 0.15, -1),
  top: new THREE.Vector3(0.001, 1, 0.001),
};

// ---------------------------------------------------------------- UI
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const shapeBtns = (act) =>
  SHAPES.map(([id, label, icon]) => `<button class="tile" data-act="${act}:${id}"><span>${icon}</span>${label}</button>`).join('');

function renderTop() {
  $('#tab-build').classList.toggle('on', state.mode === 'build');
  $('#tab-pose').classList.toggle('on', state.mode === 'pose');
  $('#undoBtn').disabled = hi <= 0;
  $('#redoBtn').disabled = hi >= hist.length - 1;
  const inp = $('#projName');
  if (document.activeElement !== inp) inp.value = state.name;
}

function renderLeft() {
  const el = $('#left');
  if (state.mode === 'pose') {
    const poses = posesFor(state.rig);
    el.innerHTML = `
      <h3>Pick a pose</h3>
      <div class="grid2">${poses
        .map(
          (p, i) =>
            `<button class="tile ${i === state.poseIdx ? 'on' : ''}" data-act="pose:${i}"><span>${p.icon}</span>${p.name}</button>`,
        )
        .join('')}</div>
      <p class="tip">Click a body part, then drag the colored rings to bend it.</p>
      <label class="check"><input type="checkbox" id="keepPose" ${state.keepPose ? 'checked' : ''}> Save the game file in this pose</label>
      <p class="tip small">Off = game file keeps the starting pose, so your game can animate it.</p>`;
    return;
  }
  el.innerHTML = `
    <h3>Add a shape</h3>
    <div class="grid3">${shapeBtns('add')}</div>
    <h3>Start with…</h3>
    <div class="grid3">${Object.entries(STARTERS)
      .map(([id, s]) => `<button class="tile" data-act="start:${id}"><span>${s.icon}</span>${s.label}</button>`)
      .join('')}</div>
    <h3>Helpers</h3>
    <label class="check"><input type="checkbox" id="stickNewChk" ${state.stickNew ? 'checked' : ''}> New shapes stick onto the one I picked</label>
    <label class="check"><input type="checkbox" id="snapChk" ${state.snap ? 'checked' : ''}> Snap to grid</label>
    <label class="check"><input type="checkbox" id="bonesChk" ${state.bonesUser ? 'checked' : ''}> Show bones (orange dots)</label>`;
}

function renderToolbar() {
  const n = state.selected;
  const el = $('#toolbar');
  let html = '';
  if (state.sticking) {
    const p = byId(state.sticking);
    html = `<span class="label">📎 Click what to stick “${esc(p ? p.name : '')}” onto (a shape or an orange bone)</span><button data-act="cancelstick">Cancel</button>`;
  } else if (state.mode === 'pose') {
    html = n
      ? `<span class="label">🦴 ${esc(n.name)} — drag the rings to bend</span>`
      : `<span class="label">Click a body part to bend it</span>`;
  } else if (!n) {
    html = `<span class="label">👆 Click a shape to pick it</span>`;
  } else if (isJoint(n)) {
    html = `<span class="label">🦴 ${esc(n.name)} — drag arrows to move the bone</span>`;
  } else if (state.tool === 'points') {
    const em = (id, icon, l) =>
      `<button class="tool ${state.emode === id ? 'on' : ''}" data-act="emode:${id}"><span>${icon}</span>${l}</button>`;
    const gz = (id, icon, l) =>
      `<button class="tool ${state.pgizmo === id ? 'on' : ''}" data-act="pgz:${id}"><span>${icon}</span>${l}</button>`;
    const can = pts && psel.length && state.emode !== 'dot';
    const hint = psel.length
      ? `${psel.length} picked`
      : state.emode === 'face' ? 'Click a face' : state.emode === 'edge' ? 'Click a diamond' : 'Click a dot';
    html =
      `<button class="tool" data-act="tool:move"><span>◀</span>Done</button><i class="sep"></i>` +
      em('dot', '⚪', 'Dots') + em('edge', '➖', 'Edges') + em('face', '▣', 'Faces') +
      `<i class="sep"></i>` +
      gz('move', '↔️', 'Move') + gz('turn', '🔄', 'Turn') + gz('size', '⤡', 'Size') +
      `<i class="sep"></i><button class="tool" data-act="extrude" ${can ? '' : 'disabled'}><span>⬆️</span>Extrude</button>` +
      `<span class="label full">${hint} · Shift = pick more</span>`;
  } else {
    const t = (id, icon, label) =>
      `<button class="tool ${state.tool === id ? 'on' : ''}" data-act="tool:${id}"><span>${icon}</span>${label}</button>`;
    html =
      t('move', '↔️', 'Move') +
      t('turn', '🔄', 'Turn') +
      t('size', '⤡', 'Size') +
      t('points', '✏️', 'Points');
  }
  el.innerHTML = html;
  el.classList.toggle('hidden', false);
}

function renderRight() {
  const n = state.selected;
  const el = $('#right');
  if (!n) {
    el.innerHTML = `<h3>Nothing picked</h3><p class="tip">Click any shape in the picture to change its color, pattern and shape.</p>
      <p class="tip">🖱️ Left-drag to spin around.<br>🖱️ Right-drag to slide.<br>🖱️ Scroll to zoom.</p>
      <p class="tip">The pink line on the floor is the <b>mirror line</b>. 🪞</p>`;
    return;
  }
  if (isJoint(n)) {
    const t = twinOf(n);
    el.innerHTML = `<h3>🦴 ${esc(n.name)}</h3>
      <p class="tip">This is a <b>bone joint</b>. Parts bend around it when you pose.</p>
      <p class="tip">Move it to where the bend should be. The shapes stay put.</p>
      ${t ? `<p class="tip">🔗 Linked with <b>${esc(t.name)}</b></p>` : ''}
      <p class="tip">Tip: pick this bone, then press <b>Add a shape</b> to stick a new shape to it.</p>`;
    return;
  }
  if (state.mode === 'pose') {
    el.innerHTML = '';
    return;
  }
  const u = n.userData;
  const t = twinOf(n);
  const par = isNode(n.parent) ? n.parent : null;
  const swatch = PALETTE.map(
    (c) => `<button class="sw ${u.color.toLowerCase() === c ? 'on' : ''}" style="background:${c}" data-act="color:${c}" title="${c}"></button>`,
  ).join('');
  const pats = PATTERN_LIST.map(
    ([id, label]) =>
      `<button class="pat ${!u.image && u.pattern === id ? 'on' : ''}" data-act="pat:${id}" title="${label}"><img src="${patternThumb(id)}" alt=""><i>${label}</i></button>`,
  ).join('');
  el.innerHTML = `
    <h3>Selected</h3>
    <input id="nameIn" value="${esc(n.name)}" maxlength="40">
    <div class="sec"><b>Shape</b><div class="grid6">${SHAPES.map(
      ([id, label, icon]) =>
        `<button class="mini ${u.type === id ? 'on' : ''}" data-act="shape:${id}" title="${label}">${icon}</button>`,
    ).join('')}</div>
      <p class="tip small">Add more dots — split the:</p>
      <div class="grid3">
        <button class="mini" style="font-size:13px" data-act="slice:1" title="Add a ring of dots across the height">↕ Height</button>
        <button class="mini" style="font-size:13px" data-act="slice:0" title="Add a ring of dots across the width">↔ Width</button>
        <button class="mini" style="font-size:13px" data-act="slice:2" title="Add a ring of dots across the depth">⤢ Depth</button>
      </div></div>
    <div class="sec"><b>Stuck to 📎</b>
      <p class="tip">${par ? `<b>${esc(par.name)}</b><br>Moves when it moves.` : 'Nothing. It floats free.'}</p>
      <button class="wide" data-act="stickto">📎 Stick to something…</button>
      ${par ? `<button class="wide soft" data-act="unstick">✂️ Unstick (float free)</button>` : ''}</div>
    <div class="sec"><b>Mirror 🪞</b>
      ${
        t
          ? `<p class="tip">🔗 Twin: <b>${esc(t.name)}</b><br>Change one and the other follows.</p><button class="wide soft" data-act="unlink">Unlink twins</button>`
          : `<button class="wide" data-act="mirror">🪞 Make a mirror twin</button><p class="tip small">Copies this to the other side of the pink line.</p>`
      }
    </div>
    <div class="sec"><b>Color 🎨</b><div class="swatches">${swatch}</div>
      <label class="check"><span>Any color</span><input type="color" id="customColor" value="${u.color}"></label></div>
    <div class="sec"><b>Pattern</b><div class="pats">${pats}</div>
      <label class="slider"><span>Pattern size</span><input type="range" id="texScale" min="0.5" max="8" step="0.25" value="${u.texScale}"></label>
      <button class="wide soft" data-act="pic">🖼️ Use my own picture</button></div>
    <div class="sec"><b>Stick a shape on</b><div class="grid6">${SHAPES.map(
      ([id, label, icon]) => `<button class="mini" data-act="stick:${id}" title="Stick a ${label} on this">${icon}</button>`,
    ).join('')}</div><p class="tip small">Hats, eyes, buttons… it moves with this part.</p></div>
    <div class="row"><button class="wide soft" data-act="dup">📋 Copy</button><button class="wide danger" data-act="del">🗑️ Delete</button></div>`;
}

function renderWelcome() {
  const w = $('#welcome');
  const empty = partCount() === 0;
  w.classList.toggle('hidden', !empty);
  if (!empty || w.dataset.built) return;
  w.dataset.built = '1';
  w.innerHTML = `<div class="card"><h2>🧱 What do you want to make?</h2>
    <div class="grid3">${Object.entries(STARTERS)
      .map(([id, s]) => `<button class="tile big" data-act="start:${id}"><span>${s.icon}</span>${s.label}</button>`)
      .join('')}</div>
    <p>or <button class="link" data-act="add:box">start with one box</button></p></div>`;
}

function refresh() {
  applyTool();
  renderTop();
  renderLeft();
  renderToolbar();
  renderRight();
  renderWelcome();
}

// ---------------------------------------------------------------- events
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const [act, arg] = b.dataset.act.split(':');
  const n = state.selected;
  switch (act) {
    case 'add': return addShape(arg);
    case 'start': return startWith(arg);
    case 'tool':
      state.tool = arg;
      return refresh();
    case 'mode': return setMode(arg);
    case 'shape': return swapShapeTo(arg);
    case 'stick': return stickOn(arg);
    case 'stickto': return startStick();
    case 'cancelstick': return cancelStick();
    case 'unstick':
      if (n && isPart(n)) stickTo(n, model);
      return;
    case 'slice': return sliceSelected(+arg);
    case 'emode':
      state.emode = arg;
      return refresh();
    case 'pgz':
      state.pgizmo = arg;
      return refresh();
    case 'extrude': return extrudeSel();
    case 'mirror': return makeMirror();
    case 'unlink':
      if (n) unlink(n);
      return commit();
    case 'color':
      if (n) setPaint(n, { color: arg });
      return commit();
    case 'pat':
      if (n) setPaint(n, { pattern: arg, image: null });
      return commit();
    case 'pic': return $('#picFile').click();
    case 'dup': return duplicate();
    case 'del': return del();
    case 'pose': return applyPose(+arg);
    case 'undo': return undo();
    case 'redo': return redo();
    case 'new': return newBlank();
    case 'save': return saveProject();
    case 'open': return $('#openFile').click();
    case 'export': return exportGLB();
    case 'view':
      viewFrom(VIEWS[arg]);
      return;
    case 'spin':
      orbit.autoRotate = !orbit.autoRotate;
      b.classList.toggle('on', orbit.autoRotate);
      return;
    case 'frame': return frameModel();
  }
});
document.addEventListener('input', (e) => {
  const n = state.selected;
  if (e.target.id === 'customColor' && n) setPaint(n, { color: e.target.value });
  if (e.target.id === 'texScale' && n) setPaint(n, { texScale: +e.target.value });
});
document.addEventListener('change', (e) => {
  const n = state.selected;
  const id = e.target.id;
  if (id === 'customColor' || id === 'texScale') commit();
  else if (id === 'nameIn' && n) {
    n.name = e.target.value || n.name;
    commit();
  } else if (id === 'projName') {
    state.name = e.target.value || 'my-model';
    commit();
  } else if (id === 'snapChk') {
    state.snap = e.target.checked;
    applyTool();
  } else if (id === 'stickNewChk') state.stickNew = e.target.checked;
  else if (id === 'bonesChk') {
    state.bonesUser = e.target.checked;
    applyBoneVisibility();
  } else if (id === 'keepPose') state.keepPose = e.target.checked;
  else if (id === 'openFile' && e.target.files[0]) {
    openProject(e.target.files[0]);
    e.target.value = '';
  } else if (id === 'picFile' && e.target.files[0] && n) {
    const fr = new FileReader();
    fr.onload = () => {
      // shrink big photos so the saved file stays small
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, 256 / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(img.width * s));
        cv.height = Math.max(1, Math.round(img.height * s));
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        setPaint(n, { image: cv.toDataURL('image/png'), color: '#ffffff' });
        commit();
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(e.target.files[0]);
    e.target.value = '';
  }
});
window.addEventListener('keydown', (e) => {
  if (/input|textarea/i.test(document.activeElement.tagName) && document.activeElement.type !== 'checkbox') return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
  } else if (e.key === 'Delete' || e.key === 'Backspace') state.tool !== 'points' && del();
  else if (e.key === 'Escape') (state.sticking ? cancelStick() : select(null));
  else if (state.mode === 'build' && state.tool === 'points' && state.selected && !mod && 'mtse123p'.includes(e.key.toLowerCase())) {
    const key = e.key.toLowerCase();
    if (key === 'e') extrudeSel();
    else if ('123'.includes(key)) state.emode = ['dot', 'edge', 'face'][+key - 1];
    else if (key !== 'p') state.pgizmo = { m: 'move', t: 'turn', s: 'size' }[key];
    refresh();
  } else if (state.mode === 'build' && state.selected && isPart(state.selected)) {
    const k = { m: 'move', t: 'turn', s: 'size', p: 'points' }[e.key.toLowerCase()];
    if (k && !mod) {
      state.tool = k;
      refresh();
    }
  }
});

// ---------------------------------------------------------------- loop
function frame() {
  orbit.update();
  if (flags.bones) for (const j of jointsList()) updateBoneLine(j);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- boot
(function boot() {
  resize();
  try {
    const saved = localStorage.getItem(AUTOSAVE);
    if (saved) {
      const doc = JSON.parse(saved);
      if (doc.app === 'blockbuddy' && doc.nodes.length) {
        loadDoc(doc);
        frameModel();
      }
    }
  } catch (e) {
    /* ignore a bad autosave */
  }
  commit();
  refresh();
  frame();
  // handy for testing / poking around in the console
  window.__bb = { pts: () => pts, psel: () => psel, pivot, selectEls, loadDocJSON: (j) => loadDoc(JSON.parse(j)), state, model, scene, camera, orbit, transform, select, byId, registry, docJSON, applyPose, setMode, commit, undo, redo };
})();
