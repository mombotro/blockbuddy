import * as THREE from 'three';

// Foam swords and foam dart guns for Play mode. All soft, all silly.

export const GEAR_ORDER = ['none', 'sword', 'bigsword', 'pistol', 'blaster', 'mega'];

export const GEAR = {
  sword: { label: 'Foam sword', icon: '🗡️', kind: 'melee', reach: 1.9, swing: 0.32, cool: 0.1, push: 7 },
  bigsword: { label: 'Giant foam sword', icon: '⚔️', kind: 'melee', reach: 2.9, swing: 0.5, cool: 0.2, push: 14 },
  pistol: { label: 'Dart pistol', icon: '🔫', kind: 'gun', rate: 0.26, speed: 40, mag: 12, spread: 0.008, auto: false, pellets: 1 },
  blaster: { label: 'Foam blaster', icon: '💥', kind: 'gun', rate: 0.1, speed: 36, mag: 24, spread: 0.035, auto: true, pellets: 1 },
  mega: { label: 'Mega shooter', icon: '🎯', kind: 'gun', rate: 0.75, speed: 32, mag: 6, spread: 0.08, auto: false, pellets: 5 },
};

const M = (c, r = 0.7) => new THREE.MeshStandardMaterial({ color: c, roughness: r });
function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}
function cyl(r, l, mat, x = 0, y = 0, z = 0) {
  const g = new THREE.CylinderGeometry(r, r, l, 10);
  g.rotateX(Math.PI / 2); // along z
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

// origin is the grip; the blade or barrel points along +z
export function buildGear(kind, bs) {
  const g = new THREE.Group();
  const out = { group: g, muzzle: null };
  if (kind === 'sword' || kind === 'bigsword') {
    const big = kind === 'bigsword';
    const L = (big ? 1.25 : 0.75) * bs;
    const W = (big ? 0.11 : 0.06) * bs;
    const foam = M(big ? 0xa855f7 : 0x38bdf8, 0.9);
    g.add(cyl(0.018 * bs, 0.17 * bs, M(0x334155), 0, 0, 0.0));
    g.add(box(0.17 * bs, 0.03 * bs, 0.03 * bs, M(0xfacc15), 0, 0, 0.09 * bs));
    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.025 * bs, 8, 6), M(0xfacc15)).translateZ(-0.09 * bs));
    g.add(box(W, W * 0.55, L, foam, 0, 0, 0.1 * bs + L / 2));
    const tip = new THREE.Mesh(new THREE.SphereGeometry(W * 0.5, 8, 6), foam);
    tip.scale.set(1, 0.55, 1);
    tip.position.set(0, 0, 0.1 * bs + L);
    g.add(tip);
    g.add(box(W * 0.3, W * 0.6, L * 0.96, M(0xffffff, 0.9), 0, 0, 0.1 * bs + L / 2));
    return out;
  }
  const spec = {
    pistol: { body: 0xf97316, trim: 0x1f2937, len: 0.22, barrel: 0.12, w: 0.05, mag: 0 },
    blaster: { body: 0x38bdf8, trim: 0xf1f5f9, len: 0.34, barrel: 0.16, w: 0.065, mag: 1 },
    mega: { body: 0x22c55e, trim: 0xfacc15, len: 0.42, barrel: 0.2, w: 0.1, mag: 0 },
  }[kind];
  g.add(box(spec.w * bs, 0.075 * bs, spec.len * bs, M(spec.body, 0.5), 0, 0, spec.len * bs * 0.3));
  g.add(box(spec.w * 0.8 * bs, 0.03 * bs, spec.len * 0.8 * bs, M(spec.trim, 0.5), 0, 0.045 * bs, spec.len * bs * 0.32));
  const bw = kind === 'mega' ? 0.045 : 0.026;
  g.add(cyl(bw * bs, spec.barrel * bs, M(spec.trim, 0.4), 0, 0.005 * bs, spec.len * bs * 0.8 + spec.barrel * bs * 0.4));
  g.add(box(0.04 * bs, 0.1 * bs, 0.05 * bs, M(0x374151), 0, -0.08 * bs, -0.01 * bs));
  if (spec.mag) g.add(box(0.045 * bs, 0.12 * bs, 0.06 * bs, M(0xfacc15, 0.5), 0, -0.1 * bs, spec.len * bs * 0.45));
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.005 * bs, spec.len * bs * 0.8 + spec.barrel * bs * 0.95);
  g.add(muzzle);
  out.muzzle = muzzle;
  return out;
}

// a foam dart: orange body, yellow suction cup at the front. +z is forward.
export function buildDart(s) {
  const g = new THREE.Group();
  const body = cyl(0.014 * s, 0.075 * s, M(0xf97316, 0.8));
  const cup = new THREE.Mesh(new THREE.SphereGeometry(0.02 * s, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), M(0xfacc15, 0.5));
  cup.rotation.x = Math.PI / 2;
  cup.position.z = 0.04 * s;
  const tail = cyl(0.016 * s, 0.02 * s, M(0xffffff), 0, 0, -0.04 * s);
  g.add(body, cup, tail);
  return g;
}
