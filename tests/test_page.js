// Loads the real page in jsdom, launches a rocket, and checks for script errors.
// Needs jsdom: run "npm install" once in the project folder. Skipped if it's missing.
const fs = require('fs');
const path = require('path');
const { ROOT, check, done } = require('./lib');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) {
  console.log('  skip page test: jsdom is not installed (run "npm install")');
  process.exit(0);
}

// A canvas context that accepts every drawing call and does nothing.
function fakeContext() {
  const gradient = { addColorStop() {} };
  const target = {};
  return new Proxy(target, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === 'measureText') return () => ({ width: 0 });
      if (typeof p === 'string' && p.startsWith('create')) return () => gradient;
      if (typeof p === 'string' && /^[a-z]/.test(p)) return (t[p] = () => {});
      return undefined;
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
html = html.replace(/<script src="[^"]+"><\/script>/g, '').replace(/<link[^>]*>/g, '');

const errors = [];
const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  beforeParse(w) {
    w.HTMLCanvasElement.prototype.getContext = () => fakeContext();
    Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { get: () => 1280 });
    Object.defineProperty(w.HTMLElement.prototype, 'clientHeight', { get: () => 800 });
    w.addEventListener('error', (e) => errors.push(e.message));
  },
});
const w = dom.window;
w.console.error = (...a) => errors.push(a.join(' '));

for (const src of scripts) {
  try { w.eval(fs.readFileSync(path.join(ROOT, src), 'utf8')); }
  catch (e) { errors.push(src + ': ' + e.message); }
}
check(scripts.includes('data/parts.js') && scripts.includes('js/save.js'), 'index.html loads the data files and save.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (k) => {
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key: k }));
  w.dispatchEvent(new w.KeyboardEvent('keyup', { key: k }));
};

(async () => {
  await sleep(300);
  const FS = w.FS, G = FS.game;
  check(w.document.getElementById('version').textContent === 'v' + FS.VERSION, 'the hangar shows the version number');

  FS.Editor.launch();
  await sleep(200);
  check(G.scene === 'flight', 'launching opens the flight scene');
  const padAlt = G.vessel.altitude;
  key(' ');
  await sleep(2000);
  const climb = G.vessel.altitude - padAlt;
  check(G.vessel.thrustNow > 0 && climb > 1, `the rocket lifts off (climbed ${climb.toFixed(1)} m in 2 s)`);

  key('F3');
  await sleep(400);
  const overlay = w.document.getElementById('devOverlay');
  check(!overlay.hidden && /physics/.test(overlay.textContent), 'F3 shows the developer overlay');

  key('m');
  await sleep(300);
  check(G.mapMode, 'M opens the map');
  key('Escape');
  await sleep(100);
  check(!w.document.getElementById('dialog').hidden && /v\d/.test(w.document.getElementById('dlgBody').textContent), 'Esc opens the menu with the version number');

  check(errors.length === 0, 'no script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  done();
})();
