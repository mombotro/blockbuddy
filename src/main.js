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
import { createPlay, cloneClean } from './play.js';
import {
  buildTopology,
  extrudeFaces,
  extrudeEdge,
  ensureFaces,
  keyOf,
  edgeLoop,
  faceLoop,
  deleteFaces,
  insetFaces,
  mergeDots,
  extrudeDots,
  fillDots,
  bevelEdges,
  exportGeometry,
} from './editmesh.js';

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
  if (play) play.resize();
}
// Play mode (the physics sandbox) is created the first time you press 🎮 Play
let play = null;
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
  advanced: false, // the Blender-style extras
  bevelW: 0.06,
  boneCarry: false, // moving a bone drags its shapes along
  brushColor: '#ef4444', // face paint color
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
  if (state.tool === 'paint') {
    transform.detach();
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
transform.addEventListener('objectChange', () => onObjectChange());

function onDragStart() {
  beginDrag(transform.object);
}
function beginDrag(o) {
  drag = { obj: o };
  if (o && isJoint(o) && state.mode === 'build' && !state.boneCarry) drag.held = kids(o).map((k) => [k, worldOf(k)]);
  if (o === pivot && pts) {
    pts.part.updateWorldMatrix(true, false);
    drag.pts = { C: pivot.position.clone(), W0: selGroups().map((gi) => [gi, pts.part.localToWorld(posOf(gi))]) };
  }
}
function onObjectChange(o = transform.object) {
  if (!o) return;
  if (o === pivot) return onPivotChange();
  if (state.mode === 'pose') return;
  if (isJoint(o)) {
    if (drag && drag.held) drag.held.forEach(([k, W]) => setWorld(k, W));
    updateBoneLine(o);
    syncTwin(o, false, state.boneCarry);
  } else syncTwin(o);
}
function onPivotChange() {
  if (!pts || !drag || !drag.pts) return;
  const part = pts.part;
  part.updateWorldMatrix(true, false);
  const { C, W0 } = drag.pts;
  const kind = drag.kind || state.pgizmo;
  const a = part.geometry.attributes.position;
  const w = new THREE.Vector3();
  for (const [gi, W] of W0) {
    if (kind === 'turn') w.copy(W).sub(C).applyQuaternion(pivot.quaternion).add(C);
    else if (kind === 'size') w.copy(W).sub(C).multiply(pivot.scale).add(C);
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

// ---------------------------------------------------------------- Blender-style G / R / S
// G = grab (move), R = rotate, S = scale. Then X / Y / Z locks an axis, or type a number
// for an exact amount. Click or Enter accepts. Esc or right-click cancels.
const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const mouse = { x: 0, y: 0 };
let modal = null;
window.addEventListener('pointermove', (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  if (modal) modalUpdate();
});
const mray = new THREE.Raycaster();
function rayAt(pt) {
  const r = canvas.getBoundingClientRect();
  mray.setFromCamera(new THREE.Vector2(((pt.x - r.left) / r.width) * 2 - 1, -((pt.y - r.top) / r.height) * 2 + 1), camera);
  return mray.ray.clone();
}
function planePoint(P0, ray) {
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), P0);
  return ray.intersectPlane(plane, new THREE.Vector3());
}
// where along the line (P0 + s*u) is closest to the mouse ray
function lineParam(P0, u, ray) {
  const w0 = P0.clone().sub(ray.origin);
  const v = ray.direction;
  const b = u.dot(v);
  const den = 1 - b * b;
  return den < 1e-4 ? 0 : (b * v.dot(w0) - u.dot(w0)) / den;
}
function screenOf(P) {
  const r = canvas.getBoundingClientRect();
  const v = P.clone().project(camera);
  return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
}
const snapV = (v) => (state.snap ? Math.round(v / 0.05) * 0.05 : v);
const KIND_NAME = { move: 'Move', turn: 'Rotate', size: 'Scale' };

function startModal(kind) {
  if (!state.advanced || modal || state.mode !== 'build' || state.sticking) return;
  const n = state.selected;
  let tgt = null;
  if (state.tool === 'points' && n && isPart(n)) tgt = pts && psel.length ? 'elements' : null;
  else if (n && isPart(n)) tgt = 'part';
  else if (n && isJoint(n) && kind === 'move') tgt = 'joint';
  if (!tgt) return;
  const obj = tgt === 'elements' ? pivot : n;
  beginDrag(obj);
  drag.kind = kind;
  modal = {
    kind,
    tgt,
    obj,
    axis: null,
    num: '',
    label: '',
    start: { x: mouse.x, y: mouse.y },
    P0: tgt === 'elements' ? pivot.position.clone() : worldPos(obj),
    p0: obj.position.clone(),
    q0: obj.quaternion.clone(),
    s0: obj.scale.clone(),
  };
  transform.enabled = false;
  transform.getHelper().visible = false;
  orbit.enabled = false;
  modalUpdate();
}
function modalUpdate() {
  const m = modal;
  const ax = m.axis ? AXES[m.axis] : null;
  const num = m.num !== '' && !isNaN(parseFloat(m.num)) ? parseFloat(m.num) : null;
  const T = new THREE.Vector3();
  const Q = new THREE.Quaternion();
  const S = new THREE.Vector3(1, 1, 1);
  const view = camera.getWorldDirection(new THREE.Vector3());
  let readout;
  if (m.kind === 'move') {
    if (num !== null) T.copy(ax || AXES.x).multiplyScalar(num);
    else if (ax) T.copy(ax).multiplyScalar(snapV(lineParam(m.P0, ax, rayAt(mouse)) - lineParam(m.P0, ax, rayAt(m.start))));
    else {
      const a = planePoint(m.P0, rayAt(mouse));
      const b = planePoint(m.P0, rayAt(m.start));
      if (a && b) T.copy(a).sub(b);
      T.set(snapV(T.x), snapV(T.y), snapV(T.z));
    }
    readout = `${T.x.toFixed(2)}, ${T.y.toFixed(2)}, ${T.z.toFixed(2)}`;
  } else if (m.kind === 'turn') {
    let ang;
    if (num !== null) ang = THREE.MathUtils.degToRad(num);
    else {
      const sp = screenOf(m.P0);
      ang = Math.atan2(mouse.y - sp.y, mouse.x - sp.x) - Math.atan2(m.start.y - sp.y, m.start.x - sp.x);
      if (ang > Math.PI) ang -= 2 * Math.PI;
      if (ang < -Math.PI) ang += 2 * Math.PI;
      if (ax && ax.dot(view) < 0) ang = -ang; // keep the turn matching the mouse as seen on screen
      if (state.snap) ang = Math.round(ang / THREE.MathUtils.degToRad(15)) * THREE.MathUtils.degToRad(15);
    }
    Q.setFromAxisAngle(ax || view, ang);
    readout = `${THREE.MathUtils.radToDeg(ang).toFixed(0)}°`;
  } else {
    let f;
    if (num !== null) f = num;
    else {
      const sp = screenOf(m.P0);
      f = Math.hypot(mouse.x - sp.x, mouse.y - sp.y) / Math.max(20, Math.hypot(m.start.x - sp.x, m.start.y - sp.y));
      if (state.snap) f = Math.round(f * 20) / 20;
    }
    f = Math.max(0.01, f);
    if (ax) S.setComponent('xyz'.indexOf(m.axis), f);
    else S.setScalar(f);
    readout = `×${f.toFixed(2)}`;
  }
  m.label = `${KIND_NAME[m.kind]}${m.axis ? ' ' + m.axis.toUpperCase() : ''}: ${m.num !== '' ? m.num : readout}`;
  applyModal(T, Q, S);
  renderToolbar();
}
function applyModal(T, Q, S) {
  const m = modal;
  const o = m.obj;
  if (m.tgt === 'elements') {
    pivot.position.copy(m.P0).add(T);
    pivot.quaternion.copy(Q);
    pivot.scale.copy(S);
    return onPivotChange();
  }
  const pq = o.parent.getWorldQuaternion(new THREE.Quaternion());
  const pqi = pq.clone().invert();
  o.position.copy(m.p0).add(T.clone().applyQuaternion(pqi));
  if (m.kind === 'turn') o.quaternion.copy(pqi).multiply(Q).multiply(pq).multiply(m.q0);
  if (m.kind === 'size') o.scale.copy(m.s0).multiply(S);
  onObjectChange(o);
}
function endModal(ok) {
  const m = modal;
  modal = null;
  transform.enabled = true;
  transform.getHelper().visible = true;
  orbit.enabled = true;
  if (ok) onDragEnd();
  else {
    if (m.tgt === 'elements') {
      pivot.position.copy(m.P0);
      pivot.quaternion.identity();
      pivot.scale.set(1, 1, 1);
      onPivotChange();
    } else {
      m.obj.position.copy(m.p0);
      m.obj.quaternion.copy(m.q0);
      m.obj.scale.copy(m.s0);
      onObjectChange(m.obj);
    }
    drag = null;
  }
  refresh();
}
function modalKey(e) {
  e.preventDefault();
  const c = e.code;
  if (c === 'Escape') return endModal(false);
  if (c === 'Enter' || c === 'NumpadEnter') return endModal(true);
  if (c === 'KeyX' || c === 'KeyY' || c === 'KeyZ') {
    const a = c.slice(3).toLowerCase();
    modal.axis = modal.axis === a ? null : a;
  } else if (/^(Digit|Numpad)\d$/.test(c)) modal.num += c.slice(-1);
  else if (c === 'Period' || c === 'NumpadDecimal') modal.num += modal.num.includes('.') ? '' : '.';
  else if (c === 'Minus' || c === 'NumpadSubtract') modal.num = modal.num.startsWith('-') ? modal.num.slice(1) : '-' + modal.num;
  else if (c === 'Backspace') modal.num = modal.num.slice(0, -1);
  modalUpdate();
}

// ---------------------------------------------------------------- picking
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();
let down = null;

// Shift + drag in Points mode draws a box and picks every dot / edge / face inside it.
// Capture phase, so the camera and gizmo never see this drag.
let marquee = null;
const marqueeEl = document.createElement('div');
marqueeEl.id = 'marquee';
marqueeEl.hidden = true;
$('#stage').appendChild(marqueeEl);
canvas.addEventListener(
  'pointerdown',
  (e) => {
    if (modal) {
      e.stopImmediatePropagation();
      e.preventDefault();
      down = null;
      return e.button === 2 ? endModal(false) : e.button === 0 ? endModal(true) : undefined;
    }
    if (state.mode === 'play') return;
    if (!e.shiftKey || e.button !== 0 || state.tool !== 'points' || state.mode !== 'build' || !pts || transform.axis) return;
    e.stopImmediatePropagation();
    down = null;
    marquee = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  },
  true,
);
canvas.addEventListener('pointermove', (e) => {
  if (!marquee) return;
  marquee.x1 = e.clientX;
  marquee.y1 = e.clientY;
  const r = $('#stage').getBoundingClientRect();
  const m = marqueeEl.style;
  m.left = Math.min(marquee.x0, marquee.x1) - r.left + 'px';
  m.top = Math.min(marquee.y0, marquee.y1) - r.top + 'px';
  m.width = Math.abs(marquee.x1 - marquee.x0) + 'px';
  m.height = Math.abs(marquee.y1 - marquee.y0) + 'px';
  marqueeEl.hidden = Math.hypot(marquee.x1 - marquee.x0, marquee.y1 - marquee.y0) < 5;
});
canvas.addEventListener('pointerup', (e) => {
  if (!marquee) return;
  const m = marquee;
  marquee = null;
  marqueeEl.hidden = true;
  if (Math.hypot(m.x1 - m.x0, m.y1 - m.y0) < 5) return pick(e); // just a shift-click
  const r = canvas.getBoundingClientRect();
  const [xa, xb] = [Math.min(m.x0, m.x1), Math.max(m.x0, m.x1)];
  const [ya, yb] = [Math.min(m.y0, m.y1), Math.max(m.y0, m.y1)];
  const hit = [];
  const v = new THREE.Vector3();
  pts.handles.forEach((h, i) => {
    h.getWorldPosition(v).project(camera);
    const sx = r.left + ((v.x + 1) / 2) * r.width;
    const sy = r.top + ((1 - v.y) / 2) * r.height;
    if (v.z < 1 && sx >= xa && sx <= xb && sy >= ya && sy <= yb && !psel.includes(i)) hit.push(i);
  });
  selectEls(hit, true);
});
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, onGizmo: !!transform.axis, button: e.button };
});
canvas.addEventListener('pointerup', (e) => {
  if (state.mode === 'play') return;
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
    else if (!(part && isJoint(part))) {
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
  if (state.tool === 'paint' && state.mode === 'build' && state.advanced) {
    const all = [];
    model.traverse((o) => isPart(o) && all.push(o));
    const ph = ray.intersectObjects(all, false)[0];
    if (!ph) return select(null);
    ensureFaces(ph.object.geometry);
    const id = ph.object.geometry.attributes.face.getX(ph.faceIndex * 3);
    state.selected = ph.object;
    paintFaces(ph.object, [id], state.brushColor);
    return commit();
  }
  if (state.tool === 'points' && state.mode === 'build' && pts) {
    const hit = ray.intersectObjects(pts.handles, false)[0];
    if (hit && e.altKey && state.advanced) return loopSelect(hit.object.userData.pel, e.shiftKey);
    if (hit) return selectEls([hit.object.userData.pel], e.shiftKey);
    if (state.emode === 'face') {
      // click right on a face of the shape
      const sh = ray.intersectObject(pts.part, false)[0];
      if (sh) {
        const id = pts.part.geometry.attributes.face.getX(sh.faceIndex * 3);
        const idx = pts.els.findIndex((f) => f.id === id);
        if (idx >= 0) return e.altKey && state.advanced ? loopSelect(idx, e.shiftKey) : selectEls([idx], e.shiftKey);
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
  if (!n || !(isPart(n) || (isJoint(n) && state.advanced))) return;
  state.sticking = n.userData.id;
  applyBoneVisibility();
  refresh();
}
function cancelStick() {
  state.sticking = null;
  applyBoneVisibility();
  refresh();
}
// ---------------------------------------------------------------- select loops / rings, delete, inset
const surfaceHit = () => pts.part && ray.intersectObject(pts.part, false)[0];
// Alt+click: an edge picks its whole edge loop, a face picks its belt of faces
function loopSelect(i, add) {
  const topo = pts.topo;
  const sh = surfaceHit();
  if (state.emode === 'edge') {
    const pf = sh ? pts.part.geometry.attributes.face.getX(sh.faceIndex * 3) : null;
    return selectEls(edgeLoop(topo, i, pf), add);
  }
  if (state.emode === 'face') {
    const f = pts.els[i];
    const pt = sh ? pts.part.worldToLocal(sh.point.clone()) : elCenter(f);
    let best = -1;
    let bd = Infinity;
    for (const ei of topo.faceEdges.get(f.id) || []) {
      const [a, b] = topo.edges[ei].gs;
      const d = new THREE.Line3(posOf(a), posOf(b)).closestPointToPoint(pt, true, new THREE.Vector3()).distanceTo(pt);
      if (d < bd) {
        bd = d;
        best = ei;
      }
    }
    if (best < 0) return selectEls([i], add);
    return selectEls(faceLoop(topo, f.id, best).map((id) => topo.faceIndex.get(id)), add);
  }
  toast('Alt+click works on edges and faces. For dots, use the ring buttons.');
}
function selectAll() {
  if (pts) selectEls(pts.els.map((_, i) => i), false);
}
function selectNone() {
  if (pts) selectEls([], false);
}
function selectFlip() {
  if (pts) selectEls(pts.els.map((_, i) => i).filter((i) => !psel.includes(i)), false);
}
// everything on the same level as the last pick (axis 0/1/2 = width/height/depth)
function ringSelect(axis) {
  if (!pts || !psel.length) return toast('Pick a dot, edge or face first, then pick its ring. ◯');
  const comp = (v) => [v.x, v.y, v.z][axis];
  const level = comp(elCenter(pts.els[psel[psel.length - 1]]));
  const idx = [];
  pts.els.forEach((el, i) => {
    const on = state.emode === 'face' ? Math.abs(comp(elCenter(el)) - level) < 0.002 : el.gs.every((gi) => Math.abs(comp(posOf(gi)) - level) < 0.002);
    if (on) idx.push(i);
  });
  selectEls(idx.filter((i) => !psel.includes(i)), true); // add, never un-pick
  toast(`${idx.length} on that ring`);
}
function setMesh(part, res, inheritFrom = null) {
  const oldIds = new Set(part.geometry.attributes.face.array);
  const ng = new THREE.BufferGeometry();
  ng.setAttribute('position', new THREE.BufferAttribute(res.position, 3));
  ng.setAttribute('face', new THREE.BufferAttribute(res.face, 1));
  refreshGeometry(ng, part.userData.texScale);
  part.geometry.dispose();
  part.geometry = ng;
  inheritFaceColors(part, oldIds, inheritFrom);
  syncTwin(part, true);
  commit(); // rebuilds the handles
}
function selFaceIds() {
  const ids = new Set();
  for (const i of psel) {
    const el = pts.els[i];
    if (state.emode === 'face') ids.add(el.id);
    else if (state.emode === 'edge') el.faces.forEach((id) => ids.add(id));
    else pts.topo.faces.forEach((f) => f.gs.includes(el.gs[0]) && ids.add(f.id));
  }
  return ids;
}
function reselectFaces(ids) {
  if (pts && state.emode === 'face') selectEls(pts.els.map((el, i) => (ids.has(el.id) ? i : -1)).filter((i) => i >= 0), false);
}
function deleteSel() {
  if (!pts || !psel.length) return toast('Pick something to delete first.');
  const ids = selFaceIds();
  const res = deleteFaces(pts.part.geometry, ids);
  if (!res) return toast("That would delete the whole shape. Use Delete on the whole part instead.");
  setMesh(pts.part, res);
  toast(`Deleted ${ids.size} face${ids.size === 1 ? '' : 's'}.`);
}
function insetSel() {
  if (!pts || state.emode !== 'face' || !psel.length) return toast('Inset works on faces ▣. Pick a face first.');
  const ids = new Set(psel.map((i) => pts.els[i].id));
  const res = insetFaces(pts.part.geometry, ids, 0.3);
  if (!res) return;
  setMesh(pts.part, res, [...ids][0]);
  reselectFaces(ids);
  toast('Inset! Now Extrude it for a window or a button. ⬆️');
}

// Bevel (chamfer) the picked edges. Picked faces bevel their rim, picked dots bevel the edges between them.
function edgesFromSelection() {
  const topo = pts.topo;
  const all = topo.edges.map((_, i) => i);
  if (state.emode === 'edge') return psel.slice();
  if (state.emode === 'face') {
    const ids = new Set(psel.map((i) => pts.els[i].id));
    return all.filter((i) => topo.edges[i].faces.length === 2 && topo.edges[i].faces.filter((f) => ids.has(f)).length === 1);
  }
  const gs = new Set(selGroups());
  return all.filter((i) => topo.edges[i].gs.every((g) => gs.has(g)));
}
function bevelSel() {
  if (!pts || !psel.length) return toast('Pick edges (or a face) to bevel first.');
  const res = bevelEdges(pts.part.geometry, pts.topo, edgesFromSelection(), state.bevelW);
  if (res.error) return toast(res.error);
  setMesh(pts.part, res);
  toast('Beveled! Bevel again for a rounder corner. ◢');
}
function mergeSel() {
  const gs = pts && psel.length ? selGroups() : [];
  if (gs.length < 2) return toast('Pick two or more dots to merge.');
  const res = mergeDots(pts.part.geometry, pts.topo, gs);
  if (!res) return toast('That would squash the whole shape.');
  setMesh(pts.part, res);
  toast(`Merged ${gs.length} dots into one. ⚫`);
}
function fillSel() {
  const gs = pts && psel.length ? selGroups() : [];
  if (gs.length < 3) return toast('Pick three or more dots to fill with a face.');
  const res = fillDots(pts.part.geometry, pts.topo, gs);
  if (!res) return toast("Those dots are in a straight line, so they can't make a face.");
  setMesh(pts.part, res);
  toast('Face made! ▣');
}

// ---------------------------------------------------------------- face colors (advanced)
// Each face id can have its own color. The editor turns that into vertex colors, which the
// game file keeps (COLOR_0), so the colors show up in three.js too.
const fcRGB = new Map();
function ensureFaceColors(o) {
  const g = o.geometry;
  const sig = `${g.uuid}:${g.attributes.position.count}:${o.material.uuid}:${o.userData.fcv || 0}`;
  if (o.userData._fcSig === sig) return;
  o.userData._fcSig = sig;
  const fc = o.userData.faceColors || {};
  if (!Object.keys(fc).length) {
    if (g.attributes.color) g.deleteAttribute('color');
    o.material.vertexColors = false;
    o.material.color.set(o.userData.color || '#ffffff');
    o.material.needsUpdate = true;
    return;
  }
  ensureFaces(g);
  const F = g.attributes.face.array;
  // unpainted faces carry the part's own color, so a painted face replaces it instead of tinting it
  const base = new THREE.Color(o.userData.color || '#ffffff');
  const col = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < col.length; i += 3) col.set([base.r, base.g, base.b], i);
  o.material.color.set('#ffffff');
  for (let i = 0; i < F.length; i++) {
    const hex = fc[F[i]];
    if (!hex) continue;
    if (!fcRGB.has(hex)) {
      const c = new THREE.Color(hex);
      fcRGB.set(hex, [c.r, c.g, c.b]);
    }
    col.set(fcRGB.get(hex), i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  o.material.vertexColors = true;
  o.material.needsUpdate = true;
}
// call after changing a part's faceColors: re-applies it, and copies to the mirror twin
function touchFaceColors(part) {
  part.userData.fcv = (part.userData.fcv || 0) + 1;
  const t = twinOf(part);
  if (t) {
    t.userData.faceColors = { ...part.userData.faceColors };
    t.userData.fcv = (t.userData.fcv || 0) + 1;
  }
}
// after the shape changed: forget colors of faces that are gone, and let new faces copy `from`
function inheritFaceColors(part, oldIds, from, extra = null) {
  const fc = { ...(part.userData.faceColors || {}) };
  if (!Object.keys(fc).length) return;
  const now = new Set(part.geometry.attributes.face.array);
  for (const id of Object.keys(fc)) if (!now.has(+id)) delete fc[id];
  if (extra) for (const [o, nw] of extra) if (fc[o] && now.has(nw)) fc[nw] = fc[o];
  if (from !== null && from !== undefined && fc[from]) for (const id of now) if (!oldIds.has(id)) fc[id] = fc[from];
  part.userData.faceColors = fc;
  touchFaceColors(part);
}
function paintFaces(part, ids, hex) {
  const fc = { ...(part.userData.faceColors || {}) };
  ids.forEach((id) => (hex ? (fc[id] = hex) : delete fc[id]));
  part.userData.faceColors = fc;
  touchFaceColors(part);
}
function faceColorBtn(hex, live) {
  state.brushColor = hex;
  if (state.tool === 'paint') return refresh();
  if (!pts || !psel.length) return toast('Pick faces first (▣ Faces mode), or use the 🖌️ Paint tool. 🎨');
  paintFaces(pts.part, selFaceIds(), hex);
  if (!live) commit();
}
function clearFaceColors(all) {
  const part = state.selected;
  if (!part || !isPart(part)) return;
  if (all) paintFaces(part, Object.keys(part.userData.faceColors || {}), null);
  else if (pts && psel.length) paintFaces(part, selFaceIds(), null);
  else return toast('Pick faces first to clear their color.');
  commit();
}

// ---------------------------------------------------------------- bones (advanced)
function uniqueBoneName(base, except = null) {
  const used = new Set(jointsList().filter((j) => j !== except).map((j) => j.name));
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}
// Hang a new bone off the picked bone (or start a new root bone), like Blender's E in bone edit.
function addBone() {
  const sel = state.selected;
  const parent = sel && isJoint(sel) ? sel : model;
  const at = new THREE.Vector3(0, 0.5, 0);
  if (parent !== model) {
    at.copy(worldPos(parent));
    const dir = isJoint(parent.parent) ? at.clone().sub(worldPos(parent.parent)) : new THREE.Vector3(0, 1, 0);
    at.add(dir.lengthSq() > 1e-6 ? dir.normalize().multiplyScalar(Math.min(0.3, Math.max(0.1, dir.length()))) : new THREE.Vector3(0, 0.2, 0));
  }
  const j = makeJoint(uniqueBoneName('Bone'), parent, at.toArray());
  state.bonesUser = true;
  applyBoneVisibility();
  state.tool = 'move';
  select(j);
  commit();
  toast('New bone! Drag the arrows (or press G) to put it where it bends. 🦴');
}
// Remove a bone. Shapes and bones hanging off it move up to its parent and stay put.
function deleteBone(j) {
  if (!j || !isJoint(j)) return;
  const par = j.parent;
  const held = kids(j).map((k) => [k, worldOf(k)]);
  held.forEach(([k]) => par.add(k));
  held.forEach(([k, W]) => setWorld(k, W));
  removeNode(j);
  state.selected = null;
  toast('Bone deleted. Its shapes stayed.');
  commit();
}
function setAdvanced(on) {
  state.advanced = on;
  document.body.classList.toggle('adv', on);
  try {
    localStorage.setItem('blockbuddy-advanced', on ? '1' : '0');
  } catch (e) {
    /* fine */
  }
  if (modal) endModal(false);
  toast(on ? 'Advanced tools on. Press ? for the key list. 🛠️' : 'Advanced tools off.');
  refresh();
}
function resetPose() {
  restoreRest();
  state.poseIdx = 0;
  renderLeft();
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
  } else if (state.advanced) {
    res = extrudeDots(g, pts.topo, selGroups(), dist);
  } else return toast('Extrude works on faces ▣ and edges ➖. Switch the mode below.');
  if (!res) return;
  const ng = new THREE.BufferGeometry();
  ng.setAttribute('position', new THREE.BufferAttribute(res.position, 3));
  ng.setAttribute('face', new THREE.BufferAttribute(res.face, 1));
  refreshGeometry(ng, part.userData.texScale);
  const oldIds = new Set(g.attributes.face.array);
  g.dispose();
  part.geometry = ng;
  inheritFaceColors(part, oldIds, faceIds ? [...faceIds][0] : state.emode === 'edge' ? pts.els[psel[0]].faces[0] : null);
  syncTwin(part, true);
  commit(); // rebuilds the handles for the new shape
  if (pts) {
    if (faceIds) selectEls(pts.els.map((el, i) => (faceIds.has(el.id) ? i : -1)).filter((i) => i >= 0), false);
    else if (state.emode === 'dot') {
      const ks = new Set(res.keys);
      selectEls(pts.els.map((el, i) => (ks.has(keyOf(posOf(el.gs[0]))) ? i : -1)).filter((i) => i >= 0), false);
    } else {
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
  const oldIds = new Set(n.geometry.attributes.face.array);
  n.geometry.dispose();
  n.geometry = g;
  inheritFaceColors(n, oldIds, null, g.userData.farIds);
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
  if (!n || !isNode(n) || n.userData.twin) return;
  if (Math.abs(worldPos(n).x) < 0.03) return toast('This is in the middle. Move it to one side first, then mirror it!');
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
function enterPlay() {
  if (!partCount() && !confirm('You have not built anything yet, so you will play as a ready-made person. Go play?')) return;
  if (state.mode === 'pose') restoreRest();
  if (modal) endModal(false);
  model.traverse((o) => isPart(o) && ensureFaceColors(o));
  if (!play) {
    play = createPlay({
      renderer,
      canvas,
      toast,
      hud: $('#play'),
      cloneModel: () => cloneClean(model),
    });
    window.__bb && (window.__bb.play = play);
  }
  state.mode = 'play';
  state.sticking = null;
  select(null);
  transform.detach();
  orbit.enabled = false;
  document.body.classList.add('playing');
  applyBoneVisibility();
  renderPlayHud();
  resize();
  play.start({ character: 'mine' });
  refresh();
}
function exitPlay() {
  if (play) play.stop();
  document.body.classList.remove('playing');
  state.mode = 'build';
  orbit.enabled = true;
  applyBoneVisibility();
  resize();
  refresh();
}
function renderPlayHud() {
  const el = $('#play');
  if (el.dataset.built) return;
  el.dataset.built = '1';
  const who = [['mine', '🧱', 'My model'], ...['person', 'dog', 'cat', 'horse', 'bird'].map((id) => [id, STARTERS[id].icon, STARTERS[id].label])];
  el.innerHTML = `
    <div id="playTop">
      <button data-act="mode:build" class="soft">◀ Back to building</button>
      <span class="who">Play as: ${who.map(([id, ic, l]) => `<button class="mini" data-act="playas:${id}" title="${l}">${ic} ${l}</button>`).join('')}</span>
      <span id="playState"></span>
    </div>
    <div id="playHelp">
      <b>🎮 Controls</b>
      <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move · <kbd>Shift</kbd> run · <kbd>Space</kbd> jump (twice for a double jump!)</span>
      <span><kbd>C</kbd> crouch · <kbd>X</kbd> crawl · <kbd>E</kbd> pick up / drop · click or <kbd>F</kbd> throw (hold to throw harder)</span>
      <span>🧗 Walk into the <b>brown wall</b> to climb · 🏃 Run and jump next to a wall to <b>wall run</b> · 🤸 Pink pad = bounce</span>
      <span><kbd>1</kbd> box · <kbd>2</kbd> ball · <kbd>3</kbd> <b>your model</b> as a toy · <kbd>R</kbd> new playground · <kbd>T</kbd> go back to start</span>
      <span>Click the picture to look around with the mouse (<kbd>Esc</kbd> lets go). Arrow keys also turn the camera. Scroll to zoom. <kbd>H</kbd> hides this box.</span>
    </div>`;
}
function setMode(m) {
  if (m === 'play') return state.mode === 'play' ? undefined : enterPlay();
  if (state.mode === 'play') {
    exitPlay();
    if (m === 'build') return;
  }
  if (m === state.mode) return;
  if (m === 'pose') {
    if (!jointsList().length) {
      toast('Pose needs bones! Pick a Person, Dog, Cat, Horse or Bird, or add your own bones in Advanced mode. 🦴');
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
  // small animals get small bone dots
  const dot = { cat: 0.5, bird: 0.7 }[state.rig] || 1;
  for (const j of jointsList())
    if (j.userData.marker) {
      j.userData.marker.visible = flags.bones;
      j.userData.marker.scale.setScalar(dot);
    }
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
  const swapped = [];
  model.traverse((o) => {
    if (!isPart(o)) return;
    ensureFaceColors(o);
    swapped.push([o, o.geometry]);
  });
  swapped.forEach(([o, g]) => (o.geometry = exportGeometry(g))); // real triangles only, no editor data
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
    swapped.forEach(([o, g]) => {
      o.geometry.dispose();
      o.geometry = g;
    });
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
  $('#tab-play').classList.toggle('on', state.mode === 'play');
  $('#undoBtn').disabled = hi <= 0;
  $('#redoBtn').disabled = hi >= hist.length - 1;
  $('#advBtn').classList.toggle('on', state.advanced);
  const inp = $('#projName');
  if (document.activeElement !== inp) inp.value = state.name;
}

function renderLeft() {
  const el = $('#left');
  if (state.mode === 'pose') {
    const poses = posesFor(state.rig);
    el.innerHTML = `
      <h3>Pick a pose</h3>
      ${poses.length ? '' : '<p class="tip">No ready-made poses for your own bones. Click a bone and drag the rings to bend it.</p>'}
      <div class="grid2">${poses
        .map(
          (p, i) =>
            `<button class="tile ${i === state.poseIdx ? 'on' : ''}" data-act="pose:${i}"><span>${p.icon}</span>${p.name}</button>`,
        )
        .join('')}</div>
      <p class="tip">Click a body part, then drag the colored rings to bend it.</p>
      <button class="wide soft" data-act="resetpose">↺ Back to the starting pose</button>
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
    <label class="check"><input type="checkbox" id="bonesChk" ${state.bonesUser ? 'checked' : ''}> Show bones (orange dots)</label>
    ${
      state.advanced
        ? `<h3>Bones 🦴</h3><button class="wide" data-act="addbone">➕ Add a bone</button>
    <p class="tip small">Pick a bone first to hang the new one off it. Click an orange dot to pick a bone.</p>`
        : ''
    }`;
}

function renderToolbar() {
  const n = state.selected;
  const el = $('#toolbar');
  let html = '';
  if (modal) {
    html = `<span class="label full" style="font-size:15px">${esc(modal.label)} · X Y Z = axis · type a number · click or Enter = OK · Esc = cancel</span>`;
  } else if (state.sticking) {
    const p = byId(state.sticking);
    html = `<span class="label">📎 Click ${p && isJoint(p) ? 'the bone to hang' : 'what to stick'} “${esc(p ? p.name : '')}” ${p && isJoint(p) ? 'under (an orange dot)' : 'onto (a shape or an orange bone)'}</span><button data-act="cancelstick">Cancel</button>`;
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
    const can = pts && psel.length && (state.emode !== 'dot' || state.advanced);
    const hint = psel.length
      ? `${psel.length} picked`
      : state.emode === 'face' ? 'Click a face' : state.emode === 'edge' ? 'Click a diamond' : 'Click a dot';
    html =
      `<button class="tool" data-act="tool:move"><span>◀</span>Done</button><i class="sep"></i>` +
      em('dot', '⚪', 'Dots') + em('edge', '➖', 'Edges') + em('face', '▣', 'Faces') +
      `<i class="sep"></i>` +
      gz('move', '↔️', 'Move') + gz('turn', '🔄', 'Turn') + gz('size', '⤡', 'Size') +
      `<i class="sep"></i><button class="tool" data-act="extrude" ${can ? '' : 'disabled'}><span>⬆️</span>Extrude</button>` +
      `<span class="label full">${hint} · Shift+click or Shift+drag = pick more</span>`;
  } else {
    const t = (id, icon, label) =>
      `<button class="tool ${state.tool === id ? 'on' : ''}" data-act="tool:${id}"><span>${icon}</span>${label}</button>`;
    html =
      t('move', '↔️', 'Move') +
      t('turn', '🔄', 'Turn') +
      t('size', '⤡', 'Size') +
      t('points', '✏️', 'Points') +
      (state.advanced ? t('paint', '🖌️', 'Paint') : '') +
      (state.tool === 'paint' ? `<span class="label">Click a face to paint it <i class="chip" style="background:${state.brushColor}"></i></span>` : '');
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
    const par = isNode(n.parent) ? n.parent : null;
    el.innerHTML = state.advanced
      ? `<h3>🦴 Bone</h3>
      <input id="nameIn" value="${esc(n.name)}" maxlength="40">
      <p class="tip">Shapes bend around a bone when you pose. Put it where the bend should be.</p>
      <p class="tip">Under: <b>${par ? esc(par.name) : 'nothing (a root bone)'}</b></p>
      <div class="sec"><b>Bone tools 🦴</b>
        <button class="wide" data-act="addbone">➕ Add a bone from here</button>
        <button class="wide" data-act="stickto">📎 Move under another bone…</button>
        ${par ? `<button class="wide soft" data-act="unstick">✂️ Make it a root bone</button>` : ''}
        ${
          t
            ? `<p class="tip">🔗 Mirror twin: <b>${esc(t.name)}</b></p><button class="wide soft" data-act="unlink">Unlink twins</button>`
            : `<button class="wide" data-act="mirror">🪞 Make a mirror twin</button><p class="tip small">Copies this bone and everything under it to the other side.</p>`
        }
        <label class="check"><input type="checkbox" id="carryChk" ${state.boneCarry ? 'checked' : ''}> Shapes move with the bone</label>
        <button class="wide danger" data-act="delbone">🗑️ Delete bone (shapes stay)</button>
      </div>
      <p class="tip small">To put a shape on this bone, press a shape under “Add a shape”. Keys: E add bone · G move · X delete.</p>`
      : `<h3>🦴 ${esc(n.name)}</h3>
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
  const mini = 'class="mini" style="font-size:13px"';
  const fcol = `<div class="sec"><b>Face color 🎨</b>
      <div class="swatches">${PALETTE.map((c) => `<button class="sw ${state.brushColor.toLowerCase() === c ? 'on' : ''}" style="background:${c}" data-act="fcol:${c}" title="${c}"></button>`).join('')}</div>
      <label class="check"><span>Any color</span><input type="color" id="fcolCustom" value="${state.brushColor}"></label>
      <p class="tip small">${state.tool === 'paint' ? 'Click faces on the shape to paint them with this color.' : 'Pick faces (▣ Faces mode), then press a color to paint them.'}</p>
      <div class="row" style="margin-top:6px"><button ${mini} data-act="fclear">Clear picked</button><button ${mini} data-act="fclearall">Clear all</button></div></div>`;
  const editBox =
    state.tool === 'paint' && state.advanced
      ? fcol
      : state.tool !== 'points'
      ? ''
      : state.advanced
        ? `<div class="sec"><b>Pick ✋</b>
      <div class="grid3"><button ${mini} data-act="selall" title="A">All</button><button ${mini} data-act="selnone" title="Alt+A">None</button><button ${mini} data-act="selinv" title="Ctrl+I">Flip</button></div>
      <p class="tip small">Pick everything on the same level as your last pick:</p>
      <div class="grid3"><button ${mini} data-act="selring:1">↕ Height</button><button ${mini} data-act="selring:0">↔ Width</button><button ${mini} data-act="selring:2">⤢ Depth</button></div>
      <p class="tip small">Alt+click an edge = its loop. Alt+click a face = its belt of faces.</p></div>
      <div class="sec"><b>Edit ✏️</b>
      <div class="grid3"><button ${mini} data-act="extrude">⬆ Extrude</button><button ${mini} data-act="inset">⬇ Inset</button><button ${mini} data-act="delsel">🗑 Delete</button></div>
      <div class="grid3" style="margin-top:4px"><button ${mini} data-act="bevel" title="Ctrl+B">◢ Bevel</button><button ${mini} data-act="merge" title="M">⚫ Merge</button><button ${mini} data-act="fill" title="F">▣ Fill</button></div>
      <label class="slider"><span>Bevel size</span><input type="range" id="bevelW" min="0.01" max="0.3" step="0.01" value="${state.bevelW}"></label>
      <p class="tip small">Extrude a dot to pull out an edge, then Fill dots into a face. G move · R turn · S size, like Blender. Press ? for all keys.</p></div>
      ${fcol}`
        : `<div class="sec"><b>Points ✏️</b>
      <p class="tip">Click dots, edges or faces. Shift+click or Shift+drag picks more. Then drag the arrows, or press ⬆ Extrude to push a face out.</p>
      <p class="tip small">More tools: turn on 🛠️ Advanced at the top.</p></div>`;
  const swatch = PALETTE.map(
    (c) => `<button class="sw ${u.color.toLowerCase() === c ? 'on' : ''}" style="background:${c}" data-act="color:${c}" title="${c}"></button>`,
  ).join('');
  const pats = PATTERN_LIST.map(
    ([id, label]) =>
      `<button class="pat ${!u.image && u.pattern === id ? 'on' : ''}" data-act="pat:${id}" title="${label}"><img src="${patternThumb(id)}" alt=""><i>${label}</i></button>`,
  ).join('');
  el.innerHTML = `
    <h3>Selected</h3>${editBox}
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
    case 'playas':
      return play && play.setCharacter(arg);
    case 'shape': return swapShapeTo(arg);
    case 'stick': return stickOn(arg);
    case 'stickto': return startStick();
    case 'cancelstick': return cancelStick();
    case 'unstick':
      if (n && isNode(n)) stickTo(n, model);
      return;
    case 'slice': return sliceSelected(+arg);
    case 'emode':
      state.emode = arg;
      return refresh();
    case 'pgz':
      state.pgizmo = arg;
      return refresh();
    case 'extrude': return extrudeSel();
    case 'inset': return insetSel();
    case 'bevel': return bevelSel();
    case 'fcol': return faceColorBtn(arg, false);
    case 'fclear': return clearFaceColors(false);
    case 'fclearall': return clearFaceColors(true);
    case 'merge': return mergeSel();
    case 'fill': return fillSel();
    case 'adv': return setAdvanced(!state.advanced);
    case 'addbone': return addBone();
    case 'delbone': return deleteBone(n);
    case 'resetpose': return resetPose();
    case 'delsel': return deleteSel();
    case 'selall': return selectAll();
    case 'selnone': return selectNone();
    case 'selinv': return selectFlip();
    case 'selring': return ringSelect(+arg);
    case 'keys':
      $('#keys').hidden = !$('#keys').hidden;
      return;
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
  if (e.target.id === 'bevelW') state.bevelW = +e.target.value;
  if (e.target.id === 'fcolCustom') faceColorBtn(e.target.value, true);
});
document.addEventListener('change', (e) => {
  const n = state.selected;
  const id = e.target.id;
  if (id === 'customColor' || id === 'texScale') commit();
  else if (id === 'fcolCustom') {
    if (state.tool === 'points' && pts && psel.length) commit();
    else refresh();
  } else if (id === 'carryChk') state.boneCarry = e.target.checked;
  else if (id === 'nameIn' && n) {
    const v = e.target.value || n.name;
    n.name = isJoint(n) ? uniqueBoneName(v, n) : v;
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
const NUMPAD_VIEWS = { Numpad1: 'front', Numpad3: 'side', Numpad7: 'top' };
window.addEventListener('keydown', (e) => {
  if (/input|textarea/i.test(document.activeElement.tagName) && document.activeElement.type !== 'checkbox') return;
  if (state.mode === 'play') return;
  if (modal) return modalKey(e);
  const mod = e.metaKey || e.ctrlKey;
  const c = e.code;
  const n = state.selected;
  const editing = state.mode === 'build' && state.tool === 'points' && n && isPart(n);
  const del_ = e.key === 'Delete' || e.key === 'Backspace';
  if (mod && c === 'KeyZ') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (mod && c === 'KeyY') {
    e.preventDefault();
    redo();
  } else if (c === 'Escape') state.sticking ? cancelStick() : select(null);
  else if (state.mode !== 'build') return;
  else if (!state.advanced) {
    if (del_ && !editing) del(); // simple mode: just delete the picked part
  } else if (NUMPAD_VIEWS[c]) viewFrom(VIEWS[mod && c === 'Numpad1' ? 'back' : NUMPAD_VIEWS[c]]);
  else if (c === 'NumpadDecimal') frameModel();
  else if (e.key === '?') $('#keys').hidden = !$('#keys').hidden;
  else if (editing && mod && c === 'KeyI') {
    e.preventDefault();
    selectFlip();
  } else if (editing && mod && c === 'KeyB') {
    e.preventDefault();
    bevelSel();
  } else if (editing && e.altKey && c === 'KeyA') selectNone();
  else if (mod) return;
  else if (c === 'Tab' && n && isPart(n)) {
    e.preventDefault();
    state.tool = editing ? 'move' : 'points';
    refresh();
  } else if (c === 'KeyG' || c === 'KeyR' || c === 'KeyS') startModal({ KeyG: 'move', KeyR: 'turn', KeyS: 'size' }[c]);
  else if (n && isJoint(n) && c === 'KeyE') addBone();
  else if (n && isJoint(n) && (c === 'KeyX' || del_)) deleteBone(n);
  else if (editing) {
    if (c === 'KeyE') extrudeSel();
    else if (c === 'KeyI') insetSel();
    else if (c === 'KeyM') mergeSel();
    else if (c === 'KeyF') fillSel();
    else if (c === 'KeyA') selectAll();
    else if (c === 'KeyX' || del_) deleteSel();
    else if (c === 'Digit1' || c === 'Digit2' || c === 'Digit3') {
      state.emode = ['dot', 'edge', 'face'][+c.slice(-1) - 1];
      refresh();
    }
  } else if (n && isPart(n) && c === 'KeyD' && e.shiftKey) {
    duplicate();
    startModal('move');
  } else if (c === 'KeyX' || del_) del();
});

// ---------------------------------------------------------------- loop
function frame() {
  if (state.mode === 'play' && play && play.running) {
    play.frame();
    requestAnimationFrame(frame);
    return;
  }
  orbit.update();
  model.traverse((o) => isPart(o) && ensureFaceColors(o));
  if (flags.bones) for (const j of jointsList()) updateBoneLine(j);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- boot
(function boot() {
  resize();
  try {
    state.advanced = localStorage.getItem('blockbuddy-advanced') === '1';
  } catch (e) {
    /* fine */
  }
  document.body.classList.toggle('adv', state.advanced);
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
  window.__bb = { THREE, pts: () => pts, psel: () => psel, pivot, selectEls, loadDocJSON: (j) => loadDoc(JSON.parse(j)), state, model, scene, camera, orbit, transform, select, byId, registry, docJSON, applyPose, setMode, commit, undo, redo };
})();
