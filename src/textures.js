import * as THREE from 'three';

const S = 128;

function rng(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// draw fn at 9 offsets so shapes wrap around the tile edges (seamless)
const wrap = (fn) => {
  for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) fn(dx, dy);
};

// Patterns are light greys on white. The part color multiplies them, so any
// color gives a light/dark two tone version of the pattern.
const PATTERNS = {
  stripes: (c) => {
    c.fillStyle = '#fff';
    c.fillRect(0, 0, S, S);
    c.fillStyle = '#b4b4b4';
    for (let i = 0; i < 4; i++) c.fillRect(0, i * 32 + 8, S, 16);
  },
  dots: (c) => {
    c.fillStyle = '#fff';
    c.fillRect(0, 0, S, S);
    c.fillStyle = '#a8a8a8';
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        c.beginPath();
        c.arc(x * 32 + 16 + (y % 2) * 16, y * 32 + 16, 9, 0, 7);
        c.fill();
      }
  },
  checker: (c) => {
    c.fillStyle = '#fff';
    c.fillRect(0, 0, S, S);
    c.fillStyle = '#b4b4b4';
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if ((x + y) % 2) c.fillRect(x * 32, y * 32, 32, 32);
  },
  bricks: (c) => {
    c.fillStyle = '#f2f2f2';
    c.fillRect(0, 0, S, S);
    c.fillStyle = '#b0b0b0';
    for (let r = 0; r < 4; r++)
      for (let b = -1; b < 3; b++) c.fillRect(b * 64 + (r % 2) * 32 + 3, r * 32 + 3, 58, 26);
  },
  planks: (c) => {
    const r = rng(7);
    c.fillStyle = '#e6e6e6';
    c.fillRect(0, 0, S, S);
    for (let i = 0; i < 4; i++) {
      c.fillStyle = i % 2 ? '#d2d2d2' : '#dedede';
      c.fillRect(0, i * 32, S, 32);
      c.fillStyle = '#9a9a9a';
      c.fillRect(0, i * 32, S, 3);
      c.strokeStyle = '#c0c0c0';
      c.lineWidth = 1.5;
      for (let k = 0; k < 3; k++) {
        const y = i * 32 + 8 + r() * 18;
        c.beginPath();
        c.moveTo(0, y);
        c.lineTo(S, y + (r() - 0.5) * 3);
        c.stroke();
      }
    }
  },
  grass: (c) => {
    const r = rng(3);
    c.fillStyle = '#f0f0f0';
    c.fillRect(0, 0, S, S);
    c.strokeStyle = '#9c9c9c';
    c.lineWidth = 2;
    for (let i = 0; i < 70; i++) {
      const x = r() * S;
      const y = r() * S;
      wrap((dx, dy) => {
        c.beginPath();
        c.moveTo(x + dx, y + dy);
        c.lineTo(x + dx + (r() - 0.5) * 6, y + dy - 8 - r() * 8);
        c.stroke();
      });
    }
  },
  stone: (c) => {
    const r = rng(11);
    c.fillStyle = '#c8c8c8';
    c.fillRect(0, 0, S, S);
    for (let i = 0; i < 14; i++) {
      const x = r() * S;
      const y = r() * S;
      const rad = 14 + r() * 10;
      const shade = 215 + Math.floor(r() * 40);
      wrap((dx, dy) => {
        c.fillStyle = `rgb(${shade},${shade},${shade})`;
        c.beginPath();
        c.ellipse(x + dx, y + dy, rad, rad * 0.8, 0, 0, 7);
        c.fill();
      });
    }
  },
  scales: (c) => {
    c.fillStyle = '#f4f4f4';
    c.fillRect(0, 0, S, S);
    c.strokeStyle = '#9a9a9a';
    c.lineWidth = 3;
    for (let y = 0; y <= 8; y++)
      for (let x = -1; x < 5; x++) {
        c.beginPath();
        c.arc(x * 32 + (y % 2) * 16 + 16, y * 16, 16, 0, Math.PI);
        c.stroke();
      }
  },
  spots: (c) => {
    const r = rng(5);
    c.fillStyle = '#fff';
    c.fillRect(0, 0, S, S);
    c.fillStyle = '#6e6e6e';
    for (let i = 0; i < 6; i++) {
      const x = r() * S;
      const y = r() * S;
      const rx = 9 + r() * 14;
      const ry = 8 + r() * 12;
      wrap((dx, dy) => {
        c.beginPath();
        c.ellipse(x + dx, y + dy, rx, ry, r() * 3, 0, 7);
        c.fill();
      });
    }
  },
  zigzag: (c) => {
    c.fillStyle = '#fff';
    c.fillRect(0, 0, S, S);
    c.strokeStyle = '#a0a0a0';
    c.lineWidth = 7;
    c.lineJoin = 'miter';
    for (let row = 0; row < 4; row++) {
      c.beginPath();
      for (let x = 0; x <= S; x += 16) c.lineTo(x, row * 32 + 8 + ((x / 16) % 2 ? 16 : 0));
      c.stroke();
    }
  },
  fuzz: (c) => {
    const r = rng(9);
    c.fillStyle = '#ececec';
    c.fillRect(0, 0, S, S);
    for (let i = 0; i < 700; i++) {
      const v = 190 + Math.floor(r() * 65);
      c.fillStyle = `rgb(${v},${v},${v})`;
      const x = r() * S;
      const y = r() * S;
      wrap((dx, dy) => c.fillRect(x + dx, y + dy, 3, 3));
    }
  },
};

export const PATTERN_LIST = [
  ['none', 'Plain'],
  ['stripes', 'Stripes'],
  ['dots', 'Dots'],
  ['checker', 'Checks'],
  ['bricks', 'Bricks'],
  ['planks', 'Wood'],
  ['grass', 'Grass'],
  ['stone', 'Stone'],
  ['scales', 'Scales'],
  ['spots', 'Spots'],
  ['zigzag', 'Zigzag'],
  ['fuzz', 'Fuzzy'],
];

const canvasCache = new Map();
export function patternCanvas(name) {
  if (canvasCache.has(name)) return canvasCache.get(name);
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const c = cv.getContext('2d');
  if (PATTERNS[name]) PATTERNS[name](c);
  else {
    c.fillStyle = '#fff';
    c.fillRect(0, 0, S, S);
  }
  canvasCache.set(name, cv);
  return cv;
}

const texCache = new Map();
function setupTex(t) {
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
function patternTexture(name) {
  if (!texCache.has(name)) texCache.set(name, setupTex(new THREE.CanvasTexture(patternCanvas(name))));
  return texCache.get(name);
}
function imageTexture(url) {
  const key = 'img:' + url;
  if (!texCache.has(key)) {
    const t = new THREE.TextureLoader().load(url, (tex) => {
      tex.needsUpdate = true;
    });
    texCache.set(key, setupTex(t));
  }
  return texCache.get(key);
}

export function makeMaterial({ color = '#ffffff', pattern = 'none', image = null }) {
  const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.9, metalness: 0 });
  if (image) m.map = imageTexture(image);
  else if (pattern && pattern !== 'none') m.map = patternTexture(pattern);
  return m;
}

export function patternThumb(name) {
  return patternCanvas(name).toDataURL();
}
