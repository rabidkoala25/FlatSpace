// util.js — shared helpers: vectors, maths, formatting.
// Everything in the game lives on one global object, FS, so the files can be
// loaded with ordinary <script> tags (no build step needed).
window.FS = window.FS || {};

// Game version, shown in the hangar and the flight menu. Bump it with each roadmap step.
FS.VERSION = '0.2.0';

FS.G0 = 9.80665;          // standard gravity, used for specific impulse
FS.TAU = Math.PI * 2;

FS.vec = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  scale: (a, s) => ({ x: a.x * s, y: a.y * s }),
  dot: (a, b) => a.x * b.x + a.y * b.y,
  cross: (a, b) => a.x * b.y - a.y * b.x,
  len: (a) => Math.hypot(a.x, a.y),
  norm: (a) => { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; },
  fromAngle: (ang, len = 1) => ({ x: Math.cos(ang) * len, y: Math.sin(ang) * len }),
  angle: (a) => Math.atan2(a.y, a.x),
  // rotate a vector 90° counter-clockwise
  perp: (a) => ({ x: -a.y, y: a.x }),
};

FS.clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
FS.lerp = (a, b, t) => a + (b - a) * t;
FS.smoothstep = (a, b, x) => { const t = FS.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// wrap an angle into (-PI, PI]
FS.wrapAngle = (a) => {
  a = (a + Math.PI) % FS.TAU;
  if (a < 0) a += FS.TAU;
  return a - Math.PI;
};

FS.fmtDist = (m) => {
  const a = Math.abs(m);
  if (!isFinite(m)) return '∞';
  if (a < 10000) return m.toFixed(0) + ' m';
  if (a < 1e7) return (m / 1000).toFixed(a < 1e5 ? 2 : 1) + ' km';
  return (m / 1e6).toFixed(2) + ' Mm';
};

FS.fmtSpeed = (v) => (Math.abs(v) < 1000 ? v.toFixed(1) : v.toFixed(0)) + ' m/s';

// One Aster day is 6 hours (the planet's rotation period, rounded).
FS.fmtTime = (s, withDays = true) => {
  if (!isFinite(s)) return '—';
  const neg = s < 0;
  s = Math.abs(s);
  const d = Math.floor(s / 21600);
  s -= d * 21600;
  const h = Math.floor(s / 3600);
  const mi = Math.floor((s % 3600) / 60);
  const se = Math.floor(s % 60);
  const pad = (n) => String(n).padStart(2, '0');
  let out = (d > 0 && withDays ? d + 'd ' : '') + pad(h) + ':' + pad(mi) + ':' + pad(se);
  return (neg ? '-' : '') + out;
};

FS.fmtDuration = (s) => {
  if (!isFinite(s)) return '—';
  if (s < 60) return s.toFixed(1) + ' s';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.floor(s % 60) + 's';
  return FS.fmtTime(s);
};

// Deterministic hash → [0,1), used by terrain noise and starfields.
FS.hash = (i, seed) => {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(seed | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

// Small seeded random generator (mulberry32).
FS.rng = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

FS.store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  },
};
