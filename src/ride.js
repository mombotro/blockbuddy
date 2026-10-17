import * as THREE from 'three';

// Things you can ride in Play mode: skateboard, scooter, roller skates.

export const RIDE_ORDER = ['walk', 'skate', 'scooter', 'blades'];

export const RIDES = {
  skate: { label: 'Skateboard', icon: '🛹', maxPush: 8.2, pushAcc: 4.0, brake: 5.5, fric: 0.4, turn: 2.3, ollie: 1.05, sideways: true },
  scooter: { label: 'Scooter', icon: '🛴', maxPush: 7.8, pushAcc: 4.6, brake: 6.5, fric: 0.5, turn: 2.0, ollie: 1.05, sideways: false },
  blades: { label: 'Roller skates', icon: '🛼', maxPush: 10, pushAcc: 5.0, brake: 3.2, fric: 0.22, turn: 2.7, ollie: 1.05, sideways: false },
};

// J K L in the air. `hold` tricks last as long as you hold the key.
export const TRICKS = {
  skate: {
    KeyJ: { name: 'Kickflip', prop: 'boardRoll', amt: Math.PI * 2, dur: 0.42, pts: 120 },
    KeyK: { name: 'Heelflip', prop: 'boardRoll', amt: -Math.PI * 2, dur: 0.42, pts: 120 },
    KeyL: { name: 'Shove-it', prop: 'boardYaw', amt: Math.PI * 2, dur: 0.45, pts: 100 },
  },
  scooter: {
    KeyJ: { name: 'Barspin', prop: 'barSpin', amt: Math.PI * 2, dur: 0.35, pts: 100 },
    KeyK: { name: 'Tailwhip', prop: 'boardYaw', amt: Math.PI * 2, dur: 0.42, pts: 150 },
    KeyL: { name: 'Tabletop', prop: 'boardRoll', hold: 1.4, pts: 90 },
  },
  blades: {
    KeyJ: { name: 'Front flip', prop: 'bodyFlip', amt: Math.PI * 2, dur: 0.45, pts: 200 },
    KeyK: { name: 'Back flip', prop: 'bodyFlip', amt: -Math.PI * 2, dur: 0.45, pts: 200 },
    KeyL: { name: 'Spread eagle', prop: 'spread', hold: 1, pts: 90 },
  },
};

const M = (c, r = 0.6, m = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
function mesh(geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
const wheel = (r, w) => {
  const g = new THREE.CylinderGeometry(r, r, w, 12);
  g.rotateZ(Math.PI / 2);
  return g;
};

// origin = on the ground under the rider, +z = the way it rolls
export function buildVehicle(kind, { bs, len, wid, H }) {
  const root = new THREE.Group();
  const deck = new THREE.Group(); // spins, flips (tricks)
  const upper = new THREE.Group(); // scooter stem and bars
  root.add(deck, upper);
  const out = { root, deck, upper, bars: null, grips: null, deckY: 0.1 * bs, len, wid };
  const wmat = M(0xf1f5f9, 0.4);
  if (kind === 'skate') {
    const col = 0xef476f;
    deck.add(mesh(new THREE.BoxGeometry(wid, 0.03 * bs, len * 0.8), M(col), 0, out.deckY - 0.015 * bs, 0));
    deck.add(mesh(new THREE.BoxGeometry(wid * 0.96, 0.004 * bs, len * 0.8), M(0x1f2937, 0.95), 0, out.deckY + 0.001 * bs, 0));
    for (const z of [1, -1]) {
      const nose = mesh(new THREE.BoxGeometry(wid, 0.03 * bs, len * 0.14), M(col), 0, out.deckY + 0.004 * bs, z * len * 0.45);
      nose.rotation.x = -z * 0.35;
      deck.add(nose);
      deck.add(mesh(new THREE.BoxGeometry(wid * 0.96, 0.004 * bs, len * 0.14), M(0x1f2937, 0.95), 0, out.deckY + 0.02 * bs, z * len * 0.45).rotateX(-z * 0.35));
    }
    for (const sx of [1, -1]) for (const sz of [1, -1]) deck.add(mesh(wheel(0.04 * bs, 0.035 * bs), wmat, sx * wid * 0.42, 0.04 * bs, sz * len * 0.3));
  } else if (kind === 'scooter') {
    const L = len * 1.15;
    deck.add(mesh(new THREE.BoxGeometry(wid * 0.9, 0.03 * bs, L), M(0x118ab2), 0, out.deckY - 0.015 * bs, 0));
    deck.add(mesh(new THREE.BoxGeometry(wid * 0.85, 0.004 * bs, L), M(0x1f2937, 0.95), 0, out.deckY + 0.001 * bs, 0));
    deck.add(mesh(wheel(0.05 * bs, 0.03 * bs), wmat, 0, 0.05 * bs, -L * 0.45));
    // front wheel + stem + handlebars
    const front = L * 0.46;
    const stemH = THREE.MathUtils.clamp(0.55 * H, 0.35, 1.1);
    upper.add(mesh(wheel(0.05 * bs, 0.03 * bs), wmat, 0, 0.05 * bs, front));
    const stem = mesh(new THREE.CylinderGeometry(0.014 * bs, 0.014 * bs, stemH, 8), M(0xcbd5e1, 0.3, 0.6), 0, out.deckY + stemH / 2, front);
    upper.add(stem);
    const bars = new THREE.Group();
    bars.position.set(0, out.deckY + stemH, front);
    const bar = new THREE.CylinderGeometry(0.013 * bs, 0.013 * bs, 0.46 * bs, 8);
    bar.rotateZ(Math.PI / 2);
    bars.add(mesh(bar, M(0xcbd5e1, 0.3, 0.6)));
    const gl = new THREE.Object3D();
    const gr = new THREE.Object3D();
    gl.position.set(0.22 * bs, 0, 0);
    gr.position.set(-0.22 * bs, 0, 0);
    bars.add(gl, gr, mesh(new THREE.SphereGeometry(0.02 * bs, 8, 6), M(0x1f2937), 0.23 * bs, 0, 0), mesh(new THREE.SphereGeometry(0.02 * bs, 8, 6), M(0x1f2937), -0.23 * bs, 0, 0));
    upper.add(bars);
    out.bars = bars;
    out.grips = [gl, gr]; // left, right
  }
  return out;
}

// one roller skate; origin = where the wheels touch the ground
export function buildSkate(bs) {
  const g = new THREE.Group();
  const wr = 0.03 * bs;
  for (const z of [-0.07, -0.025, 0.025, 0.07]) g.add(mesh(wheel(wr, 0.03 * bs), M(0xffd166, 0.4), 0, wr, z * bs));
  g.add(mesh(new THREE.BoxGeometry(0.05 * bs, 0.014 * bs, 0.2 * bs), M(0x334155), 0, wr * 2 + 0.005 * bs, 0));
  g.add(mesh(new THREE.BoxGeometry(0.075 * bs, 0.07 * bs, 0.19 * bs), M(0xffffff, 0.5), 0, wr * 2 + 0.05 * bs, 0));
  return { group: g, wheelH: wr * 2 + 0.014 * bs };
}
