// util.js — shared helpers: vectors, maths, formatting.
// Everything in the game lives on one global object, FS, so the files can be
// loaded with ordinary <script> tags (no build step needed).
window.FS = window.FS || {};

// Game version, shown in the hangar and the flight menu. Bump it with each roadmap step.
FS.VERSION = '0.7.0';

FS.G0 = 9.80665; // standard gravity, used for specific impulse
FS.TAU = Math.PI * 2;

FS.vec = {
  add: (first, second) => ({ x: first.x + second.x, y: first.y + second.y }),
  sub: (first, second) => ({ x: first.x - second.x, y: first.y - second.y }),
  scale: (vector, factor) => ({ x: vector.x * factor, y: vector.y * factor }),
  dot: (first, second) => first.x * second.x + first.y * second.y,
  cross: (first, second) => first.x * second.y - first.y * second.x,
  len: (vector) => Math.hypot(vector.x, vector.y),
  norm: (vector) => {
    const length = Math.hypot(vector.x, vector.y) || 1;
    return { x: vector.x / length, y: vector.y / length };
  },
  fromAngle: (angle, length = 1) => ({ x: Math.cos(angle) * length, y: Math.sin(angle) * length }),
  angle: (vector) => Math.atan2(vector.y, vector.x),
  // rotate a vector 90° counter-clockwise
  perp: (vector) => ({ x: -vector.y, y: vector.x }),
};

FS.clamp = (value, low, high) => (value < low ? low : value > high ? high : value);
FS.lerp = (start, end, fraction) => start + (end - start) * fraction;
FS.smoothstep = (edge0, edge1, value) => {
  const fraction = FS.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return fraction * fraction * (3 - 2 * fraction);
};

// wrap an angle into (-PI, PI]
FS.wrapAngle = (angle) => {
  angle = (angle + Math.PI) % FS.TAU;
  if (angle < 0) {
    angle += FS.TAU;
  }
  return angle - Math.PI;
};

FS.fmtDist = (metres) => {
  const size = Math.abs(metres);
  if (!isFinite(metres)) {
    return '∞';
  }
  if (size < 10000) {
    return metres.toFixed(0) + ' m';
  }
  if (size < 1e7) {
    return (metres / 1000).toFixed(size < 1e5 ? 2 : 1) + ' km';
  }
  return (metres / 1e6).toFixed(2) + ' Mm';
};

FS.fmtSpeed = (speed) => (Math.abs(speed) < 1000 ? speed.toFixed(1) : speed.toFixed(0)) + ' m/s';

// One Aster day is 6 hours (the planet's rotation period, rounded).
FS.fmtTime = (seconds, withDays = true) => {
  if (!isFinite(seconds)) {
    return '—';
  }
  const negative = seconds < 0;
  seconds = Math.abs(seconds);
  const days = Math.floor(seconds / 21600);
  seconds -= days * 21600;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const twoDigits = (number) => String(number).padStart(2, '0');
  let out =
    (days > 0 && withDays ? days + 'd ' : '') +
    twoDigits(hours) +
    ':' +
    twoDigits(minutes) +
    ':' +
    twoDigits(secs);
  return (negative ? '-' : '') + out;
};

FS.fmtDuration = (seconds) => {
  if (!isFinite(seconds)) {
    return '—';
  }
  if (seconds < 60) {
    return seconds.toFixed(1) + ' s';
  }
  if (seconds < 3600) {
    return Math.floor(seconds / 60) + 'm ' + Math.floor(seconds % 60) + 's';
  }
  return FS.fmtTime(seconds);
};

// Deterministic hash → [0,1), used by terrain noise and starfields.
FS.hash = (index, seed) => {
  let hash = Math.imul(index | 0, 374761393) ^ Math.imul(seed | 0, 668265263);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
};

// Small seeded random generator (mulberry32).
FS.rng = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let state = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  state = (state + Math.imul(state ^ (state >>> 7), 61 | state)) ^ state;
  return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
};

FS.store = {
  get(key, fallback) {
    try {
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : fallback;
    } catch (error) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      return false;
    }
  },
};
