// tests/lib.js — loads the game's simulation code into Node, without a browser.
// Each test file runs in its own process (see run.js), so state never leaks between tests.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// The files that make up the simulation, in the same order as index.html.
// Drawing, HUD, editor and main loop are left out: they need a browser.
const SIM_FILES = [
  'js/util.js',
  'data/parts.js',
  'data/bodies.js',
  'js/save.js',
  'js/bodies.js',
  'js/orbit.js',
  'js/parts.js',
  'js/vessel.js',
];

// A localStorage stand-in that keeps values in memory.
function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
}

function loadGame() {
  global.window = global;
  global.localStorage = memoryStorage();
  for (const f of SIM_FILES) {
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
  }
  return global.FS;
}

// A game object with the callbacks a vessel expects, recording what happened.
function fakeGame() {
  const g = {
    events: [],
    debris: [],
    addDebris(d) { g.debris.push(d); },
    onExplode(v) { g.events.push({ type: 'explode', debris: v.isDebris }); },
    onTouchdown(v, water) { g.events.push({ type: 'touchdown', water }); },
    onSOIChange(v, from) { g.events.push({ type: 'soi', from: from.name, to: v.body.name }); },
  };
  return g;
}

let failures = 0;
function check(condition, message) {
  if (condition) console.log('  ok   ' + message);
  else { console.log('  FAIL ' + message); failures++; }
}
function near(actual, expected, tolerance, message) {
  check(Math.abs(actual - expected) <= tolerance, `${message} (got ${actual.toFixed(2)}, expected ${expected} ± ${tolerance})`);
}
function done() {
  process.exit(failures ? 1 : 0);
}

module.exports = { ROOT, SIM_FILES, loadGame, fakeGame, check, near, done };
