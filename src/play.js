import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { STARTERS } from './rigs.js';
import { registry, deserialize } from './nodes.js';
import { RIDES, RIDE_ORDER, TRICKS, buildVehicle, buildSkate } from './ride.js';
import { GEAR, GEAR_ORDER, buildGear, buildDart } from './gear.js';

// ============================================================================
// Play mode: a physics sandbox for testing models.
//  - a character controller (run, jump, double jump, crouch, crawl, climb, wall run,
//    pick up, throw, bounce pads, birds can flap)
//  - procedural IK: feet step onto the ground (stairs, ramps), hands reach for things.
//    Works on any model that names its limbs like the premade buddies:
//    (Left|Right)(Shoulder|Hip) -> Knee/Elbow -> Fetlock/Wrist/Ankle.
// ============================================================================

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const smooth = (t) => t * t * (3 - 2 * t);
const UP = V(0, 1, 0);
const WORLD = 1;
const PLAYER = 2;
const HELD = 4;
const DART = 8;
const ALL = 15; // WORLD | PLAYER | HELD | DART: collides with everything
const GRAVITY = 24;
const isJoint = (o) => !!o && o.userData && o.userData.kind === 'joint';
const childJoints = (j) => j.children.filter(isJoint);
const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

// A copy of the editor model without editor-only helpers (markers, outlines).
export function cloneClean(root) {
  const saved = [];
  root.traverse((o) => {
    saved.push([o, o.userData]);
    const u = o.userData || {};
    o.userData = { kind: u.kind, helper: !!u.helper, role: u.role || null };
  });
  const c = root.clone(true);
  saved.forEach(([o, u]) => (o.userData = u));
  const rm = [];
  c.traverse((o) => o.userData && o.userData.helper && rm.push(o));
  rm.forEach((o) => o.parent && o.parent.remove(o));
  c.traverse((o) => {
    if (o.isMesh) {
      o.material = o.material.clone();
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return c;
}
const hasJoints = (root) => {
  let n = false;
  root.traverse((o) => isJoint(o) && (n = true));
  return n;
};

export function createPlay(ctx) {
  const { renderer, canvas, toast } = ctx;
  let running = false;
  let scene, camera, world, sun, hemi;
  let dyn = []; // dynamic things: { body, mesh }
  let statics = [];
  let props = []; // things you can pick up
  let held = null;
  let P = null; // the player
  let charId = 'mine';
  const keys = new Set();
  const pressedOnce = new Set();
  let camYaw = 0;
  let camPitch = 0.28;
  let camZoom = 1;
  let ws = 1; // world scale (small animals get a smaller playground)
  let last = 0;
  let mouseDown = false;
  const ownGeos = [];
  const rcResult = new CANNON.RaycastResult();
  const hud = ctx.hud;

  // ------------------------------------------------------------------ physics helpers
  function ray(from, to, mask = WORLD) {
    rcResult.reset();
    const hit = world.raycastClosest(new CANNON.Vec3(from.x, from.y, from.z), new CANNON.Vec3(to.x, to.y, to.z), { collisionFilterMask: mask, skipBackfaces: true }, rcResult);
    if (!hit) return null;
    return {
      point: V(rcResult.hitPointWorld.x, rcResult.hitPointWorld.y, rcResult.hitPointWorld.z),
      normal: V(rcResult.hitNormalWorld.x, rcResult.hitNormalWorld.y, rcResult.hitNormalWorld.z),
      body: rcResult.body,
      distance: rcResult.distance,
    };
  }
  const rayDir = (from, dir, len, mask) => ray(from, from.clone().addScaledVector(dir, len), mask);
  const groundYAt = (x, z, nearY) => {
    const h = ray(V(x, nearY + 0.9 * ws, z), V(x, nearY - 1.6 * ws, z));
    return h ? h.point.y : nearY;
  };

  // ------------------------------------------------------------------ world
  const pat = (a, b) => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const c = cv.getContext('2d');
    c.fillStyle = a;
    c.fillRect(0, 0, 64, 64);
    c.fillStyle = b;
    c.fillRect(0, 0, 32, 32);
    c.fillRect(32, 32, 32, 32);
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  function addBox({ size, pos, rot = [0, 0, 0], color = 0xdddddd, mass = 0, climb = false, bounce = false, launch = false, pickable = false, tex = null, restitution = 0, solid = true }) {
    const s = size.map((v) => v * ws);
    const g = new THREE.BoxGeometry(s[0], s[1], s[2]);
    ownGeos.push(g);
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, map: tex || null });
    if (tex) tex.repeat.set(Math.max(1, s[0] / 2), Math.max(1, s[2] / 2));
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(pos[0] * ws, pos[1] * ws, pos[2] * ws);
    mesh.rotation.set(rot[0], rot[1], rot[2]);
    scene.add(mesh);
    if (!solid) return mesh;
    const body = new CANNON.Body({ mass: mass * ws ** 3, material: mass ? propMat : groundMat });
    body.addShape(new CANNON.Box(new CANNON.Vec3(s[0] / 2, s[1] / 2, s[2] / 2)));
    body.position.set(mesh.position.x, mesh.position.y, mesh.position.z);
    body.quaternion.setFromEuler(rot[0], rot[1], rot[2]);
    body.collisionFilterGroup = WORLD;
    body.collisionFilterMask = ALL;
    body.userData = { climb, bounce, launch, pickable, mesh, size: Math.max(...s), mass };
    lastBody = body;
    if (restitution) body.material = bounceMat;
    world.addBody(body);
    if (mass) {
      dyn.push({ body, mesh });
      if (pickable) props.push(body);
    } else statics.push(body);
    return mesh;
  }
  function addBall({ r, pos, color = 0xff6b6b, mass = 1 }) {
    const rr = r * ws;
    const g = new THREE.SphereGeometry(rr, 20, 14);
    ownGeos.push(g);
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.5 }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(pos[0] * ws, pos[1] * ws, pos[2] * ws);
    scene.add(mesh);
    const body = new CANNON.Body({ mass: mass * ws ** 3, material: ballMat });
    body.addShape(new CANNON.Sphere(rr));
    body.position.copy(mesh.position);
    body.collisionFilterGroup = WORLD;
    body.collisionFilterMask = ALL;
    body.linearDamping = 0.05;
    body.angularDamping = 0.2;
    body.userData = { pickable: true, mesh, size: rr * 2, mass };
    world.addBody(body);
    dyn.push({ body, mesh });
    props.push(body);
    return body;
  }
  function sign(text, pos) {
    const cv = document.createElement('canvas');
    cv.width = 512;
    cv.height = 128;
    const c = cv.getContext('2d');
    c.fillStyle = 'rgba(255,255,255,0.92)';
    c.beginPath();
    c.roundRect(4, 4, 504, 120, 30);
    c.fill();
    c.fillStyle = '#4c2fbf';
    c.font = 'bold 64px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, 256, 68);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
    sp.scale.set(5 * ws, 1.25 * ws, 1);
    sp.position.set(pos[0] * ws, pos[1] * ws, pos[2] * ws);
    scene.add(sp);
  }
  let groundMat, propMat, ballMat, bounceMat, playerMat;
  let rails = [];
  let lastBody = null;
  let balloons = [];
  let dummies = [];
  let respawns = [];
  let darts = [];
  let fx = [];
  let popups = [];

  function buildScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x9fd8ff);
    scene.fog = new THREE.Fog(0x9fd8ff, 70, 230);
    hemi = new THREE.HemisphereLight(0xffffff, 0x7a8b6a, 1.55);
    scene.add(hemi);
    sun = new THREE.DirectionalLight(0xffffff, 2.3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -28;
    sc.right = sc.top = 28;
    sc.near = 1;
    sc.far = 120;
    sun.shadow.bias = -0.0004;
    scene.add(sun, sun.target);

    world = new CANNON.World();
    world.gravity.set(0, -GRAVITY, 0);
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.allowSleep = true;
    world.defaultContactMaterial.friction = 0.4;
    world.defaultContactMaterial.restitution = 0.02;
    groundMat = new CANNON.Material('ground');
    propMat = new CANNON.Material('prop');
    ballMat = new CANNON.Material('ball');
    bounceMat = new CANNON.Material('bounce');
    playerMat = new CANNON.Material('player');
    world.addContactMaterial(new CANNON.ContactMaterial(playerMat, groundMat, { friction: 0, restitution: 0 }));
    world.addContactMaterial(new CANNON.ContactMaterial(playerMat, propMat, { friction: 0, restitution: 0 }));
    world.addContactMaterial(new CANNON.ContactMaterial(playerMat, ballMat, { friction: 0, restitution: 0 }));
    world.addContactMaterial(new CANNON.ContactMaterial(playerMat, bounceMat, { friction: 0, restitution: 0 }));
    world.addContactMaterial(new CANNON.ContactMaterial(ballMat, groundMat, { friction: 0.3, restitution: 0.65 }));
    world.addContactMaterial(new CANNON.ContactMaterial(ballMat, propMat, { friction: 0.3, restitution: 0.4 }));
    world.addContactMaterial(new CANNON.ContactMaterial(ballMat, ballMat, { friction: 0.2, restitution: 0.7 }));
    world.addContactMaterial(new CANNON.ContactMaterial(propMat, groundMat, { friction: 0.6, restitution: 0.05 }));
    world.addContactMaterial(new CANNON.ContactMaterial(propMat, propMat, { friction: 0.5, restitution: 0.05 }));
    world.addEventListener('preStep', preStep);

  }

  function buildContents() {
    // ground
    addBox({ size: [400, 2, 400], pos: [0, -1, 0], color: 0xffffff, tex: pat('#79c26a', '#6fb860') });

    // --- parkour: ramp, stairs, jumping platforms
    sign('PARKOUR', [2, 4.2, 12]);
    addBox({ size: [3, 0.3, 7], pos: [-4, 1.1, 11], rot: [-0.3, 0, 0], color: 0xffb703 });
    for (let i = 0; i < 9; i++) addBox({ size: [3, 0.22 * (i + 1), 0.7], pos: [3, 0.11 * (i + 1), 8 + i * 0.7], color: i % 2 ? 0xfb8500 : 0xffb703 });
    [[0, 0.6, 18], [3, 1.2, 21], [6.5, 1.9, 23.5], [10.5, 2.7, 25], [14.5, 3.6, 25.5]].forEach(([x, h, z], i) =>
      addBox({ size: [2.6, 0.4, 2.6], pos: [x, h - 0.2, z], color: [0x8ecae6, 0x219ebc, 0x8ecae6, 0x219ebc, 0xfb8500][i] }),
    );

    // --- climbing wall (grab it by walking into it)
    sign('CLIMB', [14, 8.8, -3]);
    addBox({ size: [0.6, 7.5, 9], pos: [16, 3.75, -6], color: 0xb08968, climb: true });
    addBox({ size: [4.5, 0.6, 9], pos: [18.5, 7.2, -6], color: 0x8d6e53 });
    for (let i = 0; i < 40; i++) {
      const y = 0.4 + Math.random() * 6.8;
      const z = -9.8 + Math.random() * 7.6;
      addBox({ size: [0.2, 0.18, 0.28], pos: [15.6, y, z], color: [0xef476f, 0xffd166, 0x06d6a0, 0x118ab2][i % 4], solid: false });
    }

    // --- wall run corridor
    sign('WALL RUN', [-14, 6.4, 1]);
    addBox({ size: [0.6, 5.5, 30], pos: [-11.5, 2.75, 16], color: 0x9d4edd });
    addBox({ size: [0.6, 5.5, 30], pos: [-16.5, 2.75, 16], color: 0x7b2cbf });
    addBox({ size: [3, 0.3, 3], pos: [-14, 0.15, 3], color: 0xffd166 });

    // --- crawl tunnel and crouch beam
    sign('CRAWL & CROUCH', [0, 4, -8]);
    addBox({ size: [3.4, 0.3, 0.7], pos: [0, 1.35, -10], color: 0xef476f });
    addBox({ size: [3.4, 0.4, 9], pos: [0, 1.0, -17], color: 0x5c677d });
    addBox({ size: [0.4, 1.2, 9], pos: [-1.8, 0.6, -17], color: 0x7d8597 });
    addBox({ size: [0.4, 1.2, 9], pos: [1.8, 0.6, -17], color: 0x7d8597 });

    // --- physics playground
    sign('PHYSICS', [-8, 4, -9]);
    for (let row = 0; row < 5; row++) for (let i = 0; i < 5 - row; i++)
      addBox({ size: [0.55, 0.55, 0.55], pos: [-8 + (i - (4 - row) / 2) * 0.58, 0.28 + row * 0.56, -12], mass: 2, color: [0xef476f, 0xffd166, 0x06d6a0, 0x118ab2, 0x9d4edd][row], pickable: true });
    for (let row = 0; row < 4; row++) for (let i = 0; i <= row; i++)
      addBox({ size: [0.2, 0.7, 0.2], pos: [-12 + (i - row / 2) * 0.45, 0.35, -5 - row * 0.45], mass: 0.8, color: 0xffffff, pickable: true });
    // trampoline and launch ramp
    sign('BOUNCE!', [9, 4, -1]);
    addBox({ size: [3, 0.25, 3], pos: [9, 0.12, 1], color: 0xff5d8f, bounce: true });
    addBox({ size: [3, 0.3, 4], pos: [5, 0.7, -7], rot: [0.35, 0, 0], color: 0x06d6a0 });
    // things to play with
    const cols = [0xef476f, 0xffd166, 0x06d6a0, 0x118ab2, 0x9d4edd, 0xfb8500];
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const rr = 3.5 + (i % 3) * 1.1;
      const sz = 0.35 + (i % 4) * 0.12;
      if (i % 3 === 0) addBall({ r: 0.22 + (i % 4) * 0.06, pos: [Math.cos(a) * rr, 0.6, Math.sin(a) * rr - 1], color: cols[i % 6], mass: 0.6 });
      else addBox({ size: [sz, sz, sz], pos: [Math.cos(a) * rr, sz / 2 + 0.05, Math.sin(a) * rr - 1], mass: 1.2 * (sz / 0.4) ** 2, color: cols[i % 6], pickable: true, rot: [0, a, 0] });
    }
    // a wall of cans to knock over
    for (let row = 0; row < 4; row++) for (let i = 0; i < 6; i++)
      addBox({ size: [0.5, 0.5, 0.5], pos: [-3 + i * 0.52, 0.26 + row * 0.52, 14.5 + (row % 2) * 0.02], mass: 1, color: cols[(i + row) % 6], pickable: true });
    // a few trees for scenery
    for (let i = 0; i < 16; i++) {
      const a = i * 2.4;
      const rr = 38 + (i % 5) * 7;
      if (Math.cos(a) * rr < -28 || (Math.sin(a) * rr < -15 && Math.cos(a) * rr > 0 && Math.cos(a) * rr < 45)) continue;
      const tx = Math.cos(a) * rr * ws;
      const tz = Math.sin(a) * rr * ws;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25 * ws, 0.35 * ws, 2 * ws, 8), new THREE.MeshStandardMaterial({ color: 0x8d6e63 }));
      const top = new THREE.Mesh(new THREE.ConeGeometry(1.6 * ws, 4 * ws, 9), new THREE.MeshStandardMaterial({ color: 0x2d9b4f }));
      trunk.position.set(tx, ws, tz);
      top.position.set(tx, 4 * ws, tz);
      trunk.castShadow = top.castShadow = true;
      scene.add(trunk, top);
      ownGeos.push(trunk.geometry, top.geometry);
    }
    buildSkatePark();
    buildRange();
    buildCity();
    buildVehicles();
  }


  // ------------------------------------------------------------------ the skate park
  function quarterPipe({ x, z, width, R, dir, color }) {
    const N = 12;
    for (let k = 0; k < N; k++) {
      const t0 = (k * Math.PI) / 2 / N;
      const t1 = ((k + 1) * Math.PI) / 2 / N;
      const tm = (t0 + t1) / 2;
      const p0 = [x + dir * R * Math.sin(t0), R - R * Math.cos(t0)];
      const p1 = [x + dir * R * Math.sin(t1), R - R * Math.cos(t1)];
      const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
      const chord = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const nx = -dir * Math.sin(tm);
      const ny = Math.cos(tm);
      addBox({ size: [chord + 0.06, 0.4, width], pos: [mid[0] - nx * 0.2, mid[1] - ny * 0.2, z], rot: [0, 0, Math.atan2(Math.sin(tm), dir * Math.cos(tm))], color });
    }
    addBox({ size: [3, 0.4, width], pos: [x + dir * (R + 1.5), R - 0.2, z], color: 0x9aa5b1 }); // flat deck on top
  }
  // a grind rail; a and b are the two ends of its top surface
  function addRail(a, b) {
    const A = V(a[0] * ws, a[1] * ws, a[2] * ws);
    const B = V(b[0] * ws, b[1] * ws, b[2] * ws);
    const dir = B.clone().sub(A);
    const len = dir.length();
    dir.normalize();
    const thick = 0.09 * ws;
    const g = new THREE.BoxGeometry(thick, thick, len);
    ownGeos.push(g);
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xd1d5db, metalness: 0.7, roughness: 0.3 }));
    m.castShadow = true;
    const q = new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), dir);
    m.quaternion.copy(q);
    m.position.copy(A.clone().add(B).multiplyScalar(0.5)).addScaledVector(UP, -thick / 2);
    scene.add(m);
    const body = new CANNON.Body({ mass: 0, material: groundMat });
    body.addShape(new CANNON.Box(new CANNON.Vec3(thick / 2, thick / 2, len / 2)));
    body.position.set(m.position.x, m.position.y, m.position.z);
    body.quaternion.set(q.x, q.y, q.z, q.w);
    body.collisionFilterGroup = WORLD;
    body.collisionFilterMask = ALL;
    body.userData = { rail: true };
    world.addBody(body);
    statics.push(body);
    rails.push({ body, a: A, b: B, dir, len, thick });
    for (const e of [a, b]) addBox({ size: [0.1, e[1] - 0.05, 0.1], pos: [e[0], (e[1] - 0.05) / 2, e[2]], color: 0x64748b, solid: false });
  }
  function buildSkatePark() {
    rails = [];
    sign('SKATE PARK', [42, 6.8, 2]);
    addBox({ size: [34, 0.3, 36], pos: [42, -0.14, 15], color: 0xb8c0cc });
    quarterPipe({ x: 36, z: 10, width: 8, R: 3, dir: -1, color: 0xc7ced9 });
    quarterPipe({ x: 46, z: 10, width: 8, R: 3, dir: 1, color: 0xc7ced9 });
    addRail([35, 0.55, 22], [44, 0.55, 22]);
    addRail([46, 1.4, 22], [53, 0.3, 22]);
    addBox({ size: [3, 0.3, 4], pos: [40, 0.4, 28.5], rot: [-0.33, 0, 0], color: 0xffb703 }); // kicker
    addBox({ size: [5, 0.7, 5], pos: [48, 0.35, 29], color: 0xa3b1c2 }); // fun box
    addBox({ size: [5, 0.3, 3], pos: [48, 0.33, 25.9], rot: [0.28, 0, 0], color: 0xffb703 });
    addBox({ size: [6, 0.5, 1], pos: [38, 0.25, 17], color: 0x9aa5b1 }); // ledge
  }


  // ------------------------------------------------------------------ target range
  function addBalloon(pos, color) {
    const rr = 0.32 * ws;
    const g = new THREE.SphereGeometry(rr, 14, 10);
    ownGeos.push(g);
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.25, metalness: 0.1 }));
    mesh.scale.set(1, 1.18, 1);
    mesh.castShadow = true;
    const home = V(pos[0] * ws, pos[1] * ws, pos[2] * ws);
    mesh.position.copy(home);
    const sg = new THREE.BufferGeometry().setFromPoints([V(0, -rr * 1.2, 0), V(0, -rr * 1.2 - 1.4 * ws, 0)]);
    ownGeos.push(sg);
    mesh.add(new THREE.Line(sg, new THREE.LineBasicMaterial({ color: 0xcbd5e1 })));
    scene.add(mesh);
    const body = new CANNON.Body({ mass: 0, material: ballMat });
    body.addShape(new CANNON.Sphere(rr * 1.05));
    body.position.set(home.x, home.y, home.z);
    body.collisionFilterGroup = WORLD;
    body.collisionFilterMask = DART | HELD | WORLD; // you walk through balloons; darts and thrown things pop them
    body.userData = { balloon: true, mesh, size: rr * 2, color, pos, home, phase: Math.random() * 6 };
    world.addBody(body);
    balloons.push(body);
  }
  function addBull(pos, size) {
    addBox({ size: [size, size, 0.25], pos, color: 0x94a3b8 });
    const body = lastBody;
    body.userData.bull = true;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const c = cv.getContext('2d');
    [['#ef4444', 128], ['#ffffff', 100], ['#ef4444', 72], ['#ffffff', 44], ['#fde047', 20]].forEach(([col, r]) => {
      c.fillStyle = col;
      c.beginPath();
      c.arc(128, 128, r, 0, 7);
      c.fill();
    });
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(size * ws * 0.96, size * ws * 0.96), new THREE.MeshBasicMaterial({ map: tex }));
    ownGeos.push(plane.geometry);
    plane.position.set(0, 0, (0.125 + 0.004) * ws);
    body.userData.mesh.add(plane);
  }
  function addDummy(pos, color) {
    const m = addBox({ size: [0.55, 1.35, 0.3], pos, mass: 4, color, pickable: true });
    const body = lastBody;
    body.userData.dummy = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24 * ws, 14, 10), new THREE.MeshStandardMaterial({ color: 0xfde68a }));
    ownGeos.push(head.geometry);
    head.position.set(0, (1.35 / 2 + 0.2) * ws, 0);
    head.castShadow = true;
    m.add(head);
    dummies.push({ body, home: { p: body.position.clone(), q: body.quaternion.clone() }, scored: false, downT: 0 });
  }
  function buildRange() {
    sign('TARGET RANGE', [20, 6, -22]);
    addBox({ size: [18, 5.5, 0.5], pos: [20, 2.75, -35.5], color: 0x64748b });
    addBull([14.5, 2.4, -35.1], 2);
    addBull([20, 3.4, -35.1], 2);
    addBull([25.5, 2.4, -35.1], 2);
    addBox({ size: [18, 0.9, 0.3], pos: [20, 0.45, -23], color: 0x94a3b8 });
    const cols = [0xef476f, 0xffd166, 0x06d6a0, 0x118ab2, 0x9d4edd, 0xfb8500];
    for (let i = 0; i < 12; i++) addBalloon([12 + (i % 6) * 3.1 + (i > 5 ? 1.4 : 0), 2.4 + (i % 3) * 1.7 + (i > 5 ? 1 : 0), -26.5 - (i > 5 ? 3 : 0)], cols[i % 6]);
    for (let i = 0; i < 5; i++) addDummy([13 + i * 3.4, 0.7, -30.5], cols[(i + 2) % 6]);
  }

  // ------------------------------------------------------------------ the city
  const facadeCache = {};
  function facade(i) {
    if (facadeCache[i]) return facadeCache[i];
    const pal = [['#e7c9a9', '#5b7a99'], ['#c9d6df', '#334e68'], ['#e8b4b8', '#52606d'], ['#d9e4dd', '#3d5a80'], ['#f0e3b2', '#3f5f6a'], ['#c7b8ea', '#4a4e69']][i % 6];
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const c = cv.getContext('2d');
    c.fillStyle = pal[0];
    c.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) {
        c.fillStyle = Math.random() < 0.3 ? '#ffe9a8' : pal[1];
        c.fillRect(10 + x * 58, 12 + y * 58, 44, 40);
        c.fillStyle = 'rgba(0,0,0,.18)';
        c.fillRect(10 + x * 58, 12 + y * 58, 44, 4);
      }
    facadeCache[i] = cv;
    return cv;
  }
  function addBuilding(x, z, w, d, h, style) {
    const cv = facade(style);
    const mk = (faceW) => {
      const t = new THREE.CanvasTexture(cv);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.repeat.set(Math.max(1, Math.round(faceW / 3.4)), Math.max(1, Math.round(h / 3.6)));
      return new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 });
    };
    const mx = mk(d);
    const mz = mk(w);
    const roof = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.95 });
    const g = new THREE.BoxGeometry(w * ws, h * ws, d * ws);
    ownGeos.push(g);
    const mesh = new THREE.Mesh(g, [mx, mx, roof, roof, mz, mz]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(x * ws, (0.18 + h / 2) * ws, z * ws);
    scene.add(mesh);
    const body = new CANNON.Body({ mass: 0, material: groundMat });
    body.addShape(new CANNON.Box(new CANNON.Vec3((w * ws) / 2, (h * ws) / 2, (d * ws) / 2)));
    body.position.copy(mesh.position);
    body.collisionFilterGroup = WORLD;
    body.collisionFilterMask = ALL;
    body.userData = { climb: true, mesh, size: Math.max(w, h, d) * ws, mass: 0 };
    world.addBody(body);
    statics.push(body);
    return mesh;
  }
  function buildCity() {
    let seed = 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const CX = -92;
    const BW = 18;
    const ST = 9;
    const COLS = 4;
    const ROWS = 5;
    const pitch = BW + ST;
    sign('CITY', [-34, 7.5, 0]);
    sign('Climb everything! Run the rooftops!', [-45, 12, 0]);
    addBox({ size: [COLS * pitch + ST, 0.3, ROWS * pitch + ST], pos: [CX, -0.14, 0], color: 0x3a3f4a });
    // street lines
    for (let r = 0; r <= ROWS; r++) addBox({ size: [COLS * pitch + ST, 0.02, 0.18], pos: [CX, 0.02, (r - ROWS / 2) * pitch], color: 0xfde68a, solid: false });
    for (let c = 0; c <= COLS; c++) addBox({ size: [0.18, 0.02, ROWS * pitch + ST], pos: [CX + (c - COLS / 2) * pitch, 0.02, 0], color: 0xfde68a, solid: false });
    const roofs = [];
    for (let col = 0; col < COLS; col++)
      for (let row = 0; row < ROWS; row++) {
        const bx = CX + (col - (COLS - 1) / 2) * pitch;
        const bz = (row - (ROWS - 1) / 2) * pitch;
        addBox({ size: [BW + 2, 0.18, BW + 2], pos: [bx, 0.0, bz], color: 0xbfc4cc }); // sidewalk, a curb to skate off
        if (col === 1 && row === 2) {
          cityPlaza(bx, bz);
          continue;
        }
        const pat = Math.floor(rnd() * 3);
        const base = 7 + rnd() * 20;
        const tower = rnd() < 0.14;
        const H = (tower ? 36 + rnd() * 12 : base);
        const S = Math.floor(rnd() * 6);
        if (pat === 0) roofs.push(addBuildingFull(bx, bz, BW - 3, BW - 3, H, S, rnd));
        else if (pat === 1) {
          // two buildings of the same height with an alley and a sky bridge between them
          const aw = 5;
          const w2 = (BW - 3 - aw) / 2;
          const h2 = 8 + rnd() * 14;
          roofs.push(addBuildingFull(bx - (aw + w2) / 2, bz, w2, BW - 3, h2, S, rnd));
          roofs.push(addBuildingFull(bx + (aw + w2) / 2, bz, w2, BW - 3, h2, (S + 1) % 6, rnd));
          addBox({ size: [aw + 1.2, 0.35, 2.6], pos: [bx, 0.18 + h2 - 0.18, bz + (rnd() - 0.5) * 6], color: 0x7d8597 });
        } else {
          const q = (BW - 3 - 3) / 2;
          for (let i = 0; i < 4; i++) roofs.push(addBuildingFull(bx + (i % 2 ? 1 : -1) * (q / 2 + 1.5), bz + (i < 2 ? -1 : 1) * (q / 2 + 1.5), q, q, 5 + rnd() * 16, (S + i) % 6, rnd));
        }
      }
    // cars on the streets
    const carCols = [0xef476f, 0xffd166, 0x06d6a0, 0x118ab2, 0x9d4edd, 0xfb8500];
    for (let i = 0; i < 16; i++) {
      const alongX = i % 2 === 0;
      const lane = Math.floor(rnd() * (alongX ? ROWS + 1 : COLS + 1));
      const off = (rnd() - 0.5) * (alongX ? COLS * pitch : ROWS * pitch);
      const px = alongX ? CX + off : CX + (lane - COLS / 2) * pitch + (rnd() < 0.5 ? 2.2 : -2.2);
      const pz = alongX ? (lane - ROWS / 2) * pitch + (rnd() < 0.5 ? 2.2 : -2.2) : off;
      addBox({ size: alongX ? [4.2, 1.4, 1.9] : [1.9, 1.4, 4.2], pos: [px, 0.7, pz], color: carCols[i % 6] });
      addBox({ size: alongX ? [2.2, 0.55, 1.7] : [1.7, 0.55, 2.2], pos: [px, 1.65, pz], color: 0xcbd5e1, solid: false });
    }
    // launch pads at some street corners: they throw you up onto the roofs
    for (let i = 0; i < 9; i++) {
      const c = Math.floor(rnd() * (COLS - 0)) ;
      const r = Math.floor(rnd() * ROWS);
      const px = CX + (c - (COLS - 1) / 2) * pitch + BW / 2 + 1.6;
      const pz = (r - (ROWS - 1) / 2) * pitch + (rnd() - 0.5) * 8;
      addBox({ size: [2.4, 0.2, 2.4], pos: [px, 0.1, pz], color: 0xff5d8f, bounce: true, launch: true });
    }
    void roofs;
  }
  function addBuildingFull(x, z, w, d, h, style, rnd) {
    addBuilding(x, z, w, d, h, style);
    const roofY = 0.18 + h;
    // things on the roof: air-conditioners to hop on, now and then a water tower or a launch pad
    for (let i = 0; i < 1 + Math.floor(rnd() * 3); i++) addBox({ size: [1.4, 0.9, 1.4], pos: [x + (rnd() - 0.5) * (w - 3), roofY + 0.45, z + (rnd() - 0.5) * (d - 3)], color: 0x9aa5b1 });
    if (rnd() < 0.3) addBox({ size: [2.2, 0.2, 2.2], pos: [x + (rnd() - 0.5) * (w - 4), roofY + 0.1, z + (rnd() - 0.5) * (d - 4)], color: 0xff5d8f, bounce: true, launch: true });
    if (rnd() < 0.22) {
      const tw = new THREE.Mesh(new THREE.CylinderGeometry(1.1 * ws, 1.1 * ws, 2 * ws, 12), new THREE.MeshStandardMaterial({ color: 0x8d6e63 }));
      const cone = new THREE.Mesh(new THREE.ConeGeometry(1.3 * ws, 0.9 * ws, 12), new THREE.MeshStandardMaterial({ color: 0x6d4c41 }));
      tw.position.set((x + w / 2 - 2) * ws, (roofY + 3) * ws, z * ws);
      cone.position.set((x + w / 2 - 2) * ws, (roofY + 4.4) * ws, z * ws);
      tw.castShadow = cone.castShadow = true;
      scene.add(tw, cone);
      ownGeos.push(tw.geometry, cone.geometry);
    }
    return roofY;
  }
  function cityPlaza(bx, bz) {
    // a park plaza: fountain, trees, benches, plus stairs, a rail, a ledge and a quarter pipe for skating
    addBox({ size: [5, 0.7, 5], pos: [bx, 0.5, bz], color: 0x94a3b8 });
    addBox({ size: [3.4, 0.3, 3.4], pos: [bx, 0.95, bz], color: 0x7dd3fc });
    for (let i = 0; i < 6; i++) addBox({ size: [5, 0.2 * (i + 1), 0.8], pos: [bx - 11, 0.1 * (i + 1) + 0.18, bz - 6 + i * 0.8], color: 0xcbd5e1 });
    addRail([bx - 7.5, 1.3, bz - 6], [bx - 7.5, 0.3, bz - 1.2]);
    addBox({ size: [6, 0.5, 1], pos: [bx + 6, 0.45, bz + 6], color: 0x9aa5b1 });
    quarterPipe({ x: bx + 3, z: bz - 6, width: 6, R: 2.2, dir: 1, color: 0xc7ced9 });
    for (const [tx, tz] of [[-6, 6], [6, -2], [-6, -6], [2, 7]]) {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25 * ws, 0.32 * ws, 2 * ws, 8), new THREE.MeshStandardMaterial({ color: 0x8d6e63 }));
      const top = new THREE.Mesh(new THREE.ConeGeometry(1.5 * ws, 3.6 * ws, 9), new THREE.MeshStandardMaterial({ color: 0x2d9b4f }));
      trunk.position.set((bx + tx) * ws, ws, (bz + tz) * ws);
      top.position.set((bx + tx) * ws, 3.6 * ws, (bz + tz) * ws);
      trunk.castShadow = top.castShadow = true;
      scene.add(trunk, top);
      ownGeos.push(trunk.geometry, top.geometry);
    }
  }

  // ------------------------------------------------------------------ character
  function characterSource(id) {
    if (id === 'mine') {
      const c = ctx.cloneModel();
      return hasJoints(c) ? c : null;
    }
    const tmp = new THREE.Group();
    STARTERS[id].build(tmp);
    tmp.traverse((o) => o.userData && o.userData.id && registry.delete(o.userData.id));
    return cloneClean(tmp);
  }

  function buildCharacter(src) {
    const visual = new THREE.Group();
    visual.add(src);
    src.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(visual);
    const size = box.getSize(V());
    const c = box.getCenter(V());
    src.position.set(-c.x, -box.min.y, -c.z);
    visual.updateMatrixWorld(true);
    const joints = [];
    src.traverse((o) => isJoint(o) && joints.push(o));
    for (const j of joints) {
      j.userData.rest = { p: j.position.clone(), q: j.quaternion.clone() };
      j.userData.restW = j.getWorldPosition(V());
    }
    const byName = (re) => joints.find((j) => re.test(j.name));
    const hips = byName(/^Hips$/) || joints.find((j) => !isJoint(j.parent)) || null;
    const quad = joints.some((j) => /^(Front|Back)/.test(j.name));
    const legs = [];
    const arms = [];
    for (const A of joints) {
      if (A === hips || !/(Shoulder|Hip)$/.test(A.name)) continue;
      const B = childJoints(A)[0];
      if (!B) continue;
      const Cj = childJoints(B)[0] || null;
      const isHip = /Hip$/.test(A.name);
      const kind = isHip || quad ? 'leg' : 'arm';
      const side = A.userData.restW.x >= 0 ? 1 : -1;
      const front = /Front/.test(A.name) || (!isHip && quad);
      let endW;
      if (Cj) endW = Cj.userData.restW.clone();
      else {
        const bb = new THREE.Box3();
        B.traverse((o) => o.isMesh && bb.expandByObject(o));
        endW = bb.isEmpty() ? B.userData.restW.clone().add(V(0, -0.2, 0)) : V((bb.min.x + bb.max.x) / 2, bb.min.y, (bb.min.z + bb.max.z) / 2);
      }
      const endLocal = Cj ? V() : B.worldToLocal(endW.clone());
      const L = {
        A, B, C: Cj, kind, side, front,
        pole: kind === 'leg' ? (isHip ? V(0, 0, 1) : Cj ? V(0, 0, 1) : V(0, 0, -1)) : V(0, 0, -1),
        l1: B.position.length(),
        l2: Cj ? Cj.position.length() : endLocal.length(),
        v1: B.position.clone().normalize(),
        v2: (Cj ? Cj.position : endLocal).clone().normalize(),
        endLocal,
        footH: endW.y,
        restXZ: V(endW.x, 0, endW.z),
        restShoulderY: A.userData.restW.y,
        group: kind === 'leg' ? (quad ? (front ? 0 : 1) ^ (side > 0 ? 0 : 1) : side > 0 ? 0 : 1) : side > 0 ? 1 : 0,
        foot: endW.clone(),
        step: null,
      };
      (kind === 'leg' ? legs : arms).push(L);
    }
    const info = {
      visual, root: src, joints, hips, quad, legs, arms,
      head: byName(/^Head$/), neck: byName(/^Neck$/), spine: byName(/^Spine$/),
      tails: joints.filter((j) => /^Tail/.test(j.name)),
      wings: joints.filter((j) => /Wing$/.test(j.name)),
      flatLegs: joints.filter((j) => /Leg$/.test(j.name) && !childJoints(j).length),
      H: size.y, W: size.x, D: size.z,
      pitch: 0, roll: 0, hipsDy: 0, armZ: 0, phase: 0,
    };
    // where a rider would sit: the top of the torso over the middle of the barrel (or a part you marked as the seat)
    info.saddleLocal = null;
    info.saddleY = size.y * 0.7;
    info.canFly = info.wings.length >= 2 && !legs.length;
    info.biped = !quad && legs.length >= 2 && arms.length >= 2;
    if (quad && info.spine) {
      visual.updateMatrixWorld(true);
      let seatMesh = null;
      src.traverse((o) => o.isMesh && o.userData && o.userData.role === 'seat' && (seatMesh = o));
      let sw;
      if (seatMesh) sw = new THREE.Box3().setFromObject(seatMesh).getCenter(V());
      else {
        const bb = new THREE.Box3();
        for (const ch of info.spine.children) if (ch.isMesh) bb.expandByObject(ch);
        sw = bb.isEmpty() ? V(0, size.y * 0.7, 0) : V(0, bb.max.y, (bb.min.z + bb.max.z) / 2);
      }
      info.saddleLocal = info.spine.worldToLocal(sw.clone());
      info.saddleY = sw.y;
    }
    return info;
  }

  function setCharacter(id, opts = {}) {
    if (!running) return;
    charId = id;
    const carry = P ? { score: P.score, best: P.best } : null;
    if (P) {
      if (P.drive) P.drive.v.driver = null;
      clearRide();
      if (P.gearMesh) scene.remove(P.gearMesh.group);
      scene.remove(P.char.visual);
      world.removeBody(P.body);
      if (held) drop(true);
      P = null;
    }
    let src = characterSource(id);
    let spawnMine = false;
    if (!src) {
      // a prop with no bones: play as a person and drop the model into the playground
      src = characterSource('person');
      charId = 'person';
      spawnMine = true;
    }
    const char = buildCharacter(src);
    if (!opts.keepWorld) {
      ws = clamp(Math.sqrt(char.H / 1.7), 0.5, 1.35);
      // the world is rebuilt so it fits the size of what you play
      resetWorldObjects();
    }
    scene.add(char.visual);
    const r = clamp(0.5 * Math.min(char.W, char.D * 1.6), 0.12, 0.45);
    const body = new CANNON.Body({ mass: 60, material: playerMat, fixedRotation: true, allowSleep: false, linearDamping: 0 });
    body.collisionFilterGroup = PLAYER;
    body.collisionFilterMask = WORLD;
    const zs = char.quad ? [-Math.max(0, (char.D / 2 - r) * 0.8), Math.max(0, (char.D / 2 - r) * 0.8)] : [0];
    // a column of overlapping spheres, so thin ceilings and shelves can not slip between them
    const hsFull = Math.max(0, char.H - 2 * r);
    const nS = clamp(Math.ceil(hsFull / (r * 0.9)) + 1, 2, 10);
    zs.forEach((z) => {
      for (let i = 0; i < nS; i++) body.addShape(new CANNON.Sphere(r), new CANNON.Vec3(0, (hsFull * i) / (nS - 1), z));
    });
    body.position.set(0, r + 0.02, 0);
    world.addBody(body);
    const k = clamp(Math.sqrt(char.H / 1.7), 0.65, 1.35);
    P = {
      char, body, r, k, zs, nS,
      state: 'ground', stance: 'stand', hsCur: Math.max(0, char.H - 2 * r), hsStand: Math.max(0, char.H - 2 * r),
      hsCrouch: Math.max(0, char.H * 0.62 - 2 * r), grounded: false, groundBody: null, groundNormal: UP.clone(),
      coyote: 0, jumpBuf: 0, jumps: 0, yaw: 0, yawTarget: 0, time: 0, crawlToggle: false,
      walk: (char.quad ? 3.4 : 2.9) * k, run: (char.quad ? 8.2 : 6.6) * k, crouchSpeed: 1.7 * k, crawlSpeed: 1.0 * k,
      jumpV: Math.sqrt(2 * GRAVITY * clamp(0.62 * char.H, 0.45, 1.3)),
      wall: null, wallT: 0, wallCool: 0, climbN: null, climbCool: 0, mantle: null, antiGrav: 0,
      charge: 0, throwAnim: 0, landT: 0, airT: 0, bounceCool: 0, flap: 0,
      speedH: 0, label: '', who: charId,
      ride: 'walk', rs: null, veh: null, rideRoot: null, skates: null, score: 0, best: 0, groundNormal: UP.clone(),
      drive: null, rider: null,
      gear: null, gearMesh: null, gearBs: 1, ammo: {}, swing: null, swingCd: 0, swingStep: 0, swingT: 0, fireCd: 0, reload: 0, recoil: 0, trigLatch: false,
    };
    if (opts.keepWorld && carry) {
      P.score = carry.score;
      P.best = carry.best;
    }
    if (opts.at) {
      P.body.position.set(opts.at.x, Math.max(opts.at.y, r + 0.02) + 0.1, opts.at.z);
      P.yaw = P.yawTarget = opts.yaw || 0;
    }
    snapFeet();
    if (opts.rider) attachRider(opts.rider);
    updateHud();
    if (!spawnMine && !char.legs.length && !char.flatLegs.length && !char.wings.length)
      toast('This model has no leg bones, so it slides around. Name bones like LeftHip, LeftKnee, LeftAnkle to give it walking legs! 🦴');
    if (spawnMine) {
      spawnMyModel();
      toast('Your model has no bones, so you play as a person. Your model is in the playground! 🎮');
    }
  }

  // throw away the playground and build a fresh one (the player stays)
  function resetWorldObjects() {
    for (const v of vehicles) v.rv && v.rv.removeFromWorld(world);
    vehicles = [];
    if (P && P.drive) {
      P.drive = null;
      P.body.collisionFilterMask = WORLD;
      P.char.visual.scale.setScalar(1);
    }
    for (const b of [...world.bodies]) if (!P || b !== P.body) world.removeBody(b);
    for (const o of [...scene.children]) {
      if (o === hemi || o === sun || o === sun.target || (P && (o === P.char.visual || o === P.rideRoot || (P.gearMesh && o === P.gearMesh.group) || (P.skates && P.skates.some((k) => k.group === o))))) continue;
      scene.remove(o);
    }
    dyn = [];
    statics = [];
    props = [];
    rails = [];
    balloons = [];
    dummies = [];
    respawns = [];
    darts = [];
    fx = [];
    popups = [];
    held = null;
    ownGeos.splice(0).forEach((g) => g.dispose());
    buildContents();
  }

  // ------------------------------------------------------------------ IK
  const tmpQ = new THREE.Quaternion();
  const tmpQ2 = new THREE.Quaternion();
  function solveLimb(L, target, poleW, flatQ) {
    const { A, B } = L;
    const aW = A.getWorldPosition(V());
    const toT = target.clone().sub(aW);
    const d = toT.length();
    const dir = d > 1e-6 ? toT.divideScalar(d) : V(0, -1, 0);
    const dd = clamp(d, Math.abs(L.l1 - L.l2) + 1e-3, L.l1 + L.l2 - 1e-3);
    const x = (dd * dd + L.l1 * L.l1 - L.l2 * L.l2) / (2 * dd);
    const h = Math.sqrt(Math.max(L.l1 * L.l1 - x * x, 0));
    const pole = poleW.clone().addScaledVector(dir, -poleW.dot(dir));
    if (pole.lengthSq() < 1e-6) pole.set(1, 0, 0).addScaledVector(dir, -dir.x);
    pole.normalize();
    const midW = aW.clone().addScaledVector(dir, x).addScaledVector(pole, h);
    A.parent.getWorldQuaternion(tmpQ).invert();
    const d1 = midW.clone().sub(aW).normalize().applyQuaternion(tmpQ);
    A.quaternion.setFromUnitVectors(L.v1, d1);
    A.updateMatrixWorld(true);
    A.getWorldQuaternion(tmpQ).invert();
    const endW = aW.clone().addScaledVector(dir, dd);
    const d2 = endW.clone().sub(midW).normalize().applyQuaternion(tmpQ);
    B.quaternion.setFromUnitVectors(L.v2, d2);
    B.updateMatrixWorld(true);
    if (L.C && flatQ) {
      B.getWorldQuaternion(tmpQ).invert();
      L.C.quaternion.copy(tmpQ.multiply(flatQ));
      L.C.updateMatrixWorld(true);
    }
  }
  const yawQ = (y) => new THREE.Quaternion().setFromAxisAngle(UP, y);
  const fwdOf = (y) => V(Math.sin(y), 0, Math.cos(y));
  const leftOf = (y) => V(Math.cos(y), 0, -Math.sin(y));

  function snapFeet() {
    const C = P.char;
    const b = P.body;
    C.visual.position.set(b.position.x, b.position.y - P.r, b.position.z);
    C.visual.rotation.set(0, P.yaw, 0);
    C.visual.updateMatrixWorld(true);
    for (const L of [...C.legs, ...C.arms]) {
      L.step = null;
      L.foot.copy(idealGround(L));
    }
  }
  function idealGround(L) {
    const C = P.char;
    const p = C.visual.position;
    const off = L.restXZ.clone().applyAxisAngle(UP, P.yaw);
    const lead = V(P.body.velocity.x, 0, P.body.velocity.z).multiplyScalar(0.16);
    const x = p.x + off.x + lead.x;
    const z = p.z + off.z + lead.z;
    return V(x, groundYAt(x, z, p.y) + L.footH, z);
  }
  function idealAir(L) {
    const C = P.char;
    const p = C.visual.position;
    const off = L.restXZ.clone().applyAxisAngle(UP, P.yaw);
    const tuck = (C.quad ? (L.front ? 0.12 : -0.12) : 0.1) * C.H;
    const f = fwdOf(P.yaw).multiplyScalar(tuck);
    return V(p.x + off.x + f.x, p.y + L.footH + 0.26 * C.H, p.z + off.z + f.z);
  }
  function stepLimbs(list, ideal, dt, speed, free) {
    const C = P.char;
    // advance the feet that are mid-step
    for (const L of list) {
      if (!L.step) continue;
      const S = L.step;
      S.t += dt / S.dur;
      const t = Math.min(1, S.t);
      S.to.copy(ideal(L));
      L.foot.lerpVectors(S.from, S.to, smooth(t));
      L.foot.y += Math.sin(Math.PI * t) * S.lift;
      if (t >= 1) {
        L.step = null;
        L.foot.copy(S.to);
      }
    }
    // start new steps, most-stretched first
    const need = [];
    for (const L of list) {
      if (L.step) continue;
      const id = ideal(L);
      const dx = id.x - L.foot.x;
      const dz = id.z - L.foot.z;
      const dy = id.y - L.foot.y;
      const d = Math.hypot(dx, dz, dy * 0.6);
      const thr = Math.max(0.09, 0.2 * (L.l1 + L.l2) * (1 + 0.05 * speed));
      if (d > thr) need.push([d / thr, L, id]);
    }
    need.sort((a, b) => b[0] - a[0]);
    for (const [, L, id] of need) {
      const blocked = !free && list.some((o) => o.step && o.group !== L.group);
      if (blocked) continue;
      L.step = {
        t: 0,
        dur: clamp(0.3 - 0.022 * speed, 0.1, 0.3) * (C.quad ? 0.9 : 1),
        from: L.foot.clone(),
        to: id.clone(),
        lift: 0.13 * (L.l1 + L.l2) * (1 + 0.15 * speed),
      };
    }
  }

  function animate(dt) {
    if (P.ride !== 'walk') return animateRide(dt);
    const C = P.char;
    const b = P.body;
    const vis = C.visual;
    const speedH = Math.hypot(b.velocity.x, b.velocity.z);
    P.speedH = speedH;
    const state = P.state;
    // body orientation
    const wallFade = P.wall ? clamp(0.35 + 0.65 * (P.wall.speed / Math.max(P.wall.s0, 0.1)), 0.35, 1) : 1;
    const wantPitch = P.stance === 'crawl' && C.biped && state === 'ground' ? 1.2 : state === 'climb' ? -0.05 : state === 'wallup' ? -0.28 * wallFade : 0;
    C.pitch = damp(C.pitch, wantPitch, 8, dt);
    const wantRoll = state === 'wallrun' && P.wall ? P.wall.side * 0.5 * wallFade : 0;
    C.roll = damp(C.roll, wantRoll, 10, dt);
    vis.position.set(b.position.x, b.position.y - P.r, b.position.z);
    vis.rotation.set(C.pitch, P.yaw, C.roll, 'YXZ');
    // reset the pose
    for (const j of C.joints) {
      j.quaternion.copy(j.userData.rest.q);
      j.position.copy(j.userData.rest.p);
    }
    // how low the hips sit (crouch, uneven ground)
    const hipsRest = C.hips ? C.hips.userData.rest.p.y : 0;
    let dyTarget = 0;
    if (state === 'ground') dyTarget = P.stance === 'crouch' ? -(C.quad ? 0.22 : 0.34) * hipsRest : P.stance === 'crawl' ? (C.biped ? 0 : -0.5 * hipsRest) : 0;
    if (state === 'ground' && C.legs.length) {
      let sum = 0;
      for (const L of C.legs) sum += L.foot.y - L.footH - vis.position.y;
      dyTarget += clamp((sum / C.legs.length) * 0.6, -0.3 * hipsRest, 0.1 * hipsRest);
    }
    if (state === 'air') dyTarget = 0;
    C.hipsDy = damp(C.hipsDy, dyTarget, 12, dt);
    if (C.hips) C.hips.position.y = hipsRest + C.hipsDy;
    C.phase += speedH * dt * (C.quad ? 2.2 : 2.6);
    const sw = clamp(speedH / (P.run + 0.01), 0, 1);
    // FK: spine lean, head, tail, wings
    if (C.spine) C.spine.rotation.x = (state === 'ground' ? 0.18 * sw : 0) + (P.stance === 'crawl' && !C.biped ? 0 : 0);
    if (C.head) {
      const rel = clamp(angleDiff(camYaw, P.yaw), -0.9, 0.9);
      C.head.rotation.y = damp(C.head.rotation.y || 0, state === 'climb' ? 0 : rel * 0.6, 8, dt);
    }
    C.tails.forEach((t, i) => {
      t.rotation.y = Math.sin(P.time * 3 + i) * (0.18 + 0.35 * sw);
      if (state === 'air') t.rotation.x = 0.25;
    });
    if (C.wings.length) {
      const flying = state === 'air' && (C.canFly && P.flap > 0);
      C.wings.forEach((w) => {
        const sideSign = /Left/.test(w.name) ? 1 : -1;
        const ang = flying ? 0.15 + Math.sin(P.time * 22) * 0.95 : state === 'air' ? 0.7 : -1.35;
        w.rotation.z = sideSign * ang;
      });
    }
    C.flatLegs.forEach((l) => {
      const sideSign = /Left/.test(l.name) ? 1 : -1;
      l.rotation.x = state === 'air' ? -0.9 : Math.sin(C.phase) * 0.7 * sideSign * sw;
    });
    // lean to the camera when throwing
    vis.updateMatrixWorld(true);

    // legs: IK
    const fwdV = fwdOf(P.yaw);
    const freeStep = P.landT > 0;
    if (C.legs.length) {
      let ideal;
      if (state === 'air') {
        ideal = idealAir;
        for (const L of C.legs) {
          L.step = null;
          L.foot.lerp(ideal(L), 1 - Math.exp(-20 * dt));
        }
      } else if (state === 'climb' && P.climbN) {
        ideal = (L) => idealWallLimb(L);
        stepLimbs([...C.legs, ...C.arms.filter(() => C.biped)], ideal, dt, 2, false);
      } else if ((state === 'wallrun' || state === 'wallup') && P.wall) {
        // a real running cycle: opposite legs swing opposite ways, and it slows down with the run
        for (const L of C.legs) {
          L.step = null;
          L.foot.lerp(wallCycleFoot(L, P.wall, state === 'wallup'), 1 - Math.exp(-32 * dt));
        }
      } else if (P.stance === 'crawl' && C.biped) {
        ideal = (L) => (L.kind === 'arm' ? idealCrawlArm(L) : idealCrawlLeg(L));
        stepLimbs([...C.legs, ...C.arms], ideal, dt, speedH + 1, false);
      } else {
        stepLimbs(C.legs, idealGround, dt, speedH, freeStep);
      }
      const flat = yawQ(P.yaw);
      for (const L of C.legs) solveLimb(L, L.foot, poleWorld(L), flat);
    }

    // arms
    armsAnimate(dt, speedH, sw);
    gearUpdate(dt);

    // generic bounce for models with no legs at all
    if (!C.legs.length && !C.flatLegs.length && !C.wings.length) {
      C.root.position.y = C.root.userData.baseY ?? (C.root.userData.baseY = C.root.position.y);
      C.root.position.y += Math.abs(Math.sin(P.time * 9)) * 0.05 * sw;
    }
    vis.updateMatrixWorld(true);
  }

  const poleWorld = (L) => {
    const q = P.char.visual.getWorldQuaternion(new THREE.Quaternion());
    return L.pole.clone().applyQuaternion(q);
  };
  function idealWallLimb(L) {
    const C = P.char;
    const N = P.climbN;
    const p = C.visual.position;
    const left = leftOf(P.yaw);
    const wallDist = P.wallDist ?? P.r + 0.03;
    const base = V(p.x - N.x * wallDist, p.y, p.z - N.z * wallDist);
    const lat = left.multiplyScalar(L.restXZ.x * 0.8);
    const high = L.kind === 'arm' || (C.quad && L.front);
    const y = L.kind === 'arm' ? p.y + L.restShoulderY * 0.95 + 0.25 * C.H : high ? p.y + 0.8 * C.H : p.y + (C.quad ? 0.25 : 0.18) * C.H;
    return V(base.x + lat.x + N.x * 0.03, y, base.z + lat.z + N.z * 0.03);
  }
  // where a foot is on the wall at this point in the run cycle
  function wallCycleFoot(L, W, up) {
    const C = P.char;
    const p = C.visual.position;
    const N = W.N;
    const dW = W.dWall ?? P.r + 0.03;
    const slow = clamp(W.speed / Math.max(W.s0, 0.1), 0, 1); // 1 = full speed, 0 = about to fall
    const ph = W.phase + (L.group ? Math.PI : 0);
    const amp = (up ? 0.26 : 0.3) * C.H * clamp(0.3 + 0.7 * slow, 0.3, 1);
    const along = Math.sin(ph) * amp;
    const lift = Math.max(0, Math.cos(ph)) * 0.16 * C.H * clamp(0.3 + 0.7 * slow, 0.3, 1);
    const axis = up ? UP : W.tangent;
    const lateral = up ? leftOf(P.yaw).multiplyScalar(L.restXZ.x * 0.8) : V();
    const y0 = p.y + (up ? 0.42 : 0.38) * C.H + (C.quad && !L.front ? -0.05 * C.H : 0);
    return V(p.x - N.x * dW, y0, p.z - N.z * dW)
      .addScaledVector(axis, along)
      .addScaledVector(N, 0.03 + lift) // the foot peels off the wall as it swings forward
      .add(lateral);
  }
  function idealCrawlArm(L) {
    const A = L.A.getWorldPosition(V());
    const f = fwdOf(P.yaw);
    const x = A.x + f.x * 0.12 + P.body.velocity.x * 0.12;
    const z = A.z + f.z * 0.12 + P.body.velocity.z * 0.12;
    return V(x, groundYAt(x, z, P.char.visual.position.y) + 0.05, z);
  }
  function idealCrawlLeg(L) {
    const p = P.char.visual.position;
    const off = V(L.restXZ.x * 0.9, 0, -0.05).applyAxisAngle(UP, P.yaw);
    const x = p.x + off.x + P.body.velocity.x * 0.12;
    const z = p.z + off.z + P.body.velocity.z * 0.12;
    return V(x, groundYAt(x, z, p.y) + L.footH * 0.5, z);
  }

  function armsAnimate(dt, speedH, sw) {
    const C = P.char;
    if (!C.arms.length || !C.biped) return;
    if (gearActive()) return; // gearUpdate handles the arms
    const state = P.state;
    const holdingBoth = held && state !== 'climb';
    const crawl = P.stance === 'crawl' && state === 'ground';
    if (state === 'climb' || crawl) {
      // arms are stepping limbs in these modes (handled with the legs)
      const flat = null;
      for (const L of C.arms) {
        if (state === 'climb' && !C.legs.length) continue;
        solveLimb(L, L.foot, V(L.side * 0.8, 0, -0.6).applyQuaternion(C.visual.getWorldQuaternion(new THREE.Quaternion())), flat);
      }
      return;
    }
    if (holdingBoth || P.throwAnim > 0) {
      const f = fwdOf(P.yaw);
      const left = leftOf(P.yaw);
      for (const L of C.arms) {
        const shoulder = L.A.getWorldPosition(V());
        let target;
        if (P.throwAnim > 0) {
          const t = 1 - P.throwAnim; // 0..1
          const back = shoulder.clone().addScaledVector(f, -0.25 * C.H * 0.6).add(V(0, 0.3 * C.H * 0.6, 0));
          const front = shoulder.clone().addScaledVector(f, 0.55 * C.H * 0.6).add(V(0, 0.05, 0));
          target = t < 0.4 ? back.lerp(shoulder.clone().addScaledVector(f, -0.3).add(V(0, 0.4 * C.H * 0.6, 0)), t / 0.4) : back.lerpVectors(shoulder.clone().addScaledVector(f, -0.3).add(V(0, 0.4 * C.H * 0.6, 0)), front, smooth((t - 0.4) / 0.6));
        } else {
          const hp = holdPoint();
          target = hp.addScaledVector(left, L.side * 0.2 * ws);
        }
        solveLimb(L, target, f.clone().multiplyScalar(-0.5).addScaledVector(left, L.side * 0.9), null);
      }
      return;
    }
    // plain walking: swing the arms; in the air throw them up
    const wantZ = state === 'air' ? (P.body.velocity.y > 0 ? 2.1 : 1.1) : state === 'wallrun' || state === 'wallup' ? 1.2 : P.stance === 'crouch' ? 0.25 : 0;
    C.armZ = damp(C.armZ, wantZ, 10, dt);
    for (const L of C.arms) {
      const s = L.side;
      L.A.rotation.z = s * C.armZ;
      const swing = Math.sin(C.phase) * (0.35 + 0.6 * sw) * (state === 'ground' ? sw * 1.5 + 0.0 : 0);
      L.A.rotation.x = s > 0 ? swing : -swing;
      L.B.rotation.x = -(0.15 + 0.85 * sw) * (state === 'ground' ? 1 : 0.2);
      if ((state === 'wallrun' || state === 'wallup') && P.wall) {
        const slow = clamp(P.wall.speed / Math.max(P.wall.s0, 0.1), 0, 1);
        const sg = L.side > 0 ? 1 : -1;
        L.A.rotation.x = Math.sin(P.wall.phase + (L.side > 0 ? 0 : Math.PI)) * 0.85 * (0.3 + 0.7 * slow) * sg;
      }
    }
  }

  // ------------------------------------------------------------------ picking up and throwing
  function holdPoint() {
    const C = P.char;
    const p = C.visual.position;
    const f = fwdOf(P.yaw);
    const sz = held ? held.userData.size : 0.4;
    const dist = P.r + sz * 0.5 + (C.quad ? C.D * 0.45 : 0.28 * ws);
    const h = C.quad ? C.H * 0.5 : C.H * 0.52;
    return V(p.x + f.x * dist, p.y + h, p.z + f.z * dist);
  }
  function tryPickUp() {
    if (P.ride !== 'walk') return toast('Hop off first (V) to pick things up. 🛹');
    if (held) return drop(false);
    const p = P.char.visual.position;
    const f = fwdOf(P.yaw);
    let best = null;
    let bd = 1e9;
    for (const bdy of props) {
      const to = V(bdy.position.x - p.x, 0, bdy.position.z - p.z);
      const d = to.length();
      const reach = (1.5 + bdy.userData.size * 0.5) * clamp(ws, 0.7, 1.3) + P.r;
      if (d > reach || (d > 0.3 && to.normalize().dot(f) < 0.1)) continue;
      if (Math.abs(bdy.position.y - (p.y + P.char.H * 0.5)) > P.char.H * 1.1) continue;
      if (d < bd) {
        bd = d;
        best = bdy;
      }
    }
    if (!best) return toast('Nothing close enough to pick up. Walk up to a crate or ball! 📦');
    if (P.gear) setGear('none');
    held = best;
    best.collisionFilterGroup = HELD;
    best.collisionFilterMask = WORLD;
    best.wakeUp();
    best.angularDamping = 0.9;
    toast('Picked up! Press E to drop, or click to throw. 🙌');
  }
  function drop(silent) {
    if (!held) return;
    held.collisionFilterGroup = WORLD;
    held.collisionFilterMask = ALL;
    held.angularDamping = 0.2;
    held = null;
    if (!silent) toast('Dropped.');
  }
  function throwHeld() {
    if (!held) return;
    const b = held;
    const power = 9 + 15 * clamp(P.charge / 1.2, 0, 1);
    const f = camera.getWorldDirection(V());
    const dir = f.clone().add(V(0, 0.18, 0)).normalize();
    drop(true);
    b.velocity.set(dir.x * power + P.body.velocity.x * 0.5, dir.y * power + P.body.velocity.y * 0.3, dir.z * power + P.body.velocity.z * 0.5);
    b.angularVelocity.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
    b.collisionFilterMask = WORLD; // does not hit the thrower for a moment
    setTimeout(() => {
      if (b !== held) b.collisionFilterMask = ALL;
    }, 350);
    P.throwAnim = 1;
    P.charge = 0;
  }
  const camForward = () => V(Math.sin(camYaw), 0, Math.cos(camYaw));

  // ------------------------------------------------------------------ spawning
  function spawnAhead(dist = 3) {
    const p = P.char.visual.position;
    const f = camForward();
    return [(p.x + f.x * dist * 0.8) / ws, (p.y + P.char.H * 0.9) / ws + 1, (p.z + f.z * dist * 0.8) / ws];
  }
  function spawnBox() {
    const s = 0.4 + Math.random() * 0.4;
    addBox({ size: [s, s, s], pos: spawnAhead(), mass: 1.4 * (s / 0.4) ** 2, color: [0xef476f, 0xffd166, 0x06d6a0, 0x118ab2, 0x9d4edd][Math.floor(Math.random() * 5)], pickable: true, rot: [Math.random(), Math.random(), 0] });
  }
  function spawnBallProp() {
    addBall({ r: 0.2 + Math.random() * 0.2, pos: spawnAhead(), color: [0xef476f, 0xffd166, 0x06d6a0, 0x118ab2][Math.floor(Math.random() * 4)] });
  }
  // your model as a rigid, throwable toy
  // A model (yours, or one loaded from a file) dropped into the playground.
  // Small ones are toys you can push, pick up and throw. Big ones (houses, ramps) are solid and climbable.
  function spawnModelProp(src, label) {
    if (!src.children.length) return toast('Nothing to drop in yet!');
    const wrap = new THREE.Group();
    wrap.add(src);
    src.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(wrap);
    const c = bb.getCenter(V());
    src.position.set(-c.x, -c.y, -c.z);
    wrap.updateMatrixWorld(true);
    const big = bb.getSize(V());
    const huge = Math.max(big.x, big.y, big.z) > 6;
    const mass = huge ? 0 : clamp(big.x * big.y * big.z * 60, 1, 400);
    const body = new CANNON.Body({ mass, material: huge ? groundMat : propMat });
    const q = new THREE.Quaternion();
    const pos = V();
    const sc = V();
    const pm = new THREE.Matrix4();
    wrap.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      o.geometry.computeBoundingBox();
      const gb = o.geometry.boundingBox;
      const sz = gb.getSize(V());
      const ctr = gb.getCenter(V());
      o.updateWorldMatrix(true, false);
      pm.copy(o.matrixWorld).decompose(pos, q, sc);
      const centerW = ctr.clone().multiply(sc).applyQuaternion(q).add(pos);
      body.addShape(new CANNON.Box(new CANNON.Vec3(Math.max(0.02, (sz.x * Math.abs(sc.x)) / 2), Math.max(0.02, (sz.y * Math.abs(sc.y)) / 2), Math.max(0.02, (sz.z * Math.abs(sc.z)) / 2))), new CANNON.Vec3(centerW.x, centerW.y, centerW.z), new CANNON.Quaternion(q.x, q.y, q.z, q.w));
    });
    if (!body.shapes.length) return toast('That model has no shapes to drop in.');
    const at = spawnAhead(huge ? 6 + big.z / 2 : 3.5);
    body.position.set(at[0] * ws, huge ? big.y / 2 : at[1] * ws + big.y / 2, at[2] * ws);
    body.collisionFilterGroup = WORLD;
    body.collisionFilterMask = ALL;
    body.userData = { pickable: !huge, climb: huge, mesh: wrap, size: Math.max(big.x, big.y, big.z), mass };
    wrap.position.copy(body.position);
    scene.add(wrap);
    world.addBody(body);
    if (huge) statics.push(body);
    else {
      dyn.push({ body, mesh: wrap });
      props.push(body);
    }
    toast(huge ? `${label} is big, so it is solid. Climb it! 🏠` : `${label} is in the playground! Push it, pick it up (E), throw it! 🧸`);
  }
  const spawnMyModel = () => {
    const u = ctx.getUse && ctx.getUse();
    if (u && (u.use === 'shooter' || u.use === 'swing')) {
      registerMyUse();
      return setGear('my_mine');
    }
    if (u && (u.use === 'car' || u.use === 'hover')) return placeVehicle(ctx.cloneModel(), u.use, u.name || 'Your vehicle');
    spawnModelProp(ctx.cloneModel(), 'Your model');
  };
  function bakeFaceColors(root) {
    root.traverse((o) => {
      const fc = o.isMesh && o.userData && o.userData.faceColors;
      if (!fc || !Object.keys(fc).length || !o.geometry.attributes.face) return;
      const g = o.geometry;
      const F = g.attributes.face.array;
      const base = new THREE.Color(o.userData.color || '#ffffff');
      const col = new Float32Array(g.attributes.position.count * 3);
      for (let i = 0; i < F.length; i++) {
        const hex = fc[F[i]];
        const k = hex ? new THREE.Color(hex) : base;
        col.set([k.r, k.g, k.b], i * 3);
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      o.material.vertexColors = true;
      o.material.color.set('#ffffff');
      o.material.needsUpdate = true;
    });
  }
  // a saved BlockBuddy file (.json) as a prop
  function addDoc(doc, name = 'Your file') {
    if (!running || !P) return;
    if (!doc || doc.app !== 'blockbuddy' || !Array.isArray(doc.nodes)) return toast("That doesn't look like a BlockBuddy file. 🤔");
    try {
      const tmp = new THREE.Group();
      for (const n of doc.nodes) deserialize(n, tmp);
      tmp.traverse((o) => o.userData && o.userData.id && registry.delete(o.userData.id)); // keep the editor's list clean
      bakeFaceColors(tmp);
      const src = cloneClean(tmp);
      if (doc.use === 'shooter' || doc.use === 'swing') {
        const id = addCustomGear(src, doc.use, doc.useCfg || {}, doc.name || name);
        toast(`Added “${doc.name || name}” to your gear! 🌟 Press Q to switch to it.`);
        setGear(id);
      } else if (doc.use === 'car' || doc.use === 'hover') placeVehicle(src, doc.use, doc.name || name);
      else spawnModelProp(src, doc.name || name);
    } catch (e) {
      console.error(e);
      toast("Couldn't load that file: " + e.message);
    }
  }

  // ------------------------------------------------------------------ riding (skateboard, scooter, roller skates)
  const wrapTo = (a, m) => {
    let x = a % m;
    if (x > m / 2) x -= m;
    if (x < -m / 2) x += m;
    return x;
  };
  function clearRide() {
    if (!P) return;
    if (P.rideRoot) scene.remove(P.rideRoot);
    (P.skates || []).forEach((k) => scene.remove(k.group));
    P.rideRoot = null;
    P.skates = null;
    P.veh = null;
  }
  function cycleRide() {
    setRide(RIDE_ORDER[(RIDE_ORDER.indexOf(P.ride) + 1) % RIDE_ORDER.length]);
  }
  function setRide(kind) {
    if (!P || (kind !== 'walk' && !RIDES[kind])) return;
    if (kind !== 'walk' && P.rider) return toast('Get off the animal first. 🐴');
    if (kind !== 'walk' && P.gear) setGear('none');
    if (held) drop(true);
    clearRide();
    P.state = P.grounded ? 'ground' : 'air'; // also clears a bail from the last ride
    P.ride = kind;
    P.rs = null;
    P.stance = 'stand';
    P.crawlToggle = false;
    if (kind === 'walk') {
      toast('Walking again. 🚶');
      updateRideHud();
      return;
    }
    const C = P.char;
    const cfg = RIDES[kind];
    const bs = clamp(C.quad ? Math.max(C.D, C.H) / 1.0 : C.H / 1.7, 0.4, 1.5);
    const len = C.quad ? Math.max(0.85 * bs, C.D * 0.95) : 0.85 * bs;
    const wid = C.quad ? Math.max(0.24 * bs, C.W * 0.9) : 0.24 * bs;
    P.veh = buildVehicle(kind, { bs, len, wid, H: C.H });
    if (kind === 'blades') {
      P.skates = C.legs.map(() => {
        const k = buildSkate(bs);
        scene.add(k.group);
        return k;
      });
    } else {
      P.rideRoot = new THREE.Group();
      P.rideRoot.add(P.veh.root);
      scene.add(P.rideRoot);
    }
    P.rs = {
      heading: P.yaw, speed: 0, sw: false, fakie: false, spin: 0, spinVel: 0,
      boardRoll: 0, boardYaw: 0, bodyFlip: 0, barSpin: 0, spread: 0, grabK: 0,
      anims: [], hold: {}, holdT: {}, holdDone: {}, combo: [], comboPts: 0,
      wasAir: false, airT: 0, bailT: 0, norm: V(0, 1, 0), steer: 0, stroke: 0, pushing: false,
      rail: null, gs: 0, visYaw: 0, bs, len, wid,
    };
    toast(`${cfg.icon} ${cfg.label}! W push · A/D steer · S brake · Space ollie · J K L tricks · G grab · V swap ride`);
    updateRideHud();
  }

  // ---- scoring
  function addTrick(name, pts) {
    const R = P.rs;
    R.combo.push({ name, pts });
    R.comboPts += pts;
    updateRideHud();
  }
  function bankCombo() {
    const R = P.rs;
    if (!R.combo.length) return;
    const total = Math.round(R.comboPts * R.combo.length);
    P.score += total;
    P.best = Math.max(P.best, total);
    R.lastBank = { total, names: R.combo.map((c) => c.name).join(' + '), t: P.time };
    R.combo = [];
    R.comboPts = 0;
    updateRideHud();
  }
  function startBail(reason) {
    const R = P.rs;
    P.state = 'bail';
    R.bailT = 0;
    R.combo = [];
    R.comboPts = 0;
    R.anims = [];
    R.speed *= 0.4;
    R.rail = null;
    toast(`Bail! ${reason} 😵 You lose the combo.`);
    updateRideHud();
  }
  function landing() {
    const R = P.rs;
    const cfg = RIDES[P.ride];
    // tricks that are almost done finish themselves; early ones are a bail
    for (const a of R.anims) {
      if (a.t / a.dur > 0.72) {
        R[a.prop] = a.to;
        addTrick(a.name, a.pts);
      }
    }
    const midTrick = R.anims.some((a) => a.t / a.dur <= 0.72);
    R.anims = [];
    const okFlip =
      Math.abs(wrapTo(R.boardRoll, Math.PI * 2)) < 0.5 && Math.abs(wrapTo(R.boardYaw, Math.PI * 2)) < 0.5 && Math.abs(wrapTo(R.bodyFlip, Math.PI * 2)) < 0.5;
    const okSpin = Math.abs(wrapTo(R.spin, Math.PI)) < 0.65;
    if (midTrick || !okFlip || !okSpin) {
      R.spin = 0;
      R.boardRoll = R.boardYaw = R.bodyFlip = R.barSpin = 0;
      return startBail(midTrick ? 'Landed in the middle of a trick!' : !okSpin ? 'You landed sideways!' : 'The board was upside down!');
    }
    const halves = Math.round(R.spin / Math.PI);
    if (halves) {
      addTrick(`${Math.abs(halves) * 180}`, 40 * Math.abs(halves));
      if (Math.abs(halves) % 2 === 1) cfg.sideways ? (R.sw = !R.sw) : (R.fakie = !R.fakie);
    }
    if (R.airT > 0.9) addTrick('Big air', Math.round(R.airT * 60));
    if (R.holdDone.grab) addTrick('Grab', 80);
    R.spin = 0;
    R.boardRoll = R.boardYaw = R.bodyFlip = R.barSpin = 0;
    bankCombo();
  }

  // ---- tricks
  function advanceTricks(dt) {
    const R = P.rs;
    const air = P.state === 'air';
    for (const a of [...R.anims]) {
      a.t += dt;
      const e = smooth(Math.min(1, a.t / a.dur));
      R[a.prop] = a.from + (a.to - a.from) * e;
      if (a.t >= a.dur) {
        R[a.prop] = a.to;
        addTrick(a.name, a.pts);
        R.anims.splice(R.anims.indexOf(a), 1);
      }
    }
    // hold tricks (tabletop, spread eagle) and grabs
    const table = TRICKS[P.ride];
    for (const T of Object.values(table)) {
      if (!T.hold) continue;
      const on = air && !!R.hold[T.prop];
      R[T.prop] = damp(R[T.prop], on ? T.hold : 0, 14, dt);
      R.holdT[T.prop] = on ? (R.holdT[T.prop] || 0) + dt : 0;
      if (on && R.holdT[T.prop] > 0.4 && !R.holdDone[T.prop]) {
        R.holdDone[T.prop] = true;
        addTrick(T.name, T.pts);
      }
    }
    R.grabK = damp(R.grabK, air && R.hold.grab ? 1 : 0, 12, dt);
    R.holdT.grab = air && R.hold.grab ? (R.holdT.grab || 0) + dt : 0;
    if (R.holdT.grab > 0.35 && !R.holdDone.grab) {
      R.holdDone.grab = true;
      addTrick('Grab', 80);
    }
  }
  function tricksInput() {
    const R = P.rs;
    const table = TRICKS[P.ride];
    for (const code of ['KeyJ', 'KeyK', 'KeyL']) {
      const T = table[code];
      if (!T) continue;
      if (T.hold) R.hold[T.prop] = key(code);
      else if (once(code) && !R.anims.some((a) => a.prop === T.prop)) R.anims.push({ prop: T.prop, from: R[T.prop], to: R[T.prop] + T.amt, t: 0, dur: T.dur, name: T.name, pts: T.pts });
    }
    R.hold.grab = key('KeyG');
  }

  // ---- rails
  function railAssist(v) {
    const R = P.rs;
    if (!rails.length || v.y > 2.2 || R.speed < 1.5 || P.state !== 'air') return;
    const b = P.body;
    const feet = V(b.position.x, b.position.y - P.r, b.position.z);
    for (const rl of rails) {
      const ab = rl.b.clone().sub(rl.a);
      const t = clamp(feet.clone().sub(rl.a).dot(ab) / ab.lengthSq(), 0.02, 0.98);
      const q = rl.a.clone().addScaledVector(ab, t);
      const lat = Math.hypot(feet.x - q.x, feet.z - q.z);
      const dy = feet.y - q.y;
      if (lat < 0.5 * ws && dy > -0.2 * ws && dy < 0.55 * ws) return startGrind(rl, v);
    }
  }
  function startGrind(rl, v) {
    const R = P.rs;
    P.state = 'grind';
    R.rail = rl;
    R.gs = v.x * rl.dir.x + v.y * rl.dir.y + v.z * rl.dir.z;
    if (Math.abs(R.gs) < 2) R.gs = Math.sign(R.gs || 1) * 2;
    R.grindT = 0;
    R.grindItem = { name: 'Grind', pts: 0 };
    R.combo.push(R.grindItem);
    R.anims = [];
    R.spin = 0;
    R.boardRoll = R.boardYaw = R.bodyFlip = R.barSpin = 0;
    toast('Grind! 🔩 Space to jump off.');
  }
  function grindStep(dt, v) {
    const R = P.rs;
    const b = P.body;
    const rl = R.rail;
    R.grindT += dt;
    R.gs -= Math.sign(R.gs) * 0.35 * dt;
    const s = Math.sign(R.gs) || 1;
    const feet = V(b.position.x, b.position.y - P.r, b.position.z);
    const ab = rl.b.clone().sub(rl.a);
    let t = feet.clone().sub(rl.a).dot(ab) / ab.lengthSq();
    t += (R.gs * dt) / rl.len;
    R.heading = Math.atan2(rl.dir.x * s, rl.dir.z * s);
    R.grindItem.pts = Math.round(R.grindT * 70);
    R.comboPts = R.combo.reduce((x, c) => x + c.pts, 0);
    if (P.jumpBuf > 0) {
      P.jumpBuf = 0;
      v.set(rl.dir.x * R.gs, P.jumpV * 0.85, rl.dir.z * R.gs);
      v.y += rl.dir.y * R.gs;
      P.state = 'air';
      R.rail = null;
      R.wasAir = true;
      R.airT = 0;
      return;
    }
    if (t < 0 || t > 1 || Math.abs(R.gs) < 0.8) {
      // off the end of the rail
      v.set(rl.dir.x * R.gs, rl.dir.y * R.gs + 1.0, rl.dir.z * R.gs);
      P.state = 'air';
      R.rail = null;
      R.wasAir = true;
      R.airT = 0;
      return;
    }
    const q = rl.a.clone().addScaledVector(ab, t);
    b.position.set(q.x, q.y + P.r + 0.01, q.z);
    v.set(rl.dir.x * R.gs, rl.dir.y * R.gs, rl.dir.z * R.gs);
    R.speed = Math.abs(R.gs);
    R.wasAir = false;
  }
  function bailStep(dt, v) {
    const R = P.rs;
    R.bailT += dt;
    const k = Math.min(1, 3.5 * dt);
    v.x *= 1 - k;
    v.z *= 1 - k;
    R.speed = Math.hypot(v.x, v.z);
    if (R.bailT > 1.5) {
      P.state = P.grounded ? 'ground' : 'air';
      R.speed = 0;
      R.bailT = 0;
      R.spin = 0;
    }
  }

  // ---- the ride itself
  function rideStep(dt, fi, steerIn, running_) {
    const R = P.rs;
    const cfg = RIDES[P.ride];
    const b = P.body;
    const v = b.velocity;
    advanceTricks(dt);
    P.yawTarget = R.heading;
    if (P.state === 'bail') return bailStep(dt, v);
    if (P.state === 'grind') return grindStep(dt, v);
    if (P.grounded) {
      P.state = 'ground';
      once('KeyJ');
      once('KeyK');
      once('KeyL');
      R.holdDone = {};
      if (P.groundBody && P.groundBody.userData && P.groundBody.userData.rail && Math.abs(R.speed) > 1.5) {
        const rl = rails.find((r) => r.body === P.groundBody);
        if (rl) return startGrind(rl, v);
      }
      if (R.wasAir) {
        R.wasAir = false;
        landing();
        if (P.state === 'bail') return;
      }
      R.airT = 0;
      const n = P.groundNormal.clone();
      if (Math.abs(R.speed) > 0.3) R.heading += steerIn * cfg.turn * clamp(Math.abs(R.speed) / 3, 0.25, 1) * dt * (R.speed < 0 ? -1 : 1);
      if (R.speed < -1.2) {
        // rolled backwards down a ramp: turn around and ride out forwards
        R.heading += Math.PI;
        R.visYaw = -Math.PI;
        R.speed = -R.speed;
      }
      const Fh = fwdOf(R.heading);
      const d = Fh.clone().addScaledVector(n, -Fh.dot(n));
      if (d.lengthSq() < 1e-4) d.copy(Fh);
      d.normalize();
      const cap = cfg.maxPush * (running_ ? 1.25 : 1);
      R.pushing = fi > 0 && R.speed < cap;
      if (R.pushing) R.speed += cfg.pushAcc * dt * (R.speed < 1 ? 1.6 : 1);
      if (fi < 0) R.speed = Math.max(0, R.speed - cfg.brake * dt);
      R.speed -= Math.sign(R.speed) * cfg.fric * dt;
      R.speed += -GRAVITY * d.y * dt * 0.95; // downhill speeds you up, uphill slows you
      // pump the transitions: holding W while you ride a ramp builds speed, like in the games
      if (fi > 0 && Math.abs(d.y) > 0.25 && Math.abs(R.speed) > 2) R.speed += Math.sign(R.speed) * 14 * Math.abs(d.y) * dt;
      if (R.speed > cap && Math.abs(d.y) < 0.15) R.speed -= (R.speed - cap) * 0.5 * dt;
      R.speed = clamp(R.speed, -2.5, 24);
      v.set(d.x * R.speed - n.x * 0.8, d.y * R.speed - n.y * 0.8, d.z * R.speed - n.z * 0.8);
      if (P.jumpBuf > 0 && (P.grounded || P.coyote > 0)) {
        P.jumpBuf = 0;
        v.y = Math.max(v.y, 0) + P.jumpV * cfg.ollie;
        P.grounded = false;
        P.coyote = 0;
        P.state = 'air';
        R.wasAir = true;
        R.airT = 0;
        R.spin = 0;
      }
    } else {
      P.state = 'air';
      R.wasAir = true;
      R.airT += dt;
      R.spinVel = damp(R.spinVel, steerIn * 7.5, 9, dt);
      R.spin += R.spinVel * dt;
      R.speed = v.x * fwdOf(R.heading).x + v.z * fwdOf(R.heading).z;
      R.pushing = false;
      railAssist(v);
      if (P.state === 'air') tricksInput();
    }
  }

  function animateRide(dt) {
    const C = P.char;
    const R = P.rs;
    const b = P.body;
    const vis = C.visual;
    const cfg = RIDES[P.ride];
    const v = b.velocity;
    const sp = Math.hypot(v.x, v.z);
    P.speedH = sp;
    const state = P.state;
    const kind = P.ride;
    const steer = (key('KeyA') ? 1 : 0) - (key('KeyD') ? 1 : 0);
    R.steer = damp(R.steer, state === 'ground' ? steer : 0, 10, dt);
    // pushing animation clock
    const rate = 1.5 + R.speed * 0.12;
    if (R.pushing) R.stroke += dt * rate;
    else if (R.stroke % 1 > 1e-3) {
      const base = Math.floor(R.stroke);
      R.stroke = Math.min(base + 1, R.stroke + dt * 2.6);
    }
    const wantN = state === 'air' || state === 'bail' || state === 'grind' ? UP : P.groundNormal;
    R.norm.lerp(wantN, 1 - Math.exp(-(state === 'air' ? 2.5 : 16) * dt)).normalize();
    const qN = new THREE.Quaternion().setFromUnitVectors(UP, R.norm);
    R.visYaw = damp(R.visYaw, 0, 9, dt);
    const qH = yawQ(R.heading + R.visYaw);
    const qRide = qN.clone().multiply(qH);
    const feet = V(b.position.x, b.position.y - P.r, b.position.z);
    const grabLift = 0.22 * C.H * R.grabK;
    // the board (or scooter)
    if (P.rideRoot) {
      P.rideRoot.position.copy(feet);
      P.rideRoot.quaternion.copy(qRide);
      const tilt = state === 'air' ? clamp(v.y * 0.04, -0.3, 0.3) : 0;
      P.veh.deck.rotation.set(-tilt, R.boardYaw, R.boardRoll, 'YXZ');
      P.veh.deck.position.y = grabLift;
      if (P.veh.bars) P.veh.bars.rotation.y = R.barSpin;
      if (state === 'bail') P.rideRoot.position.add(fwdOf(R.heading).multiplyScalar(Math.min(1.2, R.bailT * 1.6)));
      P.rideRoot.updateMatrixWorld(true);
    }
    // the rider's orientation
    const yawOff = (cfg.sideways ? (R.sw ? Math.PI / 2 : -Math.PI / 2) : 0) + (!cfg.sideways && R.fakie ? Math.PI : 0);
    const lean = -R.steer * 0.25 * clamp(sp / 6, 0, 1);
    const qBase = qN.clone().multiply(qH).multiply(new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), lean)).multiply(new THREE.Quaternion().setFromAxisAngle(UP, yawOff + R.spin));
    const qFlip = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), R.bodyFlip);
    let lie = 0;
    if (state === 'bail') {
      const t = R.bailT;
      lie = t < 0.3 ? smooth(t / 0.3) * 1.45 : t < 1.0 ? 1.45 : 1.45 * (1 - smooth(clamp((t - 1.0) / 0.45, 0, 1)));
    }
    const qLie = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), lie);
    const com = V(0, C.H * 0.5, 0);
    const shift = com.clone().sub(com.clone().applyQuaternion(qFlip)).applyQuaternion(qBase);
    vis.position.copy(feet).add(shift);
    vis.quaternion.copy(qBase).multiply(qFlip).multiply(qLie);
    // pose
    for (const j of C.joints) {
      j.quaternion.copy(j.userData.rest.q);
      j.position.copy(j.userData.rest.p);
    }
    const hipsRest = C.hips ? C.hips.userData.rest.p.y : 0;
    const tuck = (R.grabK * 0.3 + (state === 'air' ? 0.08 : 0)) * hipsRest;
    const wantDy = state === 'bail' ? 0 : -(C.quad ? 0.14 : 0.24) * hipsRest - tuck;
    C.hipsDy = damp(C.hipsDy, wantDy, 10, dt);
    if (C.hips) C.hips.position.y = hipsRest + C.hipsDy;
    if (C.spine && state !== 'bail') C.spine.rotation.x = 0.12 + 0.55 * R.grabK;
    C.tails.forEach((t, i) => (t.rotation.y = Math.sin(P.time * 3 + i) * 0.2));
    vis.updateMatrixWorld(true);

    // feet
    const toW = (x, y, z) => V(x, y, z).applyQuaternion(qRide).add(feet);
    const len = R.len;
    const wid = R.wid;
    const deckY = P.veh ? P.veh.deckY : 0;
    const spread = R.spread;
    C.legs.forEach((L, i) => {
      if (state === 'bail') {
        L.A.rotation.x = Math.sin(P.time * 14 + (L.group ? 3 : 0)) * 0.9;
        L.B.rotation.x = 0.6;
        return;
      }
      let tgt;
      if (kind === 'skate' || (kind === 'scooter' && C.quad)) {
        if (C.quad) tgt = toW(L.side * wid * 0.22, deckY + L.footH + grabLift, (L.front ? 1 : -1) * len * 0.27);
        else {
          const lead = L.side > 0 !== R.sw ? 1 : -1;
          tgt = toW(0, deckY + L.footH + grabLift, lead * len * 0.22);
        }
      } else if (kind === 'scooter') {
        const front = L.side > 0 !== R.sw; // left foot leads
        if (front) tgt = toW(0, deckY + L.footH, len * 0.17);
        else {
          // the pushing foot: back to the ground, kick, return
          const ph = R.stroke % 1;
          let z;
          let y;
          if (ph < 0.5) {
            const u = smooth(ph / 0.5);
            z = -len * 0.38 + (-len * 0.95 + len * 0.38) * u;
            y = L.footH + 0.02 + (deckY - 0.02) * (1 - Math.min(1, ph * 6));
          } else {
            const u = smooth((ph - 0.5) / 0.5);
            z = -len * 0.95 + (len * 0.95 - len * 0.38) * u;
            y = deckY + L.footH + Math.sin(Math.PI * u) * 0.14 * R.bs;
          }
          tgt = toW(0, y, z);
        }
      } else {
        // roller skates: feet are the skates and they stroke as you push
        const skate = P.skates && P.skates[i];
        const wh = skate ? skate.wheelH : 0.05;
        const amp = R.pushing ? 1 : 0.25;
        const ph = R.stroke * Math.PI * 2 + (L.group ? Math.PI : 0);
        const out = Math.max(0, Math.sin(ph)) * 0.09 * R.bs * amp * L.side + L.side * 0.1 * spread * R.bs * 2;
        const z = Math.sin(ph + Math.PI / 2) * 0.14 * R.bs * amp + L.restXZ.z * 0.9;
        const y = L.footH + wh + Math.max(0, -Math.sin(ph)) * 0.05 * R.bs * amp + grabLift;
        tgt = toW(L.restXZ.x * 0.9 + out, y, z);
      }
      L.foot.lerp(tgt, 1 - Math.exp(-40 * dt));
      solveLimb(L, L.foot, poleWorld(L), qRide);
      if (P.skates && P.skates[i]) {
        const k = P.skates[i];
        const wh = k.wheelH;
        k.group.position.set(L.foot.x, L.foot.y - L.footH - wh, L.foot.z);
        k.group.quaternion.copy(qRide);
      }
    });
    // arms
    const gl = new THREE.Quaternion();
    vis.getWorldQuaternion(gl);
    for (const L of C.arms) {
      const sg = L.side > 0 ? 1 : -1;
      if (state === 'bail') {
        L.A.rotation.z = sg * (1.6 + Math.sin(P.time * 16) * 0.6);
        L.A.rotation.x = Math.sin(P.time * 12 + sg) * 0.8;
        continue;
      }
      if (kind === 'scooter' && P.veh.grips) {
        const g = P.veh.grips[L.side > 0 ? 0 : 1].getWorldPosition(V());
        solveLimb(L, g, V(sg * 0.8, -0.2, -0.5).applyQuaternion(gl), null);
        continue;
      }
      if (R.grabK > 0.5 && state === 'air') {
        solveLimb(L, toW(sg * wid * 0.55, deckY + 0.03 + grabLift, sg * len * 0.18), V(sg * 0.8, 0, -0.5).applyQuaternion(gl), null);
        continue;
      }
      const wide = (kind === 'blades' ? 0.3 : 0.85) + 0.5 * Math.abs(R.steer) + (state === 'air' ? 0.45 : 0) + spread * 1.3;
      L.A.rotation.z = sg * wide;
      L.A.rotation.x = kind === 'blades' ? sg * Math.sin(R.stroke * Math.PI * 2) * 0.5 * (R.pushing ? 1 : 0.2) : R.steer * 0.3 * sg;
      L.B.rotation.x = -0.25;
    }
    vis.updateMatrixWorld(true);
  }

  function updateRideHud() {
    if (!hud || !P) return;
    const sc = hud.querySelector('#rideScore');
    const cb = hud.querySelector('#rideCombo');
    hud.querySelectorAll('[data-act^="ride:"]').forEach((b) => b.classList.toggle('on', b.dataset.act === 'ride:' + P.ride));
    if (!sc || !cb) return;
    const riding = P.ride !== 'walk' && P.rs;
    sc.hidden = !(riding || P.gear || P.score > 0);
    cb.hidden = !riding;
    sc.textContent = riding ? `Score ${P.score}  ·  Best combo ${P.best}` : `Score ${P.score}`;
    if (!riding) return;
    sc.textContent = `Score ${P.score}  ·  Best combo ${P.best}`;
    const R = P.rs;
    if (R.combo.length) cb.textContent = `${R.combo.map((c) => c.name).join(' + ')}   ${Math.round(R.comboPts)} × ${R.combo.length}`;
    else if (R.lastBank && P.time - R.lastBank.t < 3) cb.textContent = `+${R.lastBank.total}!  ${R.lastBank.names}`;
    else cb.textContent = '';
  }

  // ------------------------------------------------------------------ riding animals
  // You swap into the animal (it runs, jumps, climbs like it always does) and your old
  // character (whatever it was: person, dog, cat, your own model) sits on its back.
  function attachRider(riderId) {
    const C = P.char;
    if (!C.quad || !C.spine || !C.saddleLocal) return toast("That animal can't carry a rider. 🐾");
    let src = characterSource(riderId);
    let R = src ? buildCharacter(src) : null;
    if (!R) {
      riderId = 'person';
      R = buildCharacter(characterSource('person'));
    }
    const sc = clamp((C.saddleY * 1.6) / R.H, 0.2, 1.15);
    R.visual.scale.setScalar(sc);
    C.spine.add(R.visual); // child of the spine, so the rider rides along with every move
    const hipsY = R.hips ? R.hips.userData.rest.p.y : R.H * 0.5;
    R.visual.position.copy(C.saddleLocal).add(V(0, (-hipsY + 0.03) * sc, 0));
    R.visual.quaternion.identity();
    seatedPose(R);
    if (!R.biped) {
      // animals sit by their bounding box: belly on the saddle, centered on it (hips alone put them too far forward and into the mount)
      C.visual.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(R.visual);
      const ctr = box.getCenter(V());
      const sad = C.spine.localToWorld(C.saddleLocal.clone());
      const d = V(sad.x - ctr.x, sad.y - box.min.y + 0.01, sad.z - ctr.z);
      R.visual.position.add(C.spine.worldToLocal(C.spine.localToWorld(V()).add(d)));
    }
    R.visual.traverse((o) => o.isMesh && (o.castShadow = true));
    P.rider = { char: R, prevId: riderId, scale: sc };
    toast('You are riding! The animal does everything it can: run, jump, climb. Use “Get off” to hop down. 🐴');
  }
  function mount(kind) {
    if (!P) return;
    if (kind === 'mine') {
      const u = ctx.getUse && ctx.getUse();
      if (!u || u.use !== 'mount') return toast("Pick 'You can ride it' under 'What can it do?' in the editor first. 🐴");
    }
    if (P.drive) exitVehicle();
    if (P.ride !== 'walk') setRide('walk');
    if (P.gear) setGear('none');
    const rider = P.rider ? P.rider.prevId : charId;
    const at = P.body.position.clone();
    setCharacter(kind, { keepWorld: true, at, yaw: P.yaw, rider });
  }
  function dismount() {
    if (!P || !P.rider) return toast("You're not riding anything.");
    const prev = P.rider.prevId;
    const side = V(Math.cos(P.yaw), 0, -Math.sin(P.yaw)).multiplyScalar(P.char.W * 0.6 + 0.7);
    const at = V(P.body.position.x + side.x, P.body.position.y, P.body.position.z + side.z);
    setCharacter(prev, { keepWorld: true, at, yaw: P.yaw });
  }

  // ------------------------------------------------------------------ vehicles you can drive
  let vehicles = [];
  function addBoxShapes(body, root, skip) {
    const q = new THREE.Quaternion();
    const pos = V();
    const sc = V();
    const pm = new THREE.Matrix4();
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry || (skip && skip.has(o))) return;
      o.geometry.computeBoundingBox();
      const gb = o.geometry.boundingBox;
      const sz = gb.getSize(V());
      const ctr = gb.getCenter(V());
      o.updateWorldMatrix(true, false);
      pm.copy(o.matrixWorld).decompose(pos, q, sc);
      const cw = ctr.clone().multiply(sc).applyQuaternion(q).add(pos);
      body.addShape(
        new CANNON.Box(new CANNON.Vec3(Math.max(0.02, (sz.x * Math.abs(sc.x)) / 2), Math.max(0.02, (sz.y * Math.abs(sc.y)) / 2), Math.max(0.02, (sz.z * Math.abs(sc.z)) / 2))),
        new CANNON.Vec3(cw.x, cw.y, cw.z),
        new CANNON.Quaternion(q.x, q.y, q.z, q.w),
      );
    });
  }
  // simple built-in cars: body, cabin, four wheels (front ones steer), a seat spot
  function carModel({ len = 4, wid = 1.8, hgt = 0.7, color = 0xef476f, wr = 0.38, cab = true }) {
    const g = new THREE.Group();
    const add = (geo, c, x, y, z, role) => {
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 }));
      m.position.set(x, y, z);
      m.castShadow = true;
      if (role) m.userData.role = role;
      g.add(m);
      return m;
    };
    const bx = (w, h, d) => new THREE.BoxGeometry(w, h, d);
    const by = wr * 1.15 + hgt / 2;
    add(bx(wid, hgt, len), color, 0, by, 0);
    if (cab) {
      const glass = add(bx(wid * 0.86, hgt * 0.8, len * 0.42), 0xbfe3f5, 0, by + hgt * 0.9, -len * 0.06);
      glass.material.transparent = true;
      glass.material.opacity = 0.45;
    }
    for (const sx of [1, -1]) add(bx(wid * 0.2, hgt * 0.22, 0.06), 0xfde68a, sx * wid * 0.3, by + hgt * 0.1, len / 2);
    for (const sx of [1, -1]) add(bx(wid * 0.2, hgt * 0.22, 0.06), 0xef4444, sx * wid * 0.3, by + hgt * 0.1, -len / 2);
    add(bx(0.04, 0.04, 0.04), 0xffffff, 0, by + (cab ? hgt * 0.62 : hgt * 0.55), -len * 0.05, 'seat').visible = false;
    const wg = new THREE.CylinderGeometry(wr, wr, wr * 0.7, 18);
    wg.rotateZ(Math.PI / 2);
    for (const sx of [1, -1]) for (const sz of [1, -1]) add(wg, 0x1f2937, sx * (wid / 2 + wr * 0.05), wr, sz * len * 0.33, sz > 0 ? 'frontwheel' : 'wheel');
    return g;
  }
  function hoverModel() {
    const g = new THREE.Group();
    const add = (geo, c, x, y, z, role) => {
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: c, roughness: 0.4, metalness: 0.3 }));
      m.position.set(x, y, z);
      m.castShadow = true;
      if (role) m.userData.role = role;
      g.add(m);
      return m;
    };
    add(new THREE.BoxGeometry(2.0, 0.5, 3.4), 0x9d4edd, 0, 0.55, 0);
    add(new THREE.BoxGeometry(1.2, 0.5, 1.5), 0x7dd3fc, 0, 1.0, -0.2);
    for (const sx of [1, -1]) add(new THREE.CylinderGeometry(0.35, 0.35, 3.0, 12).rotateX(Math.PI / 2), 0xfacc15, sx * 1.15, 0.45, 0);
    add(new THREE.BoxGeometry(0.04, 0.04, 0.04), 0xffffff, 0, 1.0, -0.2, 'seat').visible = false;
    return g;
  }
  // Turn a model into something you can drive. `src` is a clean clone of the model.
  function makeVehicle(src, type, label, spawn) {
    const wrap = new THREE.Group();
    wrap.add(src);
    src.updateMatrixWorld(true);
    let bb = new THREE.Box3().setFromObject(wrap);
    const c = bb.getCenter(V());
    src.position.set(-c.x, -c.y, -c.z); // the middle of the car is the origin
    wrap.updateMatrixWorld(true);
    bb = new THREE.Box3().setFromObject(wrap);
    const size = bb.getSize(V());
    const wheelList = [];
    let seatMesh = null;
    src.traverse((o) => {
      if (!o.isMesh) return;
      const role = o.userData.role || (/wheel/i.test(o.name) ? (/front/i.test(o.name) ? 'frontwheel' : 'wheel') : null);
      if (type === 'car' && (role === 'wheel' || role === 'frontwheel')) wheelList.push({ mesh: o, front: role === 'frontwheel' });
      if (o.userData.role === 'seat') seatMesh = o;
    });
    const skip = new Set(wheelList.map((w) => w.mesh));
    const mass = clamp(size.x * size.y * size.z * 70, 80, 1800);
    const body = new CANNON.Body({ mass, material: propMat });
    body.linearDamping = 0.03;
    body.angularDamping = 0.3;
    addBoxShapes(body, wrap, skip);
    if (!body.shapes.length) {
      toast('That model has no shapes to drive.');
      return null;
    }
    // wheels stick out past the body shapes, so give it the inertia of the whole footprint (or it rolls over)
    {
      const w = size.x;
      const h = size.y;
      const d = size.z;
      const I = [(mass / 12) * (h * h + d * d), (mass / 12) * (w * w + d * d), (mass / 12) * (w * w + h * h)];
      body.inertia.set(I[0], I[1], I[2]);
      body.invInertia.set(1 / I[0], 1 / I[1], 1 / I[2]);
      body.invInertiaSolve.copy(body.invInertia);
      body.updateInertiaWorld(true);
    }
    const v = { type, body, wrap, src, label, size, mass, wheels: [], rv: null, steer: 0, driver: null, engSign: -1, steerSign: 1, spinSign: -1, heading: (spawn && spawn[3]) || 0 };
    let y0 = size.y / 2 + 0.3;
    if (type === 'car') {
      if (!wheelList.length)
        for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) wheelList.push({ mesh: null, front: sz > 0, center: V(sx * size.x * 0.42, -size.y * 0.5 + size.y * 0.22, sz * size.z * 0.36), radius: clamp(size.y * 0.25, 0.15, 0.7) });
      v.rv = new CANNON.RaycastVehicle({ chassisBody: body, indexRightAxis: 0, indexUpAxis: 1, indexForwardAxis: 2 });
      y0 = 0;
      for (const w of wheelList) {
        let center = w.center;
        let radius = w.radius;
        let baseQ = null;
        if (w.mesh) {
          const wb = new THREE.Box3().setFromObject(w.mesh);
          const wsz = wb.getSize(V());
          center = wb.getCenter(V());
          radius = Math.max(wsz.y, wsz.z, 0.05) / 2;
          src.attach(w.mesh);
          baseQ = w.mesh.quaternion.clone();
        }
        const rest = radius * 0.6;
        // cannon multiplies the spring force by the car's mass, so this is "per kilogram":
        // each spring squashes about 40% of its travel under its share of the weight
        const kS = GRAVITY / (wheelList.length * Math.max(0.04, rest * 0.4));
        v.rv.addWheel({
          radius,
          directionLocal: new CANNON.Vec3(0, -1, 0),
          suspensionStiffness: kS,
          suspensionRestLength: rest,
          frictionSlip: 5,
          dampingRelaxation: 0.42 * Math.sqrt(kS),
          dampingCompression: 0.8 * Math.sqrt(kS),
          maxSuspensionForce: mass * GRAVITY * 3,
          rollInfluence: 0.01,
          axleLocal: new CANNON.Vec3(-1, 0, 0),
          chassisConnectionPointLocal: new CANNON.Vec3(center.x, center.y + rest, center.z),
          maxSuspensionTravel: radius * 0.7,
          customSlidingRotationalSpeed: -30,
          useCustomSlidingRotationalSpeed: true,
        });
        v.wheels.push({ mesh: w.mesh, front: w.front, radius, center, baseQ });
        y0 = Math.max(y0, radius - center.y);
      }
      v.rv.addToWorld(world);
      v.driveIdx = v.wheels.map((w, i) => (w.front ? -1 : i)).filter((i) => i >= 0);
      if (!v.driveIdx.length) v.driveIdx = v.wheels.map((_, i) => i);
      v.steerIdx = v.wheels.map((w, i) => (w.front ? i : -1)).filter((i) => i >= 0);
      v.maxForce = mass * 8;
      v.brake = mass * 1.1;
      v.maxSteer = 0.5;
      body.linearDamping = 0.09;
    } else {
      v.hoverH = size.y * 0.5 + 0.55 * ws;
      y0 = v.hoverH;
      v.maxSpeed = 14;
    }
    v.seat = seatMesh ? new THREE.Box3().setFromObject(seatMesh).getCenter(V()) : V(0, size.y * 0.25, -size.z * 0.05);
    const at = spawn || [0, 0, 0];
    const gy = groundYAt(at[0], at[2], 5);
    body.position.set(at[0], gy + y0 + 0.04, at[2]);
    body.quaternion.setFromEuler(0, at[3] || 0, 0);
    body.collisionFilterGroup = WORLD;
    body.collisionFilterMask = ALL;
    body.userData = { vehicle: v, size: Math.max(size.x, size.y, size.z), mass };
    world.addBody(body);
    wrap.position.copy(body.position);
    wrap.quaternion.copy(body.quaternion);
    wrap.traverse((o) => o.isMesh && (o.castShadow = true));
    scene.add(wrap);
    vehicles.push(v);
    return v;
  }
  function vehiclesSync() {
    for (const v of vehicles) {
      v.wrap.position.copy(v.body.position);
      v.wrap.quaternion.copy(v.body.quaternion);
      if (!v.rv) continue;
      v.wheels.forEach((w, i) => {
        v.rv.updateWheelTransform(i);
        if (!w.mesh) return;
        const info = v.rv.wheelInfos[i];
        const lp = v.body.pointToLocalFrame(info.worldTransform.position);
        w.mesh.position.set(lp.x - v.src.position.x, lp.y - v.src.position.y, lp.z - v.src.position.z);
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(info.rotation * (v.spinSign || 1), info.steering, 0, 'YXZ'));
        if (w.baseQ) q.multiply(w.baseQ);
        w.mesh.quaternion.copy(q);
      });
    }
  }
  const vehFwd = (v) => V(0, 0, 1).applyQuaternion(new THREE.Quaternion(v.body.quaternion.x, v.body.quaternion.y, v.body.quaternion.z, v.body.quaternion.w));
  function nearestVehicle(maxD) {
    let best = null;
    let bd = 1e9;
    for (const v of vehicles) {
      const d = P.body.position.distanceTo(v.body.position) - v.size.length() * 0.3;
      if (d < bd && d < maxD) {
        bd = d;
        best = v;
      }
    }
    return best;
  }
  function enterVehicle(v) {
    if (v.driver) return toast('Someone is already driving that!');
    if (held) drop(true);
    if (P.gear) setGear('none');
    if (P.ride !== 'walk') setRide('walk');
    P.drive = { v, scale: 1 };
    v.driver = P;
    P.state = 'drive';
    P.body.collisionFilterMask = 0;
    P.body.velocity.set(0, 0, 0);
    camYaw = Math.atan2(vehFwd(v).x, vehFwd(v).z);
    toast(v.type === 'hover' ? '🛸 W go · A/D turn · Shift boost · Space hop · E get out' : '🚗 W/S gas and reverse · A/D steer · Space brake · Shift boost · U flip upright · E get out');
  }
  function exitVehicle() {
    if (!P || !P.drive) return;
    const v = P.drive.v;
    v.driver = null;
    P.drive = null;
    P.body.collisionFilterMask = WORLD;
    const f = vehFwd(v);
    const left = V(f.z, 0, -f.x);
    const out = left.multiplyScalar(v.size.x / 2 + P.r + 0.5);
    P.body.position.set(v.body.position.x + out.x, v.body.position.y + 0.6, v.body.position.z + out.z);
    P.body.velocity.set(v.body.velocity.x * 0.3, 1, v.body.velocity.z * 0.3);
    P.yaw = P.yawTarget = Math.atan2(f.x, f.z);
    P.state = 'air';
    P.char.visual.scale.setScalar(1);
    snapFeet();
    toast('Out you hop! 🚶');
  }
  function enterNearVehicle() {
    if (P.rider) return false;
    const v = nearestVehicle(2.6 * clamp(ws, 0.7, 1.4));
    if (!v) return false;
    enterVehicle(v);
    return true;
  }
  function seatDriver() {
    const C = P.char;
    const v = P.drive.v;
    const q = new THREE.Quaternion(v.body.quaternion.x, v.body.quaternion.y, v.body.quaternion.z, v.body.quaternion.w);
    const sc = clamp((v.size.y * 1.25) / C.H, 0.25, 1);
    const up = V(0, 1, 0).applyQuaternion(q);
    const seatW = v.seat.clone().applyQuaternion(q).add(V(v.body.position.x, v.body.position.y, v.body.position.z));
    const hipsY = C.hips ? C.hips.userData.rest.p.y : C.H * 0.5;
    C.visual.scale.setScalar(sc);
    C.visual.position.copy(seatW).addScaledVector(up, -hipsY * sc);
    C.visual.quaternion.copy(q);
    P.body.position.set(seatW.x, seatW.y, seatW.z);
    P.body.velocity.set(0, 0, 0);
    seatedPose(C);
  }
  // legs bent, hands forward: sitting in a seat or on a saddle
  function seatedPose(C) {
    for (const j of C.joints) {
      j.quaternion.copy(j.userData.rest.q);
      j.position.copy(j.userData.rest.p);
    }
    if (C.biped) {
      C.legs.forEach((L) => {
        L.A.rotation.set(-1.3, 0, L.side * 0.2);
        L.B.rotation.x = 1.4;
      });
      C.arms.forEach((L) => {
        L.A.rotation.set(-1.0, 0, L.side * 0.12);
        L.B.rotation.x = -0.4;
      });
    } else if (C.quad) {
      C.legs.forEach((L) => {
        L.A.rotation.x = L.front ? -1.1 : 1.0;
        L.B.rotation.x = L.front ? 1.2 : -1.2;
      });
    }
    C.visual.updateMatrixWorld(true);
  }
  function unflip(v) {
    const f = vehFwd(v);
    v.body.quaternion.setFromEuler(0, Math.atan2(f.x, f.z), 0);
    v.body.position.y += 1.2;
    v.body.velocity.set(0, 0, 0);
    v.body.angularVelocity.set(0, 0, 0);
  }

  // everything that follows the physics step, whether you are walking or driving
  function afterPhysics(dt) {
    for (const d of dyn) {
      d.mesh.position.copy(d.body.position);
      d.mesh.quaternion.copy(d.body.quaternion);
    }
    updateDarts(dt);
    updateFx(dt);
    updateTargets(dt);
    vehiclesSync();
    for (const d of dyn) if (d.body.position.y < -40) d.body.position.set(0, 3, 4);
    for (const v of vehicles)
      if (v.body.position.y < -40) {
        v.body.position.set(0, 3, 6);
        v.body.velocity.set(0, 0, 0);
      }
  }
  function driveUpdate(dt) {
    const v = P.drive.v;
    const b = v.body;
    const fi = (key('KeyW') ? 1 : 0) - (key('KeyS') ? 1 : 0);
    const ri = (key('KeyD') ? 1 : 0) - (key('KeyA') ? 1 : 0);
    const boost = key('ShiftLeft') || key('ShiftRight');
    const hand = key('Space');
    const f = vehFwd(v);
    const fs = b.velocity.x * f.x + b.velocity.y * f.y + b.velocity.z * f.z; // speed along the way it faces
    if (once('KeyU')) unflip(v);
    if (v.type === 'car') {
      const maxF = v.maxForce * (boost ? 1.8 : 1);
      const braking = hand || (fi < 0 && fs > 1.5) || (fi > 0 && fs < -1.5);
      const force = braking ? 0 : fi * maxF * (fi < 0 ? 0.6 : 1);
      v.rv.wheelInfos.forEach((_, i) => {
        v.rv.applyEngineForce(v.driveIdx.includes(i) ? (force / v.driveIdx.length) * (v.engSign || 1) : 0, i);
        v.rv.setBrake(braking ? v.brake : fi === 0 ? v.brake * 0.06 : 0, i);
      });
      const target = ((-ri * v.maxSteer) / (1 + Math.abs(fs) / 10)) * (v.steerSign || 1);
      v.steer = damp(v.steer, target, 9, dt);
      v.steerIdx.forEach((i) => v.rv.setSteeringValue(v.steer, i));
    } else {
      // hovercraft: floats on a cushion, glides, turns on the spot
      const tx = f.x * fi * v.maxSpeed * (boost ? 1.6 : 1);
      const tz = f.z * fi * v.maxSpeed * (boost ? 1.6 : 1);
      const k = Math.min(1, 2.4 * dt);
      b.velocity.x += (tx - b.velocity.x) * k;
      b.velocity.z += (tz - b.velocity.z) * k;
      const gy = groundYAt(b.position.x, b.position.z, b.position.y + 0.5);
      const want = gy + v.hoverH;
      b.velocity.y += ((want - b.position.y) * 7 - b.velocity.y) * Math.min(1, 6 * dt);
      if (once('Space')) b.velocity.y += 7;
      v.heading += -ri * 2.3 * dt;
      b.angularVelocity.set(0, 0, 0);
      b.quaternion.setFromEuler(0, v.heading, 0);
    }
    world.step(1 / 60, dt, 4);
    afterPhysics(dt);
    seatDriver();
    updateCamera(dt);
    updateHud();
  }
  function spawnVehicleNear(kind) {
    let src;
    let type = 'car';
    if (kind === 'mine') {
      const u = ctx.getUse && ctx.getUse();
      if (!u || (u.use !== 'car' && u.use !== 'hover')) return toast("Pick 'It drives' or 'It hovers' under 'What can it do?' in the editor first. 🚗");
      src = ctx.cloneModel();
      type = u.use;
    } else {
      src = kind === 'truck' ? carModel({ len: 5.2, wid: 2.2, hgt: 1.15, color: 0x118ab2, wr: 0.55 }) : kind === 'hover' ? hoverModel() : carModel({ len: 2.4, wid: 1.4, hgt: 0.4, color: 0xef476f, wr: 0.3, cab: false });
      src.scale.setScalar(ws);
      if (kind === 'hover') type = 'hover';
    }
    placeVehicle(src, type, kind, null);
  }
  // somewhere in front of you with nothing in the way (so a car does not land on a crate)
  function freeSpot(size) {
    const f = camForward();
    const left = V(f.z, 0, -f.x);
    const p = P.body.position;
    const r = size.length() * 0.5 + 0.8;
    for (let d = 5 * ws; d <= 40 * ws; d += 2.5 * ws)
      for (const lat of [0, 4 * ws, -4 * ws]) {
        const x = p.x + f.x * d + left.x * lat;
        const z = p.z + f.z * d + left.z * lat;
        let clear = true;
        for (const b of world.bodies) {
          if (b === P.body || !b.shapes.length) continue;
          b.updateAABB();
          const a = b.aabb;
          if (a.upperBound.y > 0.3 * ws && a.upperBound.x > x - r && a.lowerBound.x < x + r && a.upperBound.z > z - r && a.lowerBound.z < z + r) {
            clear = false;
            break;
          }
        }
        if (clear) return [x, 0, z, Math.atan2(f.x, f.z)];
      }
    return [p.x + f.x * 5 * ws, 0, p.z + f.z * 5 * ws, Math.atan2(f.x, f.z)];
  }
  function placeVehicle(src, type, label, at) {
    if (!src.children.length) return toast('Build something first!');
    if (!at) at = freeSpot(new THREE.Box3().setFromObject(src).getSize(V()));
    const v = makeVehicle(src, type, label, at);
    if (v) toast(`Press E next to “${label}” to ${type === 'hover' ? 'fly around' : 'drive'}! 🚗`);
  }
  function buildVehicles() {
    const place = (kind, x, z, yaw) => {
      const src = kind === 'truck' ? carModel({ len: 5.2, wid: 2.2, hgt: 1.15, color: 0x118ab2, wr: 0.55 }) : kind === 'hover' ? hoverModel() : kind === 'sedan' ? carModel({ len: 4.3, wid: 1.9, hgt: 0.7, color: [0xffd166, 0x06d6a0, 0xef476f, 0x9d4edd][Math.floor(Math.abs(x + z)) % 4], wr: 0.38 }) : carModel({ len: 2.4, wid: 1.4, hgt: 0.4, color: 0xef476f, wr: 0.3, cab: false });
      src.scale.setScalar(ws);
      makeVehicle(src, kind === 'hover' ? 'hover' : 'car', kind, [x * ws, 0, z * ws, yaw]);
    };
    sign('DRIVE ME! (press E)', [18, 4.5, 3]);
    place('kart', 12, 7, 0);
    place('truck', 19, 8, 0);
    place('hover', 26, 7, 0);
    place('sedan', 30, 16, Math.PI / 2);
    // sedans along the city streets
    for (const [x, z, yaw] of [[-40, 13.5, Math.PI / 2], [-66, -13.5, -Math.PI / 2], [-92, 13.5, Math.PI / 2], [-118, -13.5, -Math.PI / 2], [-40, -13.5, -Math.PI / 2]]) place('sedan', x, z, yaw);
  }

  // ------------------------------------------------------------------ foam swords and dart guns
  // your own models marked as shooters or swingables become gear too
  let customGear = [];
  const gearDef = (id) => GEAR[id] || (customGear.find((c) => c.id === id) || {}).G || null;
  const gearIds = () => [...GEAR_ORDER, ...customGear.map((c) => c.id)];
  const gearOf = () => (P && P.gear ? gearDef(P.gear) : null);
  function addCustomGear(src, use, cfg = {}, label = 'My gear', slot = null) {
    const id = 'my_' + (slot || customGear.length + 1);
    const bb = new THREE.Box3().setFromObject(src);
    const size = bb.getSize(V());
    const longest = Math.max(size.x, size.y, size.z, 0.05);
    const G =
      use === 'swing'
        ? { kind: 'melee', reach: clamp(1.2 + longest * 0.7, 1.6, 3.6), swing: 0.34, cool: 0.1, push: clamp(5 + longest * 4, 6, 15) }
        : { kind: 'gun', rate: cfg.auto ? 0.1 : 0.3, speed: 36, mag: cfg.auto ? 30 : 15, spread: cfg.auto ? 0.035 : 0.01, auto: !!cfg.auto, pellets: 1, proj: cfg.proj || 'dart' };
    G.label = label;
    G.icon = '🌟';
    const entry = { id, use, src, G };
    const old = customGear.findIndex((c) => c.id === id);
    if (old >= 0) customGear[old] = entry;
    else customGear.push(entry);
    rebuildGearBar();
    return id;
  }
  // the model, turned so its long side points forward, sized for a hand, grip at the origin
  function buildCustomGear(entry, bs) {
    const g = new THREE.Group();
    const holder = new THREE.Group();
    holder.add(entry.src.clone(true));
    g.add(holder);
    holder.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(holder);
    const size = box.getSize(V());
    if (size.x >= size.y && size.x >= size.z) holder.rotation.y = -Math.PI / 2;
    else if (size.y >= size.x && size.y >= size.z) holder.rotation.x = Math.PI / 2;
    g.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(holder);
    const sc = clamp((entry.use === 'swing' ? 0.9 : 0.45) / Math.max(box.max.z - box.min.z, 0.05), 0.2, 3) * bs;
    holder.scale.setScalar(sc);
    g.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(holder);
    const role = (r) => {
      let found = null;
      holder.traverse((o) => o.isMesh && o.userData.role === r && (found = o));
      return found ? new THREE.Box3().setFromObject(found).getCenter(V()) : null;
    };
    const mid = box.getCenter(V());
    const grip = role('grip') || V(mid.x, mid.y, box.min.z + (box.max.z - box.min.z) * 0.12);
    const muz = (role('muzzle') || V(mid.x, mid.y, box.max.z)).clone().sub(grip);
    holder.position.sub(grip);
    const muzzle = new THREE.Object3D();
    muzzle.position.copy(muz);
    g.add(muzzle);
    g.traverse((o) => o.isMesh && (o.castShadow = true));
    return { group: g, muzzle };
  }
  function rebuildGearBar() {
    const bar = hud && hud.querySelector('#gearBar');
    if (!bar) return;
    const items = [['none', '✋', 'Hands'], ...GEAR_ORDER.slice(1).map((id) => [id, GEAR[id].icon, GEAR[id].label]), ...customGear.map((c) => [c.id, '🌟', c.G.label])];
    bar.innerHTML = items.map(([id, ic, l]) => `<button class="mini" data-act="gear:${id}" title="${l}">${ic} ${l}</button>`).join('');
    updateGearHud();
  }
  function registerMyUse() {
    const u = ctx.getUse && ctx.getUse();
    customGear = customGear.filter((c) => c.id !== 'my_mine');
    if (u && (u.use === 'shooter' || u.use === 'swing')) {
      const src = ctx.cloneModel();
      if (src.children.length) addCustomGear(src, u.use, u.cfg, u.name || 'My model', 'mine');
    }
    rebuildGearBar();
  }
  function gearActive() {
    return !!P.gear && P.ride === 'walk' && !held && (P.state === 'ground' || P.state === 'air') && P.stance !== 'crawl';
  }
  function setGear(id) {
    if (!P) return;
    if (id !== 'none' && !gearDef(id)) return;
    if (id !== 'none' && P.ride !== 'walk') return toast('Hop off your ride first (V). 🛹');
    if (id !== 'none' && P.rider) return toast('Get off the animal first to use gear. 🐴');
    if (id !== 'none' && held) drop(true);
    if (P.gearMesh) {
      scene.remove(P.gearMesh.group);
      P.gearMesh = null;
    }
    P.gear = id === 'none' ? null : id;
    P.swing = null;
    if (P.gear) {
      P.gearBs = clamp(P.char.H / 1.7, 0.45, 1.6);
      const custom = customGear.find((c) => c.id === P.gear);
      P.gearMesh = custom ? buildCustomGear(custom, P.gearBs) : buildGear(P.gear, P.gearBs);
      scene.add(P.gearMesh.group);
      const G = gearDef(P.gear);
      if (G.kind === 'gun' && P.ammo[P.gear] == null) P.ammo[P.gear] = G.mag;
      toast(G.kind === 'melee' ? `${G.icon} ${G.label}! Click to swing. Hit crates, dummies and balloons!` : `${G.icon} ${G.label}! Aim with the camera, click to shoot, Z to reload.`);
    }
    updateGearHud();
  }
  function cycleGear() {
    const ids = gearIds();
    setGear(ids[(ids.indexOf(P.gear || 'none') + 1) % ids.length]);
  }
  function reloadGun() {
    const G = gearOf();
    if (!G || G.kind !== 'gun' || P.reload > 0 || P.ammo[P.gear] >= G.mag) return;
    P.reload = 1.1;
    toast('Reloading… 🔄');
    updateGearHud();
  }
  function attack() {
    const G = gearOf();
    if (!G || !gearActive()) return;
    if (G.kind === 'melee') {
      if (P.swing || P.swingCd > 0) return;
      P.swingStep = P.swingT && P.time - P.swingT < 0.9 ? (P.swingStep + 1) % 3 : 0;
      P.swingT = P.time;
      P.swing = { t: 0, dur: G.swing, step: P.swingStep, hit: false };
      P.swingCd = G.swing + G.cool;
    } else fireGun(G);
  }
  function swingPose() {
    if (!P.swing) return { yawOff: -0.55, pitch: 0.55 };
    const u = smooth(clamp(P.swing.t / P.swing.dur, 0, 1));
    if (P.swing.step === 0) return { yawOff: 1.3 - 2.6 * u, pitch: 0.15 };
    if (P.swing.step === 1) return { yawOff: -1.3 + 2.6 * u, pitch: 0.1 };
    return { yawOff: 0, pitch: 1.4 - 1.7 * u }; // overhead
  }
  function meleeHit() {
    const G = gearOf();
    const C = P.char;
    const center = V(C.visual.position.x, C.visual.position.y + C.H * 0.55, C.visual.position.z);
    const fwd = fwdOf(P.yaw);
    const reach = G.reach * clamp(ws, 0.6, 1.3);
    let n = 0;
    const inFront = (bp, size) => {
      const to = V(bp.x - center.x, bp.y - center.y, bp.z - center.z);
      return to.length() <= reach + size * 0.5 && (to.length() < 0.35 || to.clone().normalize().dot(fwd) > 0.1) ? to : null;
    };
    for (const bdy of new Set([...props, ...dummies.map((d) => d.body)])) {
      const to = inFront(bdy.position, bdy.userData.size || 0.4);
      if (!to) continue;
      const dir = to.clone().setY(0);
      if (dir.lengthSq() < 1e-4) dir.copy(fwd);
      dir.normalize();
      const sp = clamp(G.push * (1.3 - 0.06 * Math.min(bdy.mass, 12)), G.push * 0.45, G.push * 1.3);
      bdy.velocity.set(dir.x * sp, 2.5 + sp * 0.35, dir.z * sp);
      bdy.angularVelocity.set((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9);
      bdy.wakeUp();
      burst(bdy.position, 0xffffff, 6);
      n++;
    }
    for (const b of [...balloons]) if (inFront(b.position, b.userData.size)) popBalloon(b);
    if (n) {
      P.score += 10 * n;
      popup(`Whack! +${10 * n}`, V(center.x + fwd.x * 1.2, center.y + 0.6, center.z + fwd.z * 1.2));
      updateRideHud();
    }
  }
  function muzzleWorld() {
    const gm = P.gearMesh;
    if (gm && gm.muzzle) return gm.muzzle.getWorldPosition(V());
    return V(P.char.visual.position.x, P.char.visual.position.y + P.char.H * 0.8, P.char.visual.position.z);
  }
  function aimPoint() {
    const o = camera.position.clone();
    const d = camera.getWorldDirection(V());
    const hit = ray(o, o.clone().addScaledVector(d, 90));
    return hit ? hit.point : o.clone().addScaledVector(d, 60);
  }
  function fireGun(G) {
    if (P.reload > 0 || P.fireCd > 0) return;
    if ((P.ammo[P.gear] || 0) <= 0) return reloadGun();
    P.fireCd = G.rate;
    P.ammo[P.gear]--;
    P.recoil = 1;
    const M = muzzleWorld();
    const base = aimPoint().sub(M);
    if (base.length() < 1.0) base.copy(camera.getWorldDirection(V()));
    base.normalize();
    for (let i = 0; i < G.pellets; i++) {
      const d = base.clone().add(V((Math.random() - 0.5) * 2 * G.spread, (Math.random() - 0.5) * 2 * G.spread, (Math.random() - 0.5) * 2 * G.spread)).normalize();
      spawnDart(M, d.multiplyScalar(G.speed), G.proj || 'dart');
    }
    if (P.ammo[P.gear] <= 0) reloadGun();
    updateGearHud();
  }
  const CONFETTI = [0xef476f, 0xffd166, 0x06d6a0, 0x118ab2, 0x9d4edd, 0xfb8500];
  function spawnDart(pos, vel, kind = 'dart') {
    const sz = clamp(ws, 0.5, 1.4);
    const ball = kind === 'ball';
    const body = new CANNON.Body({ mass: ball ? 0.25 : 0.03, material: ball ? ballMat : propMat });
    body.addShape(new CANNON.Sphere((ball ? 0.1 : 0.035) * sz));
    body.position.set(pos.x, pos.y, pos.z);
    body.velocity.set(vel.x, vel.y, vel.z);
    body.collisionFilterGroup = DART;
    body.collisionFilterMask = WORLD;
    body.linearDamping = 0.02;
    const col = CONFETTI[Math.floor(Math.random() * CONFETTI.length)];
    const mesh =
      kind === 'ball'
        ? new THREE.Mesh(new THREE.SphereGeometry(0.1 * sz, 12, 8), new THREE.MeshStandardMaterial({ color: col, roughness: 0.4 }))
        : kind === 'confetti'
          ? new THREE.Mesh(new THREE.OctahedronGeometry(0.07 * sz), new THREE.MeshBasicMaterial({ color: col }))
          : buildDart(sz * 1.5);
    mesh.position.copy(pos);
    scene.add(mesh);
    world.addBody(body);
    const d = { body, mesh, kind, anti: kind === 'ball' ? 0.45 : 0.85, life: 0, stuck: false, done: false, pending: null };
    body.addEventListener('collide', (e) => onDartHit(d, e));
    darts.push(d);
    while (darts.length > 70) removeDart(darts[0]);
  }
  function removeDart(d) {
    world.removeBody(d.body);
    scene.remove(d.mesh);
    if (d.kind !== 'dart') {
      d.mesh.geometry.dispose();
      d.mesh.material.dispose();
    }
    darts.splice(darts.indexOf(d), 1);
  }
  function onDartHit(d, e) {
    if (d.stuck || d.done) return;
    const o = e.body;
    const ud = o.userData || {};
    if (d.kind === 'ball' && !ud.balloon) {
      // bouncy balls keep bouncing and shove things harder
      if (ud.bull && !d.scored) {
        d.scored = true;
        scoreBull(o, d.body.position);
      }
      if (o.mass > 0 && o.type !== CANNON.Body.STATIC) {
        const dir = d.body.velocity.clone();
        dir.normalize();
        const k = 6 / Math.pow(Math.max(o.mass, 1), 0.4);
        o.velocity.x += dir.x * k;
        o.velocity.y += dir.y * k + 0.5;
        o.velocity.z += dir.z * k;
        o.wakeUp();
      }
      return;
    }
    d.done = true;
    if (d.kind === 'confetti' && !ud.balloon) {
      burst(d.body.position, CONFETTI, 24);
      d.life = 99;
      if (ud.bull) scoreBull(o, d.body.position);
      return;
    }
    if (ud.balloon) {
      d.popTarget = o; // popped after the physics step: you can't remove a body in the middle of one
      d.life = 99;
      return;
    }
    if (o.mass === 0 || o.type === CANNON.Body.STATIC) {
      d.pending = { stick: true, other: o };
      if (ud.bull) scoreBull(o, d.body.position);
    } else {
      const dir = d.body.velocity.clone();
      dir.normalize();
      o.velocity.x += dir.x * 1.8;
      o.velocity.y += dir.y * 1.8 + 0.4;
      o.velocity.z += dir.z * 1.8;
      o.wakeUp();
      burst(d.body.position, 0xf97316, 3);
    }
  }
  function scoreBull(o, hitPos) {
    const lp = o.pointToLocalFrame(new CANNON.Vec3(hitPos.x, hitPos.y, hitPos.z));
    const r = Math.hypot(lp.x, lp.y) / (o.userData.size * 0.5);
    const [pts, name] = r < 0.14 ? [100, 'Bullseye!'] : r < 0.4 ? [50, 'Great!'] : r < 0.7 ? [25, 'Nice!'] : [10, 'Hit'];
    P.score += pts;
    popup(`${name} +${pts}`, V(hitPos.x, hitPos.y + 0.5, hitPos.z + 0.3));
    updateRideHud();
  }
  function popBalloon(b) {
    if (!balloons.includes(b)) return;
    const u = b.userData;
    burst(b.position, u.color, 14);
    scene.remove(u.mesh);
    world.removeBody(b);
    balloons.splice(balloons.indexOf(b), 1);
    P.score += 50;
    popup('Pop! +50', V(b.position.x, b.position.y + 0.4, b.position.z));
    respawns.push({ t: 9, fn: () => addBalloon(u.pos, u.color) });
    updateRideHud();
  }
  function burst(at, color, n) {
    for (let i = 0; i < n; i++) {
      const sz = 0.07 * clamp(ws, 0.5, 1.3);
      const m = new THREE.Mesh(new THREE.BoxGeometry(sz, sz, sz), new THREE.MeshBasicMaterial({ color: Array.isArray(color) ? color[i % color.length] : i % 2 ? color : 0xffffff }));
      m.position.set(at.x, at.y, at.z);
      scene.add(m);
      fx.push({ m, v: V((Math.random() - 0.5) * 5, Math.random() * 4 + 1, (Math.random() - 0.5) * 5), t: 0 });
    }
  }
  function popup(text, at) {
    const cv = document.createElement('canvas');
    cv.width = 320;
    cv.height = 80;
    const c = cv.getContext('2d');
    c.font = 'bold 46px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineWidth = 8;
    c.strokeStyle = '#4c2fbf';
    c.strokeText(text, 160, 42);
    c.fillStyle = '#fff';
    c.fillText(text, 160, 42);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, depthTest: false }));
    sp.scale.set(2.2 * clamp(ws, 0.6, 1.3), 0.55 * clamp(ws, 0.6, 1.3), 1);
    sp.position.set(at.x, at.y, at.z);
    sp.renderOrder = 50;
    scene.add(sp);
    popups.push({ sp, t: 0 });
  }
  function updateDarts(dt) {
    const Z = V(0, 0, 1);
    for (const d of [...darts]) {
      d.life += dt;
      if (d.popTarget) {
        if (balloons.includes(d.popTarget)) popBalloon(d.popTarget);
        d.popTarget = null;
      }
      if (d.pending && d.pending.stick) {
        d.body.velocity.set(0, 0, 0);
        d.body.type = CANNON.Body.STATIC;
        d.body.mass = 0;
        d.body.updateMassProperties();
        d.body.collisionFilterMask = 0;
        d.stuck = true;
        d.life = 0;
        d.pending = null;
      }
      if (!d.stuck) {
        const v = d.body.velocity;
        if (d.kind === 'dart' && v.length() > 0.6) d.mesh.quaternion.setFromUnitVectors(Z, V(v.x, v.y, v.z).normalize());
        else if (d.kind !== 'dart') d.mesh.quaternion.set(d.body.quaternion.x, d.body.quaternion.y, d.body.quaternion.z, d.body.quaternion.w);
        d.mesh.position.copy(d.body.position);
      }
      if ((d.stuck && d.life > 25) || (d.done && !d.stuck && d.life > 4) || (!d.done && d.life > (d.kind === 'ball' ? 8 : 6))) removeDart(d);
    }
  }
  function updateFx(dt) {
    for (const f of [...fx]) {
      f.t += dt;
      f.v.y -= GRAVITY * 0.6 * dt;
      f.m.position.addScaledVector(f.v, dt);
      f.m.scale.setScalar(Math.max(0.01, 1 - f.t / 0.9));
      if (f.t > 0.9) {
        scene.remove(f.m);
        fx.splice(fx.indexOf(f), 1);
      }
    }
    for (const pp of [...popups]) {
      pp.t += dt;
      pp.sp.position.y += dt * 1.1;
      pp.sp.material.opacity = clamp(2 - pp.t * 1.1, 0, 1);
      if (pp.t > 1.8) {
        scene.remove(pp.sp);
        popups.splice(popups.indexOf(pp), 1);
      }
    }
  }
  // balloons bob, knocked-over dummies stand back up, popped balloons come back
  function updateTargets(dt) {
    for (const b of balloons) b.userData.mesh.position.y = b.userData.home.y + Math.sin(P.time * 1.6 + b.userData.phase) * 0.12 * ws;
    for (const d of dummies) {
      const up = V(0, 1, 0).applyQuaternion(new THREE.Quaternion(d.body.quaternion.x, d.body.quaternion.y, d.body.quaternion.z, d.body.quaternion.w)).y;
      if (!d.scored && up < 0.55) {
        d.scored = true;
        d.downT = 0;
        P.score += 25;
        popup('Knocked over! +25', V(d.body.position.x, d.body.position.y + 1, d.body.position.z));
        updateRideHud();
      }
      if (d.scored) {
        d.downT += dt;
        if (d.downT > 6) {
          d.body.position.copy(d.home.p);
          d.body.quaternion.copy(d.home.q);
          d.body.velocity.set(0, 0, 0);
          d.body.angularVelocity.set(0, 0, 0);
          d.scored = false;
        }
      }
    }
    for (const r of [...respawns]) {
      r.t -= dt;
      if (r.t <= 0) {
        r.fn();
        respawns.splice(respawns.indexOf(r), 1);
      }
    }
  }
  function gearTick(dt) {
    P.fireCd = Math.max(0, P.fireCd - dt);
    P.swingCd = Math.max(0, P.swingCd - dt);
    if (P.reload > 0) {
      P.reload -= dt;
      if (P.reload <= 0) {
        P.reload = 0;
        if (gearOf() && gearOf().kind === 'gun') P.ammo[P.gear] = gearOf().mag;
        updateGearHud();
      }
    }
    if (P.swing) {
      P.swing.t += dt;
      const u = P.swing.t / P.swing.dur;
      if (!P.swing.hit && u >= 0.45) {
        P.swing.hit = true;
        meleeHit();
      }
      if (u >= 1) P.swing = null;
    }
    const G = gearOf();
    const trig = mouseDown || key('KeyF');
    if (G && gearActive() && trig && (!P.trigLatch || G.auto)) attack();
    P.trigLatch = trig;
  }

  // where the gear is and what the arms do with it
  const quatFacing = (dir) => {
    const z = dir.clone().normalize();
    const x = UP.clone().cross(z);
    if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
    x.normalize();
    const y = z.clone().cross(x);
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  };
  const endOf = (L) => (L.C ? L.C.getWorldPosition(V()) : L.B.localToWorld(L.endLocal.clone()));
  function gearUpdate(dt) {
    const gm = P.gearMesh;
    if (!gm) return;
    const act = gearActive();
    gm.group.visible = act;
    if (!act) return;
    const C = P.char;
    const G = gearDef(P.gear);
    P.recoil = Math.max(0, P.recoil - dt * 7);
    const bs = P.gearBs;
    const fwd = fwdOf(P.yaw);
    const left = leftOf(P.yaw);
    const aim = G.kind === 'gun' ? camera.getWorldDirection(V()) : fwd.clone();
    if (G.kind === 'gun') {
      aim.y = clamp(aim.y, -0.6, 0.7);
      aim.normalize();
    }
    let dir = aim;
    let at = null;
    const sw = swingPose();
    const fy = V(Math.sin(P.yaw + sw.yawOff), 0, Math.cos(P.yaw + sw.yawOff));
    const bladeDir = fy.clone().multiplyScalar(Math.cos(sw.pitch)).addScaledVector(UP, Math.sin(sw.pitch)).normalize();
    if (G.kind === 'melee') dir = bladeDir;
    if (C.biped) {
      const Rt = C.arms.find((L) => L.side < 0);
      const Lf = C.arms.find((L) => L.side > 0);
      const sh = Rt.A.getWorldPosition(V());
      const armLen = Rt.l1 + Rt.l2;
      const handT =
        G.kind === 'gun'
          ? sh.clone().addScaledVector(aim, armLen * 0.85).addScaledVector(UP, -0.04 * C.H).addScaledVector(left, 0.05)
          : sh.clone().addScaledVector(fy, armLen * 0.7).addScaledVector(UP, -armLen * 0.25 + Math.sin(sw.pitch) * armLen * 0.3);
      solveLimb(Rt, handT, V().addScaledVector(left, -0.5).addScaledVector(UP, -0.5).addScaledVector(fwd, -0.3), null);
      at = endOf(Rt);
      if (G.kind === 'gun') {
        const grip = at.clone().addScaledVector(aim, 0.2 * bs);
        solveLimb(Lf, grip, V().addScaledVector(left, 0.5).addScaledVector(UP, -0.5).addScaledVector(fwd, -0.3), null);
      } else {
        Lf.A.rotation.z = 0.45;
        Lf.A.rotation.x = -0.3;
        Lf.B.rotation.x = -0.5;
      }
    } else {
      const base = C.head ? C.head.getWorldPosition(V()) : C.visual.position.clone().add(V(0, C.H * 0.8, 0));
      if (G.kind === 'melee') {
        if (C.head) C.head.rotation.y = sw.yawOff * 0.6;
        at = base.clone().addScaledVector(fwd, 0.2 * C.D).addScaledVector(UP, -0.03 * C.H);
      } else {
        at = C.visual.position.clone().add(V(0, C.H * 1.0, 0)).addScaledVector(fwd, -0.05 * C.D);
      }
    }
    at.addScaledVector(dir, -0.05 * bs * P.recoil);
    gm.group.position.copy(at);
    gm.group.quaternion.copy(quatFacing(dir));
    gm.group.updateMatrixWorld(true);
  }
  function updateGearHud() {
    if (!hud || !P) return;
    hud.querySelectorAll('[data-act^="gear:"]').forEach((b) => b.classList.toggle('on', b.dataset.act === 'gear:' + (P.gear || 'none')));
    const G = gearOf();
    const am = hud.querySelector('#gearAmmo');
    if (am) am.textContent = G && G.kind === 'gun' ? (P.reload > 0 ? 'Reloading…' : `${P.ammo[P.gear]} / ${G.mag} darts`) : '';
    const cross = hud.querySelector('#cross');
    if (cross) cross.hidden = !(G && G.kind === 'gun');
  }

  // ---- zones
  const ZONES = { start: { x: 0, z: 0, yaw: 0, name: 'the start' }, skate: { x: 38, z: 3, yaw: 0, name: 'the skate park 🛹' }, city: { x: -33, z: 0, yaw: -Math.PI / 2, name: 'the city 🏙️' }, range: { x: 20, z: -20, yaw: Math.PI, name: 'the target range 🎯' } };
  const ZONE_ORDER = ['start', 'skate', 'city', 'range'];
  let zoneIdx = 0;
  function goZone(id) {
    const z = ZONES[id];
    if (!z || !P) return;
    if (P.drive) exitVehicle();
    zoneIdx = ZONE_ORDER.indexOf(id);
    P.body.position.set(z.x * ws, P.r + 0.6, z.z * ws);
    P.body.velocity.set(0, 0, 0);
    camYaw = z.yaw;
    P.yaw = P.yawTarget = z.yaw;
    if (P.rs) {
      P.rs.heading = z.yaw;
      P.rs.speed = 0;
    }
    P.state = 'air';
    snapFeet();
    toast(`Zooming to ${z.name}`);
  }
  const cycleZone = () => goZone(ZONE_ORDER[(zoneIdx + 1) % ZONE_ORDER.length]);


  // ------------------------------------------------------------------ controls
  const key = (c) => keys.has(c);
  const once = (c) => pressedOnce.delete(c);
  function preStep() {
    if (!P) return;
    const b = P.body;
    if (P.antiGrav > 0) b.force.y += GRAVITY * b.mass * P.antiGrav;
    for (const d of darts) if (!d.stuck) d.body.force.y += GRAVITY * d.body.mass * d.anti;
    if (held) {
      const hp = holdPoint();
      held.velocity.set((hp.x - held.position.x) * 16, (hp.y - held.position.y) * 16, (hp.z - held.position.z) * 16);
      held.wakeUp();
    }
  }

  function setStanceShape(hs) {
    P.hsCur = hs;
    P.zs.forEach((z, ci) => {
      for (let i = 0; i < P.nS; i++) b_setOffset(P.body, ci * P.nS + i, (hs * i) / (P.nS - 1), z);
    });
    P.body.updateBoundingRadius();
    P.body.aabbNeedsUpdate = true;
  }
  function b_setOffset(body, idx, y, z) {
    body.shapeOffsets[idx].set(0, y, z);
  }

  function headroom(hsTarget) {
    const b = P.body;
    const from = V(b.position.x, b.position.y + P.hsCur, b.position.z);
    const to = V(b.position.x, b.position.y + hsTarget + P.r + 0.04, b.position.z);
    if (to.y <= from.y) return true;
    return !ray(from, to);
  }

  function update(dt) {
    if (!running || !P) return;
    dt = Math.min(dt, 1 / 20);
    P.time += dt;
    const b = P.body;
    const C = P.char;
    P.coyote = Math.max(0, P.coyote - dt);
    P.jumpBuf = Math.max(0, P.jumpBuf - dt);
    P.wallCool = Math.max(0, P.wallCool - dt);
    P.climbCool = Math.max(0, P.climbCool - dt);
    P.landT = Math.max(0, P.landT - dt);
    P.throwAnim = Math.max(0, P.throwAnim - dt * 2.6);
    P.bounceCool = Math.max(0, P.bounceCool - dt);
    if (key('ArrowLeft')) camYaw += 1.8 * dt;
    if (key('ArrowRight')) camYaw -= 1.8 * dt;
    if (key('ArrowUp')) camPitch = clamp(camPitch - 1.2 * dt, -0.4, 1.2);
    if (key('ArrowDown')) camPitch = clamp(camPitch + 1.2 * dt, -0.4, 1.2);
    if (once('Space')) P.jumpBuf = 0.14;
    if (once('KeyE')) {
      if (P.drive) exitVehicle();
      else if (!enterNearVehicle()) tryPickUp();
    }
    if (once('KeyF')) {
      if (held) throwHeld();
      else if (!P.gear) tryPickUp();
    }
    if (once('KeyQ')) cycleGear();
    if (once('KeyZ')) reloadGun();
    if (once('KeyY')) cycleZone();
    if (once('KeyV')) cycleRide();
    if (once('KeyH') && hud) {
      const h = hud.querySelector('#playHelp');
      if (h) h.hidden = !h.hidden;
    }
    if (once('KeyM') && hud) {
      const b = hud.querySelector('#burger');
      if (b) b.click();
    }
    if (once('KeyX')) P.crawlToggle = !P.crawlToggle;
    if (once('Digit1')) spawnBox();
    if (once('Digit2')) spawnBallProp();
    if (once('Digit3')) spawnMyModel();
    if (once('KeyR')) {
      resetWorldObjects();
      P.body.position.set(0, P.r + 0.02, 0);
      P.body.velocity.set(0, 0, 0);
      P.state = 'ground';
      snapFeet();
      toast('Fresh playground! 🔄');
    }
    if (once('KeyT')) goZone('start');
    gearTick(dt);
    if (held && mouseDown) P.charge += dt;
    if (!mouseDown && P.charge > 0 && held) throwHeld();
    if (!held && !mouseDown) P.charge = Math.max(0, P.charge - dt * 3);

    // ---- input
    const fi = (key('KeyW') ? 1 : 0) - (key('KeyS') ? 1 : 0);
    const ri = (key('KeyD') ? 1 : 0) - (key('KeyA') ? 1 : 0);
    const F = V(Math.sin(camYaw), 0, Math.cos(camYaw));
    const R = V(-Math.cos(camYaw), 0, Math.sin(camYaw));
    const mv = F.clone().multiplyScalar(fi).addScaledVector(R, ri);
    if (mv.lengthSq() > 1) mv.normalize();
    const running_ = key('ShiftLeft') || key('ShiftRight');
    const bodyFwd = fwdOf(P.yaw);

    if (P.drive) return driveUpdate(dt);

    // ---- stance: stand / crouch / crawl, with a headroom check
    let want = P.ride !== 'walk' ? 'stand' : P.crawlToggle ? 'crawl' : key('KeyC') || key('ControlLeft') ? 'crouch' : 'stand';
    const wantHs = { stand: P.hsStand, crouch: P.hsCrouch, crawl: 0 };
    if (P.ride === 'walk' && want === 'stand' && !headroom(P.hsStand)) want = 'crouch';
    if (P.ride === 'walk' && want === 'crouch' && !headroom(P.hsCrouch)) want = 'crawl';
    // walking toward something low (a tunnel, a beam): duck under it by yourself
    if (P.ride === 'walk' && P.state === 'ground' && P.grounded && mv.lengthSq() > 0.01 && want !== 'crawl') {
      const d = mv.clone().normalize();
      const feet = b.position.y - P.r;
      const stepMax = Math.min(0.32 * C.H, 0.6 * ws);
      const clearAhead = (hsT) => {
        const total = hsT + 2 * P.r;
        if (total <= stepMax + 0.05) return true;
        for (let i = 0; i < 4; i++) {
          const h = stepMax + 0.08 + ((total * 0.97 - stepMax - 0.08) * i) / 3;
          if (rayDir(V(b.position.x, feet + h, b.position.z), d, P.r + 0.3 * ws, WORLD)) return false;
        }
        return true;
      };
      const order = ['stand', 'crouch', 'crawl'];
      for (let i = order.indexOf(want); i < order.length; i++) {
        if (clearAhead(wantHs[order[i]])) {
          if (i > order.indexOf(want)) want = order[i];
          break;
        }
      }
    }
    if (P.state === 'ground' || P.state === 'air') P.stance = want;
    else P.stance = 'stand';
    const hsT = wantHs[P.stance];
    if (Math.abs(hsT - P.hsCur) > 0.002) setStanceShape(damp(P.hsCur, hsT, 14, dt));

    // ---- ground check
    const wasGround = P.grounded;
    const riding = P.ride !== 'walk';
    const gHit = ray(V(b.position.x, b.position.y, b.position.z), V(b.position.x, b.position.y - P.r - (riding ? 0.34 : 0.16) * ws, b.position.z));
    P.grounded = !!gHit && gHit.normal.y > (riding ? 0.2 : 0.55) && b.velocity.y < P.jumpV * (riding ? 0.6 : 0.55);
    if (gHit) P.groundNormal.copy(gHit.normal);
    P.groundBody = gHit ? gHit.body : null;
    if (P.grounded) {
      P.coyote = 0.12;
      P.jumps = 0;
      P.airT = 0;
      if (!wasGround && (P.state === 'air' || P.state === 'wallrun')) P.landT = 0.3;
    } else P.airT += dt;

    // ---- climbing: walk into a wall with holds
    if (P.ride === 'walk' && P.state !== 'climb' && P.state !== 'mantle' && P.climbCool <= 0 && fi > 0.2) {
      const hit = rayDir(V(b.position.x, b.position.y + Math.max(P.hsCur * 0.5, 0.05), b.position.z), bodyFwd, P.r + 0.55 * ws, WORLD);
      if (hit && hit.body.userData && hit.body.userData.climb && Math.abs(hit.normal.y) < 0.3) {
        P.state = 'climb';
        P.climbN = V(hit.normal.x, 0, hit.normal.z).normalize();
        P.wallDist = P.r + 0.03;
        toast('Climbing! W/S up and down, A/D sideways, Space to jump off. 🧗');
      }
    }
    // ---- wall run up: jump at a wall while running at it
    if (P.ride === 'walk' && !P.grounded && P.state === 'air' && P.wallCool <= 0 && P.speedH > 2.8 * P.k && fi > 0) {
      const vh = V(b.velocity.x, 0, b.velocity.z).normalize();
      const hitF = rayDir(V(b.position.x, b.position.y + Math.max(P.hsCur * 0.5, 0.05), b.position.z), vh, P.r + 0.8 * ws, WORLD);
      if (hitF && hitF.body.mass === 0 && Math.abs(hitF.normal.y) < 0.3 && vh.dot(hitF.normal) < -0.55) {
        const s0 = clamp(Math.max(P.speedH, P.run * 0.8), 3, 8.5);
        P.state = 'wallup';
        P.wall = {
          N: V(hitF.normal.x, 0, hitF.normal.z).normalize(),
          side: 0, s0, speed: s0, dist: 0, phase: 0, dWall: P.r + 0.03,
          len: clamp(1.5 * P.char.H + s0 * 0.25, 2.2, 6.5) * ws,
          tangent: UP.clone(),
        };
        P.wallT = 0;
        P.jumps = 1;
        toast('Wall run up! Space to flip off. 🧗‍♂️');
      }
    }
    // ---- wall run: in the air, going fast, wall beside you
    if (P.ride === 'walk' && !P.grounded && P.state === 'air' && P.wallCool <= 0 && P.speedH > 2.8 * P.k) {
      const vh = V(b.velocity.x, 0, b.velocity.z).normalize();
      const left = V().crossVectors(UP, vh);
      for (const side of [1, -1]) {
        const dir = left.clone().multiplyScalar(side);
        const hit = rayDir(V(b.position.x, b.position.y + Math.max(P.hsCur * 0.5, 0.05), b.position.z), dir, P.r + 0.8 * ws, WORLD);
        if (hit && hit.body.mass === 0 && Math.abs(hit.normal.y) < 0.3) {
          const s0 = clamp(Math.max(P.speedH, P.run * 0.9), 3, 9);
          const N0 = V(hit.normal.x, 0, hit.normal.z).normalize();
          const tan0 = vh.clone().addScaledVector(N0, -vh.dot(N0)).normalize();
          P.state = 'wallrun';
          P.wall = { N: N0, side, s0, speed: s0, dist: 0, phase: 0, dWall: P.r + 0.03, len: clamp(6 + s0 * 1.1, 9, 16) * ws, tangent: tan0 };
          P.wallT = 0;
          P.jumps = 1;
          toast('Wall run! Press Space to jump off. 🏃');
          break;
        }
      }
    }

    // ---- state machine
    P.antiGrav = 0;
    const v = b.velocity;
    if (P.ride !== 'walk') {
      rideStep(dt, fi, -ri, running_);
    } else if (P.state === 'mantle') {
      P.mantle.t += dt / 0.45;
      const t = Math.min(1, P.mantle.t);
      const e = smooth(t);
      const m = P.mantle;
      b.position.set(
        m.from.x + (m.to.x - m.from.x) * smooth(clamp((t - 0.35) / 0.65, 0, 1)),
        m.from.y + (m.to.y - m.from.y) * clamp(e * 1.4, 0, 1),
        m.from.z + (m.to.z - m.from.z) * smooth(clamp((t - 0.35) / 0.65, 0, 1)),
      );
      v.set(0, 0, 0);
      if (t >= 1) {
        P.state = 'ground';
        b.collisionFilterMask = WORLD;
        P.climbCool = 0.5;
      }
    } else if (P.state === 'climb') {
      const N = P.climbN;
      const hitC = rayDir(V(b.position.x, b.position.y + Math.max(P.hsCur * 0.5, 0.05), b.position.z), N.clone().negate(), P.r + 0.7 * ws, WORLD);
      const hitHead = rayDir(V(b.position.x, b.position.y + P.hsCur + P.r * 0.4, b.position.z), N.clone().negate(), P.r + 0.7 * ws, WORLD);
      P.yawTarget = Math.atan2(-N.x, -N.z);
      const upI = (key('KeyW') ? 1 : 0) - (key('KeyS') ? 1 : 0);
      const sideI = (key('KeyD') ? 1 : 0) - (key('KeyA') ? 1 : 0);
      const Tr = V().crossVectors(UP, N); // player's right on the wall
      const sp = 2.8 * P.k;
      const vel = UP.clone().multiplyScalar(upI * sp).addScaledVector(Tr, sideI * sp * 0.8);
      if (hitC) {
        const dist = V(b.position.x - hitC.point.x, 0, b.position.z - hitC.point.z).dot(N);
        P.wallDist = dist;
        vel.addScaledVector(N, (P.r + 0.03 - dist) * 10);
      }
      v.set(vel.x, vel.y, vel.z);
      P.antiGrav = 1;
      if (!hitC && upI > 0) {
        // over the top: pull up onto the ledge
        const from = V(b.position.x - N.x * (P.r + 0.35), b.position.y + P.hsStand + 0.8 * ws, b.position.z - N.z * (P.r + 0.35));
        const top = ray(from, V(from.x, from.y - 2.5 * ws, from.z));
        if (top) {
          P.state = 'mantle';
          P.mantle = { t: 0, from: b.position.clone(), to: V(b.position.x - N.x * (P.r + 0.45), top.point.y + P.r + 0.03, b.position.z - N.z * (P.r + 0.45)) };
          b.collisionFilterMask = 0;
        } else P.state = 'air';
      } else if (!hitC) {
        P.state = 'air';
        P.climbCool = 0.4;
      } else if (hitC && !hitHead && upI > 0 && !hitC.body.userData.climb) {
        P.state = 'air';
      }
      if (P.state === 'climb') {
        if (P.jumpBuf > 0) {
          P.jumpBuf = 0;
          v.set(N.x * 4.5, P.jumpV * 0.9, N.z * 4.5);
          P.state = 'air';
          P.climbCool = 0.5;
          P.jumps = 1;
        } else if (upI < 0 && P.grounded) {
          P.state = 'ground';
          P.climbCool = 0.3;
        }
      }
    } else if (P.state === 'wallrun' || P.state === 'wallup') {
      // A wall run has a distance. It runs steady, then slows down while gravity comes back,
      // so you arc off the wall instead of stopping dead.
      const W = P.wall;
      const up = P.state === 'wallup';
      P.wallT += dt;
      const into = W.N.clone().negate();
      const chest = V(b.position.x, b.position.y + Math.max(P.hsCur * 0.5, 0.05), b.position.z);
      const hit = rayDir(chest, into, P.r + 1.15 * ws, WORLD);
      const t = clamp(W.dist / W.len, 0, 1);
      const ease = smooth(clamp((t - 0.55) / 0.45, 0, 1));
      W.speed = W.s0 * (1 - (up ? 0.92 : 0.7) * ease);
      let stick = V();
      if (hit) {
        const d = V(b.position.x - hit.point.x, 0, b.position.z - hit.point.z).dot(W.N);
        W.dWall = d;
        stick = into.clone().multiplyScalar(Math.max(0, d - (P.r + 0.02)) * 6);
      }
      W.phase += W.speed * dt * (up ? 2.6 : 2.4) / Math.max(0.5, P.char.H * 0.55);
      W.dist += W.speed * dt;
      P.antiGrav = 1 - ease;
      if (up) {
        P.yawTarget = Math.atan2(into.x, into.z);
        v.set(stick.x + into.x * 1.0, W.speed, stick.z + into.z * 1.0);
      } else {
        P.yawTarget = Math.atan2(W.tangent.x, W.tangent.z);
        const vy = t < 0.12 ? 2.4 * (1 - t / 0.12) : t < 0.55 ? 0.15 : v.y;
        v.set(W.tangent.x * W.speed + stick.x, vy, W.tangent.z * W.speed + stick.z);
      }
      if (P.jumpBuf > 0) {
        P.jumpBuf = 0;
        if (up) v.set(W.N.x * 6, P.jumpV * 0.95, W.N.z * 6);
        else v.set(W.N.x * 7 + W.tangent.x * W.speed * 0.8, P.jumpV * 1.05, W.N.z * 7 + W.tangent.z * W.speed * 0.8);
        P.state = 'air';
        P.wallCool = 0.4;
      } else if (t >= 1 || !hit || (P.grounded && P.wallT > 0.25)) {
        // out of run: peel off the wall in an arc (or grab on, if it is a climbing wall)
        if (up && hit && hit.body.userData && hit.body.userData.climb) {
          P.state = 'climb';
          P.climbN = W.N.clone();
          P.wallDist = P.r + 0.03;
        } else {
          v.x += W.N.x * (up ? 2.5 : 0.8);
          v.z += W.N.z * (up ? 2.5 : 0.8);
          P.state = P.grounded ? 'ground' : 'air';
        }
        P.wallCool = 0.5;
      }
    } else {
      // ---- ground and air movement
      const crouching = P.stance === 'crouch';
      const crawling = P.stance === 'crawl';
      const speed = crawling ? P.crawlSpeed : crouching ? P.crouchSpeed : running_ ? P.run : P.walk;
      let tx = mv.x * speed;
      let tz = mv.z * speed;
      if (!P.grounded) {
        // in the air you keep your speed (so a running jump stays a running jump)
        const hs = Math.hypot(v.x, v.z);
        if (mv.lengthSq() < 0.01) {
          tx = v.x;
          tz = v.z;
        } else {
          tx = mv.x * Math.max(speed, hs);
          tz = mv.z * Math.max(speed, hs);
        }
      }
      // step up stairs and curbs (a round collider would otherwise bump into the edge)
      if (P.grounded && mv.lengthSq() > 0.01) {
        const d = mv.clone().normalize();
        const feetY = b.position.y - P.r;
        const low = rayDir(V(b.position.x, feetY + 0.06 * ws, b.position.z), d, P.r + 0.14 * ws, WORLD);
        if (low && Math.abs(low.normal.y) < 0.5) {
          const stepMax = Math.min(0.32 * C.H, 0.6 * ws);
          const px = low.point.x + d.x * 0.08;
          const pz = low.point.z + d.z * 0.08;
          const top = ray(V(px, feetY + stepMax + 0.05, pz), V(px, feetY + 0.01, pz));
          if (top && top.normal.y > 0.7 && top.point.y > feetY + 0.02 && headroom(P.hsCur)) {
            b.position.y = top.point.y + P.r + 0.01;
            b.position.x += d.x * 0.05;
            b.position.z += d.z * 0.05;
            v.y = 0;
          }
        }
      }
      const accel = P.grounded ? 42 : P.char.canFly && key('Space') ? 9 : 7;
      const k = Math.min(1, accel * dt);
      v.x += (tx - v.x) * k;
      v.z += (tz - v.z) * k;
      if (held || gearActive()) P.yawTarget = camYaw;
      else if (mv.lengthSq() > 0.01) P.yawTarget = Math.atan2(mv.x, mv.z);
      // jump (double jump too)
      const canGroundJump = P.grounded || P.coyote > 0;
      if (P.jumpBuf > 0) {
        if (canGroundJump && P.stance !== 'crawl') {
          v.y = P.jumpV;
          P.jumps = 1;
          P.coyote = 0;
          P.grounded = false;
          P.jumpBuf = 0;
          P.state = 'air';
          if (C.canFly) P.flap = 0.3;
        } else if (!canGroundJump && P.jumps < 2 && P.stance === 'stand') {
          v.y = P.jumpV * 0.9;
          P.jumps++;
          P.jumpBuf = 0;
          P.state = 'air';
          if (C.canFly) P.flap = 0.3;
        }
      }
      // birds flap to climb the sky
      if (C.canFly && key('Space') && !P.grounded) {
        P.flap = 0.2;
        if (v.y < 5.5) v.y += 46 * dt;
        v.y = Math.max(v.y, -3);
      } else P.flap = Math.max(0, P.flap - dt);
      // bounce pads
      if (P.grounded && P.groundBody && P.groundBody.userData && P.groundBody.userData.bounce && P.bounceCool <= 0) {
        v.y = P.jumpV * (P.groundBody.userData.launch ? 3.1 : 2.1);
        P.bounceCool = 0.3;
        P.grounded = false;
        P.jumps = 1;
        toast('Boing! 🤸');
      }
      P.state = P.grounded ? 'ground' : 'air';
    }
    // face where we go
    P.yaw += angleDiff(P.yawTarget, P.yaw) * (1 - Math.exp(-(P.state === 'climb' ? 20 : 12) * dt));
    b.quaternion.setFromEuler(0, P.yaw, 0);
    b.angularVelocity.set(0, 0, 0);

    // ---- physics
    world.step(1 / 60, dt, 4);
    afterPhysics(dt);
    // a fell-off-the-world safety net
    if (b.position.y < -30) {
      b.position.set(0, P.r + 1, 0);
      b.velocity.set(0, 0, 0);
    }
    if (held && !P.char.visual) drop(true);

    animate(dt);
    updateCamera(dt);
    updateHud();
  }

  // ------------------------------------------------------------------ camera and HUD
  let camPos = V(0, 3, -5);
  function updateCamera(dt) {
    let p = P.char.visual.position;
    let H = P.char.H;
    let target = V(p.x, p.y + H * 0.8, p.z);
    let dist = clamp(H * 2.3 + 1.0, 2.0, 7) * camZoom;
    if (P.drive) {
      const v = P.drive.v;
      p = v.body.position;
      target = V(p.x, p.y + v.size.y * 0.7, p.z);
      dist = clamp(v.size.length() * 0.9 + 2.5, 4, 14) * camZoom;
      const fv = vehFwd(v);
      if (Math.hypot(v.body.velocity.x, v.body.velocity.z) > 1.5 && !key('ArrowLeft') && !key('ArrowRight')) camYaw += angleDiff(Math.atan2(fv.x, fv.z), camYaw) * (1 - Math.exp(-2.2 * dt));
    }
    const off = V(-Math.sin(camYaw) * Math.cos(camPitch), Math.sin(camPitch), -Math.cos(camYaw) * Math.cos(camPitch)).multiplyScalar(dist);
    const want = target.clone().add(off);
    // do not push the camera through walls
    const hit = ray(target, want);
    if (hit) want.copy(target).addScaledVector(want.clone().sub(target).normalize(), Math.max(0.5, hit.distance - 0.25));
    camPos.lerp(want, 1 - Math.exp(-18 * dt));
    if (P.ride !== 'walk' && P.rs && P.speedH > 1.5 && !key('ArrowLeft') && !key('ArrowRight') && P.state !== 'bail') camYaw += angleDiff(P.rs.heading, camYaw) * (1 - Math.exp(-1.6 * dt));
    camera.position.copy(camPos);
    camera.lookAt(target);
    sun.position.set(p.x + 20, 40, p.z + 14);
    sun.target.position.set(p.x, 0, p.z);
    sun.target.updateMatrixWorld();
  }
  const STATE_NAMES = { drive: 'Driving 🚗', grind: 'Grinding 🔩', bail: 'Bail! 😵', ground: 'On the ground', air: 'In the air', climb: 'Climbing 🧗', wallrun: 'Wall run 🏃', wallup: 'Wall run up 🧗‍♂️', mantle: 'Pulling up…' };
  function updateHud() {
    if (!hud || !P) return;
    const el = hud.querySelector('#playState');
    if (!el) return;
    let t = STATE_NAMES[P.state] || P.state;
    if (P.ride !== 'walk' && P.state === 'ground') t = P.speedH > 0.4 ? `${RIDES[P.ride].icon} Rolling` : `${RIDES[P.ride].icon} Ready`;
    else if (P.state === 'ground') t = P.stance === 'crawl' ? 'Crawling 🐛' : P.stance === 'crouch' ? 'Crouching' : P.speedH > P.walk * 1.3 ? 'Running 💨' : P.speedH > 0.4 ? 'Walking' : 'Standing';
    if (P.drive) {
      const bv = P.drive.v.body.velocity;
      t = `${P.drive.v.type === 'hover' ? '🛸 Hovering' : '🚗 Driving'} · ${Math.round(Math.hypot(bv.x, bv.y, bv.z) * 3.6)} km/h · E to get out`;
    } else if (P.ride === 'walk' && nearestVehicle(2.6 * clamp(ws, 0.7, 1.4))) t += ' · E to drive 🚗';
    if (P.rider) t += ' · riding 🐴';
    if (held) t += ' · holding something';
    updateRideHud();
    if (P.charge > 0 && held) t += ` · throw power ${'▮'.repeat(Math.min(8, Math.ceil((P.charge / 1.2) * 8)))}`;
    if (el.textContent !== t) el.textContent = t;
  }

  // ------------------------------------------------------------------ events
  const onKeyDown = (e) => {
    if (!running) return;
    if (/input|textarea/i.test(document.activeElement.tagName)) return;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    if (!keys.has(e.code)) pressedOnce.add(e.code);
    keys.add(e.code);
  };
  const onKeyUp = (e) => {
    keys.delete(e.code);
  };
  const onMouseMove = (e) => {
    if (!running) return;
    if (document.pointerLockElement === canvas || mouseDown) {
      camYaw -= e.movementX * 0.0032;
      camPitch = clamp(camPitch + e.movementY * 0.0028, -0.4, 1.2);
    }
  };
  const onMouseDown = (e) => {
    if (!running || e.target !== canvas) return;
    if (document.pointerLockElement !== canvas && e.button === 0 && !P.lockedOnce) {
      canvas.requestPointerLock && canvas.requestPointerLock();
      P.lockedOnce = true;
      return;
    }
    if (e.button === 0) {
      mouseDown = true;
      if (!held && !P.gear) tryPickUp();
    }
  };
  const onMouseUp = (e) => {
    if (e.button === 0) mouseDown = false;
  };
  const onWheel = (e) => {
    if (!running) return;
    camZoom = clamp(camZoom * (e.deltaY > 0 ? 1.1 : 0.9), 0.5, 2.2);
  };
  const onBlur = () => keys.clear();

  // ------------------------------------------------------------------ public
  function start(opts = {}) {
    if (running) return;
    running = true;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    camera = new THREE.PerspectiveCamera(62, 1, 0.05, 500);
    camYaw = 0;
    camPitch = 0.28;
    camZoom = 1;
    keys.clear();
    pressedOnce.clear();
    mouseDown = false;
    P = null;
    ws = 1;
    buildScene();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('blur', onBlur);
    setCharacter(opts.character || 'mine');
    registerMyUse();
    camPos.set(0, 3, -5);
    last = performance.now();
    resize();
  }
  function stop() {
    if (!running) return;
    running = false;
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('wheel', onWheel);
    window.removeEventListener('blur', onBlur);
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    renderer.shadowMap.enabled = false;
    scene.traverse((o) => {
      if (o.isMesh || o.isSprite) {
        // some meshes (the city buildings) have a list of materials
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m) (m.map && m.map.dispose(), m.dispose());
      }
    });
    ownGeos.splice(0).forEach((g) => g.dispose());
    scene = null;
    world = null;
    P = null;
    held = null;
    customGear = [];
    dyn = [];
    props = [];
    statics = [];
  }
  function resize() {
    if (!camera) return;
    const r = canvas.getBoundingClientRect();
    camera.aspect = r.width / Math.max(r.height, 1);
    camera.updateProjectionMatrix();
  }
  function frame() {
    if (!running) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    update(dt);
    renderer.render(scene, camera);
  }
  // for tests: step the simulation without rendering
  function tick(dt = 1 / 60, n = 1) {
    for (let i = 0; i < n; i++) update(dt);
  }
  return {
    start, stop, frame, resize, setCharacter, setRide, setGear, goZone, addDoc, registerMyUse, spawnVehicleNear, mount, dismount, tick,
    get running() { return running; },
    get character() { return charId; },
    debug: {
      get P() { return P; },
      get world() { return world; },
      keys, pressedOnce,
      get props() { return props; },
      get held() { return held; },
      get ws() { return ws; },
      get vehicles() { return vehicles; },
      enterVehicle,
      exitVehicle,
      spawnDart,
      get balloons() { return balloons; },
      get dummies() { return dummies; },
      get darts() { return darts; },
      get rails() { return rails; },
      get camYaw() { return camYaw; },
      set camYaw(v) { camYaw = v; },
      spawnMyModel, spawnBox,
      teleport(x, y, z) {
        P.body.position.set(x, y, z);
        P.body.velocity.set(0, 0, 0);
        snapFeet();
      },
      ray, V,
    },
  };
}
