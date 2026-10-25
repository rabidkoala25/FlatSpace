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
  'js/partgraph.js',
  'js/build.js',
  'js/vessel.js',
  'js/sim.js',
  'js/warp.js',
  'js/nodes.js',
];

// A localStorage stand-in that keeps values in memory.
function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
  };
}

function loadGame() {
  global.window = global;
  global.localStorage = memoryStorage();
  for (const fileName of SIM_FILES) {
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, fileName), 'utf8'), { filename: fileName });
  }
  return global.FS;
}

// A stand-in for FS.game for tests that drive vessels directly: it records the events
// vessels emit and collects dropped stages as debris, like sim.js does.
function fakeGame() {
  const game = {
    events: [],
    debris: [],
    emit(type, data) {
      game.events.push({
        type,
        to: data.vessel && data.vessel.body && data.vessel.body.name,
        from: data.from && data.from.name,
        water: data.water,
        debris: data.vessel && data.vessel.isDebris,
      });
      if (type === 'staged' || type === 'part-action') {
        game.debris.push(...data.dropped);
      }
    },
  };
  return game;
}

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log('  ok   ' + message);
  } else {
    console.log('  FAIL ' + message);
    failures++;
  }
}
function near(actual, expected, tolerance, message) {
  check(
    Math.abs(actual - expected) <= tolerance,
    `${message} (got ${actual.toFixed(2)}, expected ${expected} ± ${tolerance})`,
  );
}
function done() {
  process.exit(failures ? 1 : 0);
}

module.exports = { ROOT, SIM_FILES, loadGame, fakeGame, check, near, done };
