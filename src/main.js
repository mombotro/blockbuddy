import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import {
  SHAPES,
  refreshGeometry,
  geometrySize,
  bakeScale,
  sliceGeometry,
  cutSegments,
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
  fatMats.forEach(sizeFatMat);
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
  use: null, // what the model does in Play: car | hover | mount | shooter | swing
  useCfg: { proj: 'dart', auto: false },
  snap: true,
  bonesUser: false,
  name: 'my-model',
  keepPose: false,
  poseIdx: 0,
  stickNew: false, // new shapes stick onto the picked part
  advanced: false, // the Blender-style extras
  multi: [], // more shapes picked along with state.selected (Shift+click)
  boxSel: false, // left-drag draws a pick box in Points mode
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
    use: state.use,
    useCfg: state.useCfg,
    nodes: kids(model).map(serializeNode),
  });
}
// Pose mode keeps its own undo list, so undoing a pose never undoes your building (and the other way round)
let poseHist = null; // { build: { hist, hi }, rest: Map(id -> { p, q }) }
function enterPoseHistory() {
  poseHist = {
    build: { hist, hi },
    rest: new Map(jointsList().map((j) => [j.userData.id, { p: j.userData.rest.p.clone(), q: j.userData.rest.q.clone() }])),
  };
  hist = [docJSON()];
  hi = 0;
}
function leavePoseHistory() {
  if (!poseHist) return;
  hist = poseHist.build.hist;
  hi = poseHist.build.hi;
  poseHist = null;
}
function commit() {
  const snap = docJSON();
  if (hist[hi] === snap) return;
  hist = hist.slice(0, hi + 1);
  hist.push(snap);
  if (hist.length > 80) hist.shift();
  hi = hist.length - 1;
  if (!poseHist) try {
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
  state.use = doc.use || null;
  state.useCfg = { proj: 'dart', auto: false, ...(doc.useCfg || {}) };
  if (doc.name) state.name = doc.name;
  for (const n of doc.nodes) deserialize(n, model);
  state.selected = byId(selId);
  state.multi = [];
  if (poseHist)
    for (const j of jointsList()) {
      const r = poseHist.rest.get(j.userData.id);
      if (r) j.userData.rest = { p: r.p.clone(), q: r.q.clone() };
    }
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
// thick glowing outlines: the main pick is yellow, the others you added are orange
function outlineFor(part, color, width) {
  const eg = new THREE.EdgesGeometry(part.geometry, 20);
  const l = fatLines(color, width, { depthTest: false, offset: false });
  setFat(l, Array.from(eg.attributes.position.array));
  eg.dispose();
  l.userData.helper = true;
  l.renderOrder = 15;
  part.add(l);
  return l;
}
function dropOutline(l) {
  l.parent && l.parent.remove(l);
  l.geometry.dispose();
  fatMats.delete(l.material);
  l.material.dispose();
}
function setOutline(part) {
  if (outline) {
    dropOutline(outline);
    outline = null;
  }
  if (part && isPart(part)) outline = outlineFor(part, 0xffd23f, state.tool === 'points' ? 1.5 : 3.5);
}
// ---------------------------------------------------------------- points mode: dots, edges, faces
// All the dots / edge diamonds / face squares are children of the part (so they follow it).
// Whatever is picked is moved by one gizmo (the "pivot") sitting at its middle.
const SEL_COLOR = 0xff8a1f; // picked: orange, like Blender
const HOVER_COLOR = 0xfff3a3; // under the mouse
const DOT_COLOR = 0x1d1b33;
const pivot = new THREE.Object3D();
scene.add(pivot);
let pts = null; // { part, geo, mode, topo, els, root, centers, hover, wireFront, wireBack, dotsFront, dotsBack, selLines, hoverLines, sel, hoverFill }
let psel = []; // picked elements (indexes into pts.els)

// thick lines (plain GL lines are 1px and vanish). They need to know the screen size.
const fatMats = new Set();
function fatLines(color, width, { depthTest = true, opacity = 1, offset = true } = {}) {
  const m = new LineMaterial({ color, linewidth: width, transparent: true, opacity, depthTest, depthWrite: false });
  if (offset) {
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -2;
  }
  m.userData = { width };
  fatMats.add(m);
  const l = new LineSegments2(new LineSegmentsGeometry(), m);
  l.frustumCulled = false;
  l.visible = false;
  l.userData = { helper: true, ownGeo: true };
  sizeFatMat(m);
  return l;
}
function sizeFatMat(m) {
  const v = renderer.getDrawingBufferSize(new THREE.Vector2());
  m.resolution.copy(v);
  m.linewidth = m.userData.width * renderer.getPixelRatio();
}
function setFat(l, arr) {
  l.visible = arr.length >= 6;
  if (l.visible) l.geometry.setPositions(arr);
}
const dotTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(32, 32, 30, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  return t;
})();
function dotPoints(size, depthTest, opacity) {
  const o = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({ size, sizeAttenuation: false, map: dotTex, alphaTest: 0.3, vertexColors: true, transparent: true, opacity, depthTest, depthWrite: false }),
  );
  o.frustumCulled = false;
  o.userData = { helper: true, ownGeo: true };
  return o;
}

function clearPoints() {
  if (pts) {
    pts.root.parent && pts.root.parent.remove(pts.root);
    pts.root.traverse((o) => {
      if (o.material) {
        fatMats.delete(o.material);
        o.material.dispose();
      }
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
function buildPoints(part) {
  clearPoints();
  ensureFaces(part.geometry);
  const topo = buildTopology(part.geometry);
  const root = new THREE.Group();
  root.userData.helper = true;
  part.add(root);
  const els = topo[state.emode === 'dot' ? 'dots' : state.emode === 'edge' ? 'edges' : 'faces'];
  pts = { part, geo: part.geometry, mode: state.emode, topo, els, root, centers: [], hover: -1 };
  // every edge of the shape, always drawn, so you can see where they go
  pts.wireBack = fatLines(0x1d1b33, 1.2, { depthTest: false, opacity: 0.22, offset: false });
  pts.wireFront = fatLines(0x1d1b33, 1.8);
  pts.dotsBack = dotPoints(6, false, 0.35);
  pts.dotsFront = dotPoints(state.emode === 'face' ? 8 : 10, true, 1);
  pts.dotsSel = dotPoints(state.emode === 'face' ? 14 : 16, false, 1);
  pts.selLines = fatLines(SEL_COLOR, 4.5, { depthTest: false, offset: false });
  pts.hoverLines = fatLines(HOVER_COLOR, 4, { depthTest: false, offset: false });
  pts.selLines.renderOrder = 40;
  pts.hoverLines.renderOrder = 41;
  pts.wireBack.renderOrder = 20;
  pts.wireFront.renderOrder = 21;
  pts.dotsBack.renderOrder = 42;
  pts.dotsFront.renderOrder = 43;
  pts.dotsSel.renderOrder = 44;
  for (const o of [pts.wireBack, pts.wireFront, pts.selLines, pts.hoverLines, pts.dotsBack, pts.dotsFront, pts.dotsSel]) root.add(o);
  updatePoints();
}
const faceTri = (g, tris) => {
  const pos = [];
  for (const t of tris) for (let k = 0; k < 3; k++) pos.push(g.getX(t * 3 + k), g.getY(t * 3 + k), g.getZ(t * 3 + k));
  return pos;
};
// reposition everything after the shape, the picks or the mouse changed
function updatePoints() {
  if (!pts) return;
  const { els, topo } = pts;
  const g = pts.part.geometry.attributes.position;
  pts.centers = els.map(elCenter);
  const gp = topo.groups.map((_, gi) => posOf(gi));
  // wire: all the edges
  const w = [];
  for (const e of topo.edges) w.push(gp[e.gs[0]].x, gp[e.gs[0]].y, gp[e.gs[0]].z, gp[e.gs[1]].x, gp[e.gs[1]].y, gp[e.gs[1]].z);
  setFat(pts.wireFront, w);
  setFat(pts.wireBack, w);
  // dots: the corners (dot mode) or the face middles (face mode). Edge mode has none.
  const showDots = pts.mode !== 'edge';
  const col = new Float32Array(els.length * 3);
  const c = new THREE.Color();
  const base = new THREE.Color(DOT_COLOR);
  els.forEach((_, i) => {
    c.copy(base);
    if (psel.includes(i)) c.set(SEL_COLOR);
    else if (i === pts.hover) c.set(HOVER_COLOR);
    col.set([c.r, c.g, c.b], i * 3);
  });
  const posArr = new Float32Array(els.length * 3);
  pts.centers.forEach((v, i) => posArr.set([v.x, v.y, v.z], i * 3));
  for (const d of [pts.dotsFront, pts.dotsBack]) {
    d.visible = showDots;
    d.geometry.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    d.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    d.geometry.computeBoundingSphere();
  }
  // the picked ones get big orange dots you can't miss
  const selPos = new Float32Array(psel.length * 3);
  const selCol = new Float32Array(psel.length * 3);
  const sc = new THREE.Color(SEL_COLOR);
  psel.forEach((i, k) => {
    if (pts.mode === 'edge') return;
    selPos.set([pts.centers[i].x, pts.centers[i].y, pts.centers[i].z], k * 3);
    selCol.set([sc.r, sc.g, sc.b], k * 3);
  });
  pts.dotsSel.visible = pts.mode !== 'edge' && psel.length > 0;
  pts.dotsSel.geometry.setAttribute('position', new THREE.BufferAttribute(selPos, 3));
  pts.dotsSel.geometry.setAttribute('color', new THREE.BufferAttribute(selCol, 3));
  pts.dotsSel.geometry.computeBoundingSphere();
  // picked and hovered things
  const lineFor = (list) => {
    const arr = [];
    for (const i of list) {
      if (i < 0) continue;
      if (pts.mode === 'edge') arr.push(...gp[els[i].gs[0]].toArray(), ...gp[els[i].gs[1]].toArray());
      else if (pts.mode === 'face') {
        for (const e of topo.edges) if (e.faces.includes(els[i].id)) arr.push(...gp[e.gs[0]].toArray(), ...gp[e.gs[1]].toArray());
      }
    }
    return arr;
  };
  setFat(pts.selLines, lineFor(psel));
  setFat(pts.hoverLines, psel.includes(pts.hover) ? [] : lineFor([pts.hover]));
  for (const k of ['sel', 'hoverFill']) {
    if (pts[k]) {
      pts.root.remove(pts[k]);
      pts[k].geometry.dispose();
      pts[k].material.dispose();
      pts[k] = null;
    }
  }
  if (pts.mode === 'face') {
    const fill = (list, color, opacity, order) => {
      const pos = [];
      for (const i of list) if (i >= 0) pos.push(...faceTri(g, els[i].tris));
      if (!pos.length) return null;
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const m = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, side: THREE.DoubleSide, depthWrite: false }));
      m.renderOrder = order;
      m.userData = { helper: true, ownGeo: true };
      pts.root.add(m);
      return m;
    };
    pts.sel = fill(psel, SEL_COLOR, 0.4, 22);
    pts.hoverFill = fill(psel.includes(pts.hover) ? [] : [pts.hover], HOVER_COLOR, 0.3, 23);
  }
}
// ---- picking by distance on the screen (not by hitting tiny shapes)
const PICK_PX = 14;
function toScreen(v, r) {
  const p = v.clone().project(camera);
  return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height, z: p.z };
}
function visibleFromCamera(wp) {
  const o = camera.position;
  const d = wp.clone().sub(o);
  const dist = d.length();
  ray.set(o, d.normalize());
  const h = ray.intersectObject(pts.part, false)[0];
  return !h || h.distance > dist - (0.01 + dist * 0.01);
}
function pickEl(cx, cy) {
  if (!pts) return -1;
  const r = canvas.getBoundingClientRect();
  pts.part.updateWorldMatrix(true, false);
  const W = (v) => pts.part.localToWorld(v.clone());
  let best = -1;
  let bd = PICK_PX;
  if (pts.mode === 'face') {
    ptr.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ptr, camera);
    const sh = ray.intersectObject(pts.part, false)[0];
    if (sh) {
      const id = pts.part.geometry.attributes.face.getX(sh.faceIndex * 3);
      const idx = pts.els.findIndex((f) => f.id === id);
      if (idx >= 0) return idx;
    }
  }
  pts.els.forEach((el, i) => {
    let d;
    let wp;
    if (pts.mode === 'edge') {
      const a = toScreen(W(posOf(el.gs[0])), r);
      const b = toScreen(W(posOf(el.gs[1])), r);
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const L = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((cx - a.x) * vx + (cy - a.y) * vy) / L));
      d = Math.hypot(cx - (a.x + vx * t), cy - (a.y + vy * t));
      if (d >= bd) return;
      wp = W(posOf(el.gs[0]).lerp(posOf(el.gs[1]), t));
    } else {
      wp = W(pts.centers[i]);
      const s = toScreen(wp, r);
      d = Math.hypot(cx - s.x, cy - s.y);
      if (d >= bd) return;
    }
    if (!visibleFromCamera(wp)) d += PICK_PX * 0.6; // hidden ones lose to visible ones
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}
function setHover(i) {
  if (!pts || pts.hover === i) return;
  pts.hover = i;
  updatePoints();
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
  if (!pts || !psel.length || state.pgizmo === 'select') {
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
  state.multi = [];
  if (state.mode === 'pose' && node && isPart(node)) state.selected = nearestJoint(node);
  if (state.selected && isJoint(state.selected) && state.mode === 'build' && state.tool !== 'move') state.tool = 'move';
  refresh();
}
const nearestJoint = (n) => {
  for (let o = n.parent; o && isNode(o); o = o.parent) if (isJoint(o)) return o;
  return null;
};

// ---- picking several shapes at once (Shift / Ctrl / Cmd + click)
const groupParts = () => [state.selected, ...state.multi].filter((o) => o && isPart(o) && o.parent);
let multiOutlines = [];
function setMultiOutlines() {
  multiOutlines.forEach(dropOutline);
  multiOutlines = [];
  if (!state.multi.length || state.mode !== 'build') return;
  for (const part of state.multi) if (part && isPart(part) && part.parent) multiOutlines.push(outlineFor(part, 0xff7a1a, 3.5));
}
function toggleGroup(part) {
  const cur = state.selected;
  if (!cur || !isPart(cur)) return select(part);
  if (part === cur) {
    if (!state.multi.length) return select(null);
    state.selected = state.multi.pop();
  } else if (state.multi.includes(part)) state.multi.splice(state.multi.indexOf(part), 1);
  else state.multi.push(part);
  refresh();
}
function selectAllParts() {
  const all = [];
  model.traverse((o) => isPart(o) && all.push(o));
  if (!all.length) return;
  state.selected = all[0];
  state.multi = all.slice(1);
  refresh();
  toast(`${all.length} shapes picked`);
}
let groupMode = false; // the gizmo moves every picked shape together
function attachGroup() {
  const ps = groupParts();
  const c = new THREE.Vector3();
  ps.forEach((o) => c.add(worldPos(o)));
  c.divideScalar(ps.length);
  pivot.position.copy(c);
  pivot.quaternion.identity();
  pivot.scale.set(1, 1, 1);
  transform.attach(pivot);
  transform.setMode(state.tool === 'turn' ? 'rotate' : state.tool === 'size' ? 'scale' : 'translate');
  transform.setSpace('world');
}

function applyTool() {
  const n = state.selected;
  setOutline(n);
  setMultiOutlines();
  groupMode = false;
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
  if (state.multi.length && state.mode === 'build' && state.tool !== 'points' && state.tool !== 'paint' && state.tool !== 'select') {
    groupMode = true;
    return attachGroup();
  }
  if (state.tool === 'points') {
    if (!pts || pts.part !== n || pts.geo !== n.geometry || pts.mode !== state.emode) buildPoints(n);
    else updatePoints();
    attachPivot();
    return;
  }
  if (state.tool === 'paint' || state.tool === 'select') {
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
  if (o === pivot && groupMode) {
    drag.group = { C: pivot.position.clone(), W0: groupParts().map((q) => [q, worldOf(q)]) };
  } else if (o === pivot && pts) {
    pts.part.updateWorldMatrix(true, false);
    drag.pts = { C: pivot.position.clone(), W0: selGroups().map((gi) => [gi, pts.part.localToWorld(posOf(gi))]) };
  }
}
function onObjectChange(o = transform.object) {
  if (!o) return;
  if (o === pivot) return groupMode ? onGroupChange() : onPivotChange();
  if (state.mode === 'pose') return;
  if (isJoint(o)) {
    if (drag && drag.held) drag.held.forEach(([k, W]) => setWorld(k, W));
    updateBoneLine(o);
    syncTwin(o, false, state.boneCarry);
  } else syncTwin(o);
}
function onGroupChange() {
  if (!drag || !drag.group) return;
  const { C, W0 } = drag.group;
  const D = new THREE.Matrix4()
    .compose(pivot.position, pivot.quaternion, pivot.scale)
    .multiply(new THREE.Matrix4().makeTranslation(-C.x, -C.y, -C.z));
  for (const [q, W] of W0) {
    setWorld(q, D.clone().multiply(W));
    syncTwin(q);
  }
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
  if (o === pivot && groupMode) {
    for (const q of groupParts()) {
      if (!(q.scale.x === 1 && q.scale.y === 1 && q.scale.z === 1)) {
        bakeScale(q.geometry, q.scale, q.userData.texScale);
        q.scale.set(1, 1, 1);
        syncTwin(q, true);
      }
    }
    commit();
    refresh();
    return;
  }
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
    if (lcut || !(e.shiftKey || e.ctrlKey || e.metaKey || state.boxSel || state.pgizmo === 'select') || e.button !== 0 || state.tool !== 'points' || state.mode !== 'build' || !pts || transform.axis) return;
    e.stopImmediatePropagation();
    down = null;
    marquee = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, add: e.shiftKey || e.ctrlKey || e.metaKey };
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
  pts.part.updateWorldMatrix(true, false);
  pts.centers.forEach((c, i) => {
    const sp = toScreen(pts.part.localToWorld(c.clone()), r);
    if (sp.z < 1 && sp.x >= xa && sp.x <= xb && sp.y >= ya && sp.y <= yb) hit.push(i);
  });
  // adding: only the new ones (so a second box never un-picks); plain box: replace
  selectEls(m.add ? hit.filter((i) => !psel.includes(i)) : hit, m.add);
});
canvas.addEventListener('pointermove', (e) => {
  if (state.mode !== 'build' || state.tool !== 'points' || !pts || marquee || modal || transform.dragging || (e.buttons & 7)) return;
  if (transform.axis) return setHover(-1);
  setHover(pickEl(e.clientX, e.clientY));
});
canvas.addEventListener('pointerleave', () => setHover(-1));
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
    const add = e.shiftKey || e.ctrlKey || e.metaKey; // add to / take away from what is picked
    const hit = pickEl(e.clientX, e.clientY);
    if (hit >= 0) return e.altKey && state.advanced ? loopSelect(hit, add) : selectEls([hit], add);
  }
  if (flags.bones) {
    const ms = jointsList().map((j) => j.userData.marker).filter((m) => m && m.visible);
    const hit = ray.intersectObjects(ms, false)[0];
    if (hit) return select(hit.object.userData.markerFor);
  }
  const parts = [];
  model.traverse((o) => isPart(o) && parts.push(o));
  const hit = ray.intersectObjects(parts, false)[0];
  if (hit) return e.shiftKey || e.ctrlKey || e.metaKey ? toggleGroup(hit.object) : select(hit.object);
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
// Mark the round parts at the bottom of a car as wheels (the ones at the front steer).
function findWheels() {
  const parts = [];
  model.traverse((o) => isPart(o) && parts.push(o));
  if (!parts.length) return toast('Build a car first!');
  const all = new THREE.Box3().setFromObject(model);
  const cz = (all.min.z + all.max.z) / 2;
  const low = all.min.y + (all.max.y - all.min.y) * 0.34;
  let n = 0;
  for (const part of parts) {
    const pb = new THREE.Box3().setFromObject(part);
    const round = part.userData.type === 'cylinder' || part.userData.type === 'ball' || /wheel/i.test(part.name);
    if (!round || pb.min.y > low) continue;
    const c = pb.getCenter(new THREE.Vector3());
    part.userData.role = c.z > cz ? 'frontwheel' : 'wheel';
    n++;
  }
  toast(n ? `Found ${n} wheel${n === 1 ? '' : 's'}! The front ones steer. 🔍` : 'No round parts near the bottom. Mark the wheels yourself: pick a part and set its job.');
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
  commit();
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
// ---- loop cut: the new ring floats with the mouse until you click to set it
let lcut = null; // { part, axis, c, lo, hi, center, line }
function sliceSelected(axis) {
  const n = state.selected;
  if (!n || !isPart(n)) return;
  cancelCut();
  const bb = new THREE.Box3().setFromBufferAttribute(n.geometry.attributes.position);
  const line = fatLines(SEL_COLOR, 4.5, { depthTest: false, offset: false });
  line.renderOrder = 45;
  n.add(line);
  lcut = { part: n, axis, c: gapMiddle(n.geometry, axis), lo: bb.min.getComponent(axis), hi: bb.max.getComponent(axis), center: bb.getCenter(new THREE.Vector3()), line };
  drawCut();
  renderToolbar();
  toast('✂️ Move the mouse to place the new ring, then click to set it. Esc cancels.');
}
function drawCut() {
  if (!lcut) return;
  const arr = [];
  for (const [a, b] of cutSegments(lcut.part.geometry, lcut.axis, lcut.c)) arr.push(...a, ...b);
  setFat(lcut.line, arr);
}
function cancelCut() {
  if (!lcut) return;
  const { line } = lcut;
  line.parent && line.parent.remove(line);
  line.geometry.dispose();
  fatMats.delete(line.material);
  line.material.dispose();
  lcut = null;
  renderToolbar();
}
function moveCut(e) {
  if (!lcut) return;
  const r = canvas.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const part = lcut.part;
  part.updateWorldMatrix(true, false);
  const inv = part.matrixWorld.clone().invert();
  const O = ray.ray.origin.clone().applyMatrix4(inv);
  const D = ray.ray.direction.clone().transformDirection(inv).normalize();
  const u = new THREE.Vector3();
  u.setComponent(lcut.axis, 1);
  const w0 = lcut.center.clone().sub(O);
  const b = u.dot(D);
  const denom = 1 - b * b;
  if (denom < 1e-3) return; // looking straight down the axis: no way to tell
  const t = (b * D.dot(w0) - u.dot(w0)) / denom;
  let c = lcut.center.getComponent(lcut.axis) + t;
  if (state.snap) c = Math.round(c / 0.05) * 0.05;
  const m = (lcut.hi - lcut.lo) * 0.01 + 1e-4;
  c = Math.min(lcut.hi - m, Math.max(lcut.lo + m, c));
  if (Math.abs(c - lcut.c) < 1e-6) return;
  lcut.c = c;
  drawCut();
}
function commitCut() {
  if (!lcut) return;
  const { part: n, axis, c } = lcut;
  cancelCut();
  const g = sliceGeometry(n.geometry, axis, c, n.userData.texScale);
  const oldIds = new Set(n.geometry.attributes.face.array);
  n.geometry.dispose();
  n.geometry = g;
  inheritFaceColors(n, oldIds, null, g.userData.farIds);
  syncTwin(n, true);
  state.tool = 'points';
  toast('New ring set! Drag the dots to reshape. ✏️');
  commit();
}
canvas.addEventListener('pointermove', moveCut);
canvas.addEventListener(
  'pointerdown',
  (e) => {
    if (!lcut) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    down = null;
    if (e.button === 0) {
      moveCut(e);
      commitCut();
    } else if (e.button === 2) cancelCut();
  },
  true,
);

function startWith(id) {
  if (partCount() > 0 && !confirm('Start something new? Your current model will be replaced. (You can undo.)')) return;
  leavePoseHistory();
  clearModel();
  const st = STARTERS[id];
  st.build(model);
  state.rig = st.rig;
  state.use = ['dog', 'cat', 'horse'].includes(id) ? 'mount' : null; // the premade animals can be ridden
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
  leavePoseHistory();
  clearModel();
  state.rig = null;
  state.use = null;
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
  const copies = groupParts().map((q) => {
    const c = deserialize(serializeNode(q), q.parent, { fresh: true });
    c.position.x += 0.15;
    c.name = q.name + ' copy';
    return c;
  });
  select(copies[0]);
  state.multi = copies.slice(1);
  refresh();
  commit();
}
function del() {
  const n = state.selected;
  if (!n || !isPart(n)) return;
  const all = groupParts();
  state.selected = null;
  state.multi = [];
  for (const q of all) q.parent && removeNode(q);
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
  if (state.mode === 'pose') {
    restoreRest();
    leavePoseHistory();
  }
  if (modal) endModal(false);
  model.traverse((o) => isPart(o) && ensureFaceColors(o));
  if (!play) {
    play = createPlay({
      renderer,
      canvas,
      toast,
      hud: $('#play'),
      cloneModel: () => cloneClean(model),
      getUse: () => ({ use: state.use, cfg: { ...state.useCfg }, name: state.name }),
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
  const btns = (act, rows) => rows.map(([id, l]) => `<button class="mini" data-act="${act}:${id}">${l}</button>`).join('');
  const sec = (title, body, open) => `<details class="msec"${open ? ' open' : ''}><summary>${title}</summary><div class="mrow">${body}</div></details>`;
  el.innerHTML = `
    <div id="playTop">
      <button data-act="mode:build" class="soft">◀ Back</button>
      <button id="burger" data-act="menu" class="soft" title="Open the menu" aria-expanded="false">☰ Menu</button>
      <button id="helpBtn" data-act="help" class="soft" title="Show or hide the controls (H)">❓ Controls</button>
      <span id="playState"></span>
      <span id="gearAmmo"></span>
    </div>
    <div id="playMenu" hidden>
      ${sec('🙂 Play as', who.map(([id, ic, l]) => `<button class="mini" data-act="playas:${id}" title="${l}">${ic} ${l}</button>`).join(''), true)}
      ${sec('🛹 Ride (V)', [['walk', '🚶', 'Walk'], ['skate', '🛹', 'Skateboard'], ['scooter', '🛴', 'Scooter'], ['blades', '🛼', 'Roller skates']]
        .map(([id, ic, l]) => `<button class="mini ${id === 'walk' ? 'on' : ''}" data-act="ride:${id}" title="${l}">${ic} ${l}</button>`).join(''))}
      ${sec('🗡️ Gear (Q)', '<div id="gearBar"></div>')}
      ${sec('🗺️ Go to (Y)', btns('zone', [['start', '🏠 Start'], ['skate', '🛹 Skate park'], ['city', '🏙️ City'], ['range', '🎯 Target range']]))}
      ${sec('🚗 Cars <small>press E next to one to drive</small>', btns('spawnveh', [['kart', '🏎️ Go-kart'], ['truck', '🛻 Truck'], ['hover', '🛸 Hovercraft'], ['mine', '🚗 My vehicle']]))}
      ${sec('🐴 Ride an animal', btns('mount', [['horse', '🐴 Horse'], ['dog', '🐶 Dog'], ['cat', '🐱 Cat'], ['mine', '🦄 My animal']]) + '<button class="mini" data-act="dismount">⬇️ Get off</button>')}
      ${sec('📂 My models', '<button class="mini" data-act="playload" title="Add a saved BlockBuddy model (.json) as a toy">📂 Add my saved model…</button>')}
    </div>
    <div id="cross" hidden>+</div>
    <div id="rideCombo" hidden></div>
    <div id="rideScore" hidden></div>
    <div id="playHelp">
      <b>🎮 Controls <button class="mini" data-act="help">✕ hide</button></b>
      <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move · <kbd>Shift</kbd> run · <kbd>Space</kbd> jump (twice for a double jump!)</span>
      <span><kbd>C</kbd> crouch · <kbd>X</kbd> crawl · <kbd>E</kbd> pick up / drop · click or <kbd>F</kbd> throw (hold to throw harder)</span>
      <span>🧗 Walk into the <b>brown wall</b> to climb · 🏃 Run and jump next to a wall to <b>wall run</b> · 🤸 Pink pad = bounce</span>
      <span>🛹 <kbd>V</kbd> swap ride (skateboard · scooter · roller skates): <kbd>W</kbd> push · <kbd>A</kbd><kbd>D</kbd> steer · <kbd>S</kbd> brake · <kbd>Space</kbd> ollie · in the air <kbd>J</kbd> <kbd>K</kbd> <kbd>L</kbd> tricks, <kbd>G</kbd> grab, hold <kbd>A</kbd>/<kbd>D</kbd> to spin. Land clean to bank your combo!</span>
      <span>🗡️ <kbd>Q</kbd> swap gear (foam swords, dart pistol, blaster, mega shooter) · click or <kbd>F</kbd> swing / shoot · <kbd>Z</kbd> reload · <kbd>Y</kbd> next zone. Pop balloons, hit the bullseyes, knock over dummies!</span>
      <span>🚗 <kbd>E</kbd> next to a car to drive: <kbd>W</kbd><kbd>S</kbd> gas / reverse · <kbd>A</kbd><kbd>D</kbd> steer · <kbd>Space</kbd> brake · <kbd>Shift</kbd> boost · <kbd>U</kbd> flip upright · <kbd>E</kbd> get out</span>
      <span><kbd>1</kbd> box · <kbd>2</kbd> ball · <kbd>3</kbd> <b>your model</b> as a toy · <kbd>R</kbd> new playground · <kbd>T</kbd> go back to start</span>
      <span>Click the picture to look around with the mouse (<kbd>Esc</kbd> lets go). Arrow keys also turn the camera. Scroll to zoom. <kbd>H</kbd> hides this box, <kbd>M</kbd> opens the menu.</span>
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
    enterPoseHistory();
    state.poseIdx = 0;
    state.selected = state.selected && isPart(state.selected) ? nearestJoint(state.selected) : state.selected;
  } else {
    restoreRest();
    leavePoseHistory();
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
function applyPose(i, record = false) {
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
  if (record) commit();
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
      leavePoseHistory();
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
  const USE_TIPS = {
    car: 'In Play, walk up to it and press E to drive. Pick the wheels and mark them Wheel or Front wheel, and a Seat.',
    hover: 'A hovercraft glides over the ground. Mark a Seat part to say where the driver sits.',
    mount: 'Needs bones like the premade animals. In Play, press 🦄 My animal to ride it. Mark a Saddle part if you want.',
    shooter: 'Pick a part and mark it Muzzle (where shots come out) and Grip (where the hand holds it). In Play it shows up in your gear (press Q).',
    swing: 'Mark a Grip part (where the hand holds it). The far end does the whacking. In Play it shows up in your gear (press Q).',
  };
  const useBlock = `<h3>What can it do? ⚙️</h3>
    <select id="useSel" class="sel">
      ${[['', 'Just a model'], ['car', '🚗 It drives (car)'], ['hover', '🛸 It hovers (hovercraft)'], ['mount', '🐴 You can ride it (animal)'], ['shooter', '🔫 It shoots things'], ['swing', '🗡️ You swing it']]
        .map(([v, l]) => `<option value="${v}" ${(state.use || '') === v ? 'selected' : ''}>${l}</option>`)
        .join('')}
    </select>
    ${
      state.use === 'shooter'
        ? `<label class="check"><span>Shoots</span><select id="projSel" class="sel" style="width:auto">${[['dart', 'Foam darts'], ['ball', 'Bouncy balls'], ['confetti', 'Confetti pops']]
            .map(([v, l]) => `<option value="${v}" ${state.useCfg.proj === v ? 'selected' : ''}>${l}</option>`)
            .join('')}</select></label>
      <label class="check"><input type="checkbox" id="autoChk" ${state.useCfg.auto ? 'checked' : ''}> Hold to keep shooting</label>`
        : ''
    }
    ${state.use === 'car' ? `<button class="wide" data-act="findwheels">🔍 Find the wheels for me</button>` : ''}
    ${state.use ? `<p class="tip small">${USE_TIPS[state.use]}</p>` : ''}`;
  el.innerHTML = `
    <h3>Add a shape</h3>
    <div class="grid3">${shapeBtns('add')}</div>
    <h3>Start with…</h3>
    <div class="grid3">${Object.entries(STARTERS)
      .map(([id, s]) => `<button class="tile" data-act="start:${id}"><span>${s.icon}</span>${s.label}</button>`)
      .join('')}</div>
    ${useBlock}
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
  if (lcut) {
    html = `<span class="label full" style="font-size:15px">✂️ Move the mouse to place the new ring · click = set it · Esc or right-click = cancel</span>`;
  } else if (modal) {
    html = `<span class="label full" style="font-size:15px">${esc(modal.label)} · X Y Z = axis · type a number · click or Enter = OK · Esc = cancel</span>`;
  } else if (state.sticking) {
    const p = byId(state.sticking);
    html = `<span class="label">📎 Click ${p && isJoint(p) ? 'the bone to hang' : 'what to stick'} “${esc(p ? p.name : '')}” ${p && isJoint(p) ? 'under (an orange dot)' : 'onto (a shape or an orange bone)'}</span><button data-act="cancelstick">Cancel</button>`;
  } else if (state.mode === 'pose') {
    html = n
      ? `<span class="label">🦴 ${esc(n.name)} — drag the rings to bend</span>`
      : `<span class="label">Click a body part to bend it</span>`;
  } else if (!n) {
    html = `<span class="label">👆 Click a shape to pick it · Shift+click picks more</span><button class="tool" data-act="selallparts"><span>☑️</span>All shapes</button>`;
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
      : state.emode === 'face' ? 'Click a face' : state.emode === 'edge' ? 'Click an edge' : 'Click a dot';
    html =
      `<button class="tool" data-act="tool:move"><span>◀</span>Done</button><i class="sep"></i>` +
      em('dot', '⚪', 'Dots') + em('edge', '➖', 'Edges') + em('face', '▣', 'Faces') +
      `<i class="sep"></i>` +
      gz('select', '⬚', 'Select') + gz('move', '↔️', 'Move') + gz('turn', '🔄', 'Turn') + gz('size', '⤡', 'Size') +
      `<i class="sep"></i><button class="tool" data-act="extrude" ${can ? '' : 'disabled'}><span>⬆️</span>Extrude</button>` +
      `<i class="sep"></i><button class="tool ${state.boxSel ? 'on' : ''}" data-act="boxsel" title="Drag a box to pick many. Right-drag moves the picture, scroll zooms."><span>⬚</span>Box</button>` +
      `<button class="tool" data-act="selall" title="A"><span>☑️</span>All</button><button class="tool" data-act="selnone" title="Alt+A"><span>☐</span>None</button><button class="tool" data-act="selinv" title="Ctrl+I"><span>🔁</span>Flip</button>` +
      `<span class="label full">${hint} · Shift+click = pick more · Select tool or Box = drag a box (no gizmo)</span>`;
  } else {
    const t = (id, icon, label) =>
      `<button class="tool ${state.tool === id ? 'on' : ''}" data-act="tool:${id}"><span>${icon}</span>${label}</button>`;
    html =
      t('select', '⬚', 'Select') +
      t('move', '↔️', 'Move') +
      t('turn', '🔄', 'Turn') +
      t('size', '⤡', 'Size') +
      t('points', '✏️', 'Points') +
      (state.advanced ? t('paint', '🖌️', 'Paint') : '') +
      (state.tool === 'paint' ? `<span class="label">Click a face to paint it <i class="chip" style="background:${state.brushColor}"></i></span>` : '') +
      `<i class="sep"></i><button class="tool" data-act="selallparts" title="A"><span>☑️</span>All shapes</button>` +
      (state.multi.length ? `<span class="label">${state.multi.length + 1} shapes picked · move, turn, size, color or delete them together</span>` : `<span class="label">Shift+click adds more shapes</span>`);
  }
  el.innerHTML = html;
  el.classList.toggle('hidden', false);
}

function groupBlock() {
  if (!state.multi.length) return '';
  const ps = groupParts();
  return `<div class="sec"><b>☑️ ${ps.length} shapes picked</b>
    <div class="chips">${ps.map((q, i) => `<button class="mini gchip ${i === 0 ? 'main' : ''}" data-act="ungrp:${q.userData.id}" title="${i === 0 ? 'The main one (yellow)' : 'Orange'}: click to take it out">${i === 0 ? '⭐ ' : ''}${esc(q.name)} ✕</button>`).join('')}</div>
    <p class="tip small">Yellow outline = main one, orange = the others. Color, pattern, move, turn, size, copy and delete work on all of them.</p></div>`;
}
function renderRight() {
  const n = state.selected;
  const el = $('#right');
  renderRight0(n, el);
  if (n && state.multi.length) el.insertAdjacentHTML('afterbegin', groupBlock());
}
function renderRight0(n, el) {
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
  const ROLE_OPTS = {
    car: [['', 'Just a shape'], ['wheel', 'Wheel (spins)'], ['frontwheel', 'Front wheel (spins and steers)'], ['seat', 'Seat']],
    hover: [['', 'Just a shape'], ['seat', 'Seat']],
    mount: [['', 'Just a shape'], ['seat', 'Saddle (where the rider sits)']],
    shooter: [['', 'Just a shape'], ['muzzle', 'Muzzle (shots come out here)'], ['grip', 'Grip (hand holds here)']],
    swing: [['', 'Just a shape'], ['grip', 'Grip (hand holds here)']],
  }[state.use];
  const roleBlock = ROLE_OPTS
    ? `<div class="sec"><b>Job in the ${{ car: 'car 🚗', hover: 'hovercraft 🛸', mount: 'animal 🐴', shooter: 'shooter 🔫', swing: 'swinger 🗡️' }[state.use]}</b>
      <select id="roleSel" class="sel">${ROLE_OPTS.map(([v, l]) => `<option value="${v}" ${(n.userData.role || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`
    : '';
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
    ${roleBlock}
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
  if (lcut && act !== 'slice') cancelCut();
  switch (act) {
    case 'add': return addShape(arg);
    case 'start': return startWith(arg);
    case 'tool':
      state.tool = arg;
      return refresh();
    case 'mode': return setMode(arg);
    case 'menu': {
      const m = $('#playMenu');
      m.hidden = !m.hidden;
      $('#burger').setAttribute('aria-expanded', String(!m.hidden));
      break;
    }
    case 'help': {
      const h = $('#playHelp');
      h.hidden = !h.hidden;
      break;
    }
    case 'playas':
      return play && play.setCharacter(arg);
    case 'ride':
      return play && play.setRide(arg);
    case 'gear':
      return play && play.setGear(arg);
    case 'zone':
      return play && play.goZone(arg);
    case 'spawnveh':
      return play && play.spawnVehicleNear(arg);
    case 'mount':
      return play && play.mount(arg);
    case 'dismount':
      return play && play.dismount();
    case 'playload':
      return $('#playFile').click();
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
    case 'findwheels': return findWheels();
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
    case 'ungrp': {
      const q = byId(arg);
      if (q) toggleGroup(q);
      return;
    }
    case 'selallparts': return selectAllParts();
    case 'boxsel':
      state.boxSel = !state.boxSel;
      return renderToolbar();
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
      for (const q of n ? groupParts() : []) setPaint(q, { color: arg });
      return commit();
    case 'pat':
      for (const q of n ? groupParts() : []) setPaint(q, { pattern: arg, image: null });
      return commit();
    case 'pic': return $('#picFile').click();
    case 'dup': return duplicate();
    case 'del': return del();
    case 'pose': return applyPose(+arg, true);
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
  } else if (id === 'useSel') {
    state.use = e.target.value || null;
    commit();
  } else if (id === 'projSel') {
    state.useCfg = { ...state.useCfg, proj: e.target.value };
    commit();
  } else if (id === 'autoChk') {
    state.useCfg = { ...state.useCfg, auto: e.target.checked };
    commit();
  } else if (id === 'roleSel' && n) {
    n.userData.role = e.target.value || null;
    const t = twinOf(n);
    if (t) t.userData.role = n.userData.role;
    commit();
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
  else if (id === 'playFile') {
    for (const f of e.target.files) f.text().then((t) => {
      try {
        play && play.addDoc(JSON.parse(t), f.name.replace(/\.[^.]+$/, ''));
      } catch (err) {
        toast("That file isn't a BlockBuddy model: " + err.message);
      }
    });
    e.target.value = '';
  } else if (id === 'openFile' && e.target.files[0]) {
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
  if (lcut) {
    if (e.code === 'Escape') cancelCut();
    return;
  }
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
  } else if (c === 'KeyA' && !editing) selectAllParts();
  else if (c === 'KeyG' || c === 'KeyR' || c === 'KeyS') startModal({ KeyG: 'move', KeyR: 'turn', KeyS: 'size' }[c]);
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
// drop a saved .json model onto the playground to add it
window.addEventListener('dragover', (e) => state.mode === 'play' && e.preventDefault());
window.addEventListener('drop', (e) => {
  if (state.mode !== 'play' || !e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  for (const f of e.dataTransfer.files)
    if (/\.json$/i.test(f.name))
      f.text().then((t) => {
        try {
          play.addDoc(JSON.parse(t), f.name.replace(/\.[^.]+$/, ''));
        } catch (err) {
          toast("That file isn't a BlockBuddy model: " + err.message);
        }
      });
});

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
  window.__bb = { THREE, pts: () => pts, psel: () => psel, pivot, selectEls, pickEl, commitCut, loadDocJSON: (j) => loadDoc(JSON.parse(j)), state, model, scene, camera, orbit, transform, select, byId, registry, docJSON, applyPose, setMode, commit, undo, redo };
})();
