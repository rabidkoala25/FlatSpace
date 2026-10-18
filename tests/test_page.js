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
// Every local file carries ?v=<version> so browsers never mix cached old files with new ones.
const assetTags = [...html.matchAll(/(?:src|href)="((?:js|data|css)\/[^"]+)"/g)].map((m) => m[1]);
const tagged = assetTags.map((a) => (a.split('?v=')[1] || ''));
const versionInFile = (fs.readFileSync(path.join(ROOT, 'js/util.js'), 'utf8').match(/FS\.VERSION = '([^']+)'/) || [])[1];
html = html.replace(/<script src="[^"]+"><\/script>/g, '').replace(/<link[^>]*>/g, '');

const errors = [];
const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  beforeParse(w) {
    w.HTMLCanvasElement.prototype.getContext = () => fakeContext();
    w.Element.prototype.setPointerCapture = () => {}; // not in jsdom
    Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { get: () => 1280 });
    Object.defineProperty(w.HTMLElement.prototype, 'clientHeight', { get: () => 800 });
    w.addEventListener('error', (e) => errors.push(e.message));
  },
});
const w = dom.window;
w.console.error = (...a) => errors.push(a.join(' '));

for (const src of scripts) {
  try { w.eval(fs.readFileSync(path.join(ROOT, src.split('?')[0]), 'utf8')); }
  catch (e) { errors.push(src + ': ' + e.message); }
}
check(scripts.some((s) => s.startsWith('data/parts.js')) && scripts.some((s) => s.startsWith('js/save.js')), 'index.html loads the data files and save.js');
check(assetTags.length > 10 && tagged.every((v) => v === versionInFile), `every script and style link in index.html ends in ?v=${versionInFile} (bump them with FS.VERSION)`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (k) => {
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key: k }));
  w.dispatchEvent(new w.KeyboardEvent('keyup', { key: k }));
};

(async () => {
  await sleep(300);
  const FS = w.FS, G = FS.game;
  check(w.document.getElementById('version').textContent === 'v' + FS.VERSION, 'the hangar shows the version number');

  // ---- Building by dragging (step A2) ----
  const E = FS.Editor, doc = w.document;
  const cv = doc.getElementById('edCanvas');
  cv.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 });
  // The tray sits left of the build area (jsdom has no layout, so give it a box).
  doc.querySelector('#editor .palette').getBoundingClientRect = () => ({ left: -300, right: -10, top: 0, bottom: 800, width: 290, height: 800 });
  const fire = (el, type, o) => {
    const e = new w.Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 0, clientY: 0 }, o);
    el.dispatchEvent(e);
  };
  const trayButton = (id) => {
    [...doc.getElementById('palTabs').children].find((b) => b.textContent === FS.PART[id].cat).click();
    return doc.querySelector(`#palette [data-part="${id}"]`);
  };
  const dragFromTray = (id, to, pointerType = 'mouse') => {
    const b = trayButton(id);
    fire(b, 'pointerdown', { pointerId: 7, pointerType, clientX: -150, clientY: 120 });
    fire(b, 'pointermove', { pointerId: 7, pointerType, clientX: to.x, clientY: to.y });
    fire(b, 'pointerup', { pointerId: 7, pointerType, clientX: to.x, clientY: to.y });
  };
  const ids = () => E.parts.map((p) => p.def.id).join(',');
  const hopper = FS.SAMPLE_CRAFT.find((c) => c.name === 'Hopper').parts;
  const dvOf = (parts) => FS.stageStats(parts, FS.stagesOf(parts), 0, 0, 9.81).total;

  doc.getElementById('btnNew').click();
  check(E.parts.length === 0 && doc.getElementById('btnLaunch').disabled, 'New starts an empty craft');
  hopper.forEach((id, k) => {
    let to = { x: 640, y: 260 };
    if (E.parts.length) {
      const n = FS.Build.freeNodes(E.parts).filter((f) => f.node === 'bottom').sort((a, b) => a.pos.y - b.pos.y)[0];
      const c = E.toScreen({ x: n.pos.x, y: n.pos.y - FS.PART[id].len / 2 });
      to = { x: c.x + (k % 2 ? 9 : -7), y: c.y + 6 }; // a few pixels off, as a hand would be
    }
    dragFromTray(id, to);
  });
  check(ids() === hopper.join(','), `Hopper rebuilt by dragging from the tray (${ids()})`);
  const hopperDv = dvOf(FS.stackToParts(hopper));
  check(Math.abs(dvOf(E.parts) - hopperDv) < 0.5, `…with the sample's Δv (${dvOf(E.parts).toFixed(0)} m/s)`);
  check(/Hornet|Hop/.test(doc.getElementById('stageList').textContent), 'the stage list follows the new craft');

  // Touch: hold the engine, carry it to the tray, and let go: it is removed.
  const hornet = E.parts.find((p) => p.def.id === 'hornet');
  const hs = E.toScreen(hornet.pos);
  fire(cv, 'pointerdown', { pointerId: 21, pointerType: 'touch', clientX: hs.x, clientY: hs.y });
  await sleep(500);
  check(E.drag && E.drag.root === hornet, 'holding a finger on a part picks it up');
  fire(cv, 'pointermove', { pointerId: 21, pointerType: 'touch', clientX: -120, clientY: 300 });
  check(doc.querySelector('#editor .palette').classList.contains('drop-remove'), 'the tray lights up as a place to remove it');
  fire(cv, 'pointerup', { pointerId: 21, pointerType: 'touch', clientX: -120, clientY: 300 });
  check(!E.drag && !E.parts.includes(hornet) && E.parts.length === 4, 'dropping it on the tray removes it');

  // A mouse drag of the fins to empty space can't attach, so they spring back.
  const fins = E.parts.find((p) => p.def.id === 'fins');
  const fs0 = E.toScreen(fins.pos);
  fire(cv, 'pointerdown', { pointerId: 3, clientX: fs0.x, clientY: fs0.y });
  fire(cv, 'pointermove', { pointerId: 3, clientX: fs0.x + 300, clientY: fs0.y - 200 });
  check(E.drag && !E.drag.valid, 'a part dragged into empty space is shown as invalid');
  fire(cv, 'pointerup', { pointerId: 3, clientX: fs0.x + 300, clientY: fs0.y - 200 });
  check(E.parts.includes(fins) && fins.parent && fins.parent.def.id === 't100', 'an invalid drop puts a placed part back where it was');

  // Pinch to zoom the build area.
  const es0 = E.cam.s;
  fire(cv, 'pointerdown', { pointerId: 31, pointerType: 'touch', clientX: 500, clientY: 400 });
  fire(cv, 'pointerdown', { pointerId: 32, pointerType: 'touch', clientX: 600, clientY: 400 });
  fire(cv, 'pointermove', { pointerId: 32, pointerType: 'touch', clientX: 700, clientY: 400 });
  fire(cv, 'pointerup', { pointerId: 32, pointerType: 'touch', clientX: 700, clientY: 400 });
  fire(cv, 'pointerup', { pointerId: 31, pointerType: 'touch', clientX: 500, clientY: 400 });
  check(Math.abs(E.cam.s / es0 - 2) < 0.01 && !E.drag, `pinching zooms the build area (×${(E.cam.s / es0).toFixed(2)})`);

  // Tap the capsule and make it the root.
  const lark = E.parts.find((p) => p.def.id === 'lark');
  const ls = E.toScreen(lark.pos);
  fire(cv, 'pointerdown', { pointerId: 4, clientX: ls.x, clientY: ls.y });
  fire(cv, 'pointerup', { pointerId: 4, clientX: ls.x, clientY: ls.y });
  check(E.sel === lark, 'clicking a part selects it');
  doc.getElementById('btnRoot').click();
  check(E.parts[0] === lark && !lark.parent, 'Make root makes the capsule the root');

  // Tapping a tray part adds it at the lowest free spot: the engine goes back under the fins.
  E.sel = null;
  trayButton('hornet').click();
  check(E.parts[E.parts.length - 1].def.id === 'hornet' && E.parts[E.parts.length - 1].parent === fins, 'tapping a tray part attaches it below the craft');
  check(Math.abs(dvOf(E.parts) - hopperDv) < 0.5, 'the craft is a working Hopper again');

  // ---- Editor tools (step A3): build a craft with mirrored boosters, tilted fins and an offset, then undo it all ----
  const loadSample = (name) => { const sel = doc.getElementById('craftLoad'); sel.value = 'sample::' + name; sel.dispatchEvent(new w.Event('change')); };
  loadSample('Orbiter I');
  const start = JSON.stringify(FS.serialParts(E.parts)), h0 = E.hpos;
  const tanks = E.parts.filter((p) => p.def.id === 't800');
  const scr = (p, dx, dy) => E.toScreen({ x: p.pos.x + dx, y: p.pos.y + dy });
  key('x');
  check(E.mirror && doc.getElementById('btnMirror').getAttribute('aria-pressed') === 'true', 'X turns mirror symmetry on');
  dragFromTray('radec', scr(tanks[1], 0.8, 0.3));
  const radec = E.parts.find((p) => p.def.id === 'radec');
  dragFromTray('rumbler', scr(radec, 0.75, 0.1));
  check(E.parts.filter((p) => p.def.id === 'rumbler').length === 2 && E.parts.filter((p) => p.def.id === 'radec').length === 2, 'dragging one side decoupler and one booster gives a mirrored pair of each');
  // carry a swept fin, turn it with Q, drop it on the side of the upper tank
  const fb = trayButton('sweptfin');
  fire(fb, 'pointerdown', { pointerId: 8, clientX: -150, clientY: 100 });
  const ft = scr(tanks[0], 1.0, 0.1);
  fire(fb, 'pointermove', { pointerId: 8, clientX: ft.x, clientY: ft.y });
  key('q');
  check(E.drag && Math.abs(E.drag.root.spin - Math.PI / 12) < 1e-9, 'Q turns the carried part 15°');
  fire(fb, 'pointerup', { pointerId: 8, clientX: ft.x, clientY: ft.y });
  const fins2 = E.parts.filter((p) => p.def.id === 'sweptfin');
  check(fins2.length === 2 && Math.abs(Math.abs(fins2[0].rot) - Math.PI / 12) < 1e-9 && Math.abs(fins2[0].rot + fins2[1].rot) < 1e-9, 'the fin lands tilted 15°, with a twin tilted the mirror way');
  // Alt-drag the fin 1 m down its tank
  const fin = fins2[0], fy0 = FS.Build.surfaceHeight(fin);
  const fs1 = E.toScreen(fin.pos);
  fire(cv, 'pointerdown', { pointerId: 9, clientX: fs1.x, clientY: fs1.y, altKey: true });
  fire(cv, 'pointermove', { pointerId: 9, clientX: fs1.x, clientY: fs1.y + E.cam.s * 1.0, altKey: true });
  fire(cv, 'pointerup', { pointerId: 9, clientX: fs1.x, clientY: fs1.y + E.cam.s * 1.0, altKey: true });
  const fy1 = FS.Build.surfaceHeight(fin);
  check(Math.abs(fy1 - (fy0 - 1)) < 0.13 && Math.abs(FS.Build.surfaceHeight(FS.Build.twinOf(E.parts, fin)) - fy1) < 1e-9, `Alt-drag slides the fin down its tank, and its twin with it (${fy0.toFixed(2)} → ${fy1.toFixed(2)} m)`);
  check(E.parts.length === 17, `the craft now has 17 parts (${E.parts.length})`);
  const built = JSON.stringify(FS.serialParts(E.parts));
  let undos = 0;
  while (E.hpos > h0 && undos < 20) { w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'z', ctrlKey: true })); undos++; }
  check(JSON.stringify(FS.serialParts(E.parts)) === start, `Ctrl+Z reverses every step back to the original craft (${undos} undos)`);
  for (let k = 0; k < undos; k++) w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'y', ctrlKey: true }));
  check(JSON.stringify(FS.serialParts(E.parts)) === built, 'Ctrl+Y brings every step back');

  // Save a booster as a subassembly; it appears in the tray
  E.sel = E.parts.find((p) => p.def.id === 'radec');
  E.render();
  doc.getElementById('btnSub').click();
  check(E.subs.length === 1 && E.tab === 'Subassemblies' && doc.querySelector('#palette [data-sub="0"]'), `“Save sub” keeps the side decoupler and booster in the tray (${E.subs[0] && E.subs[0].name})`);
  // Alt-click copies a part; the copy follows the pointer and is dropped by the next click
  const collar = E.parts.find((p) => p.def.id === 'fins');
  const cs = E.toScreen(collar.pos);
  fire(cv, 'pointerdown', { pointerId: 10, clientX: cs.x, clientY: cs.y, altKey: true });
  fire(cv, 'pointerup', { pointerId: 10, clientX: cs.x, clientY: cs.y, altKey: true });
  check(E.drag && E.drag.pointerId === 'carry' && E.drag.held.length === 2, 'Alt-click picks up a copy of the fin collar and the engine below it');
  fire(cv, 'pointerdown', { pointerId: 11, clientX: 20, clientY: 20 });
  check(!E.drag && E.parts.length === 17, 'clicking empty space with the copy drops it back to the tray');
  // overlays
  doc.getElementById('ovl_cop').click();
  check(!E.overlays.cop, 'the Pressure switch hides the centre of pressure');
  doc.getElementById('ovl_cop').click();
  const od = E.overlayData(E.parts);
  check(od.cot && od.cop && Math.abs(od.miss) < 1e-4 && Math.abs(od.cot.dir.x) < 1e-9, `overlays: thrust on the centre line, centre of pressure ${od.cop.ahead.toFixed(2)} m from the centre of mass`);
  key('x');
  loadSample('Hopper');

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

  // Two-finger pinch on the map: fingers move from 100 px apart to 200 px apart.
  const view = w.document.getElementById('view');
  const pointer = (type, id, x) => {
    const e = new w.Event(type, { bubbles: true });
    Object.assign(e, { pointerId: id, clientX: x, clientY: 300 });
    view.dispatchEvent(e);
  };
  const s0 = G.mapCam.s;
  pointer('pointerdown', 1, 500); pointer('pointerdown', 2, 600);
  pointer('pointermove', 2, 700);
  pointer('pointerup', 2, 700); pointer('pointerup', 1, 500);
  const ratio = G.mapCam.s / s0;
  check(Math.abs(ratio - 2) < 0.01, `pinching zooms the map (scale ×${ratio.toFixed(2)})`);
  check(!G.node, 'lifting fingers after a pinch does not add a maneuver node');
  key('Escape');
  await sleep(100);
  check(!w.document.getElementById('dialog').hidden && /v\d/.test(w.document.getElementById('dlgBody').textContent), 'Esc opens the menu with the version number');

  check(errors.length === 0, 'no script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  done();
})();
