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
  url: 'http://localhost/', // so the page has browser storage, like the real site
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  beforeParse(w) {
    // no WebGL in jsdom: the page falls back to the Canvas 2D renderer (the WebGL one is
    // tested in a real browser by test_gl.js)
    w.HTMLCanvasElement.prototype.getContext = (type) => (/webgl/.test(type) ? null : fakeContext());
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

  // A mouse drag of the fins to empty space leaves them floating there; dragging them back reattaches them.
  const fins = E.parts.find((p) => p.def.id === 'fins');
  const fs0 = E.toScreen(fins.pos);
  fire(cv, 'pointerdown', { pointerId: 3, clientX: fs0.x, clientY: fs0.y });
  fire(cv, 'pointermove', { pointerId: 3, clientX: fs0.x + 300, clientY: fs0.y - 200 });
  check(E.drag && E.drag.valid && E.drag.loose, 'a part dragged into empty space can be left floating');
  fire(cv, 'pointerup', { pointerId: 3, clientX: fs0.x + 300, clientY: fs0.y - 200 });
  check(E.parts.includes(fins) && !fins.parent && fins.loose === 'drop' && !E.main().includes(fins), 'it floats, left out of the craft (left behind at launch by default)');
  const tankA = E.parts.find((p) => p.def.id === 't100');
  const back = E.toScreen({ x: tankA.pos.x, y: tankA.pos.y - tankA.len / 2 - fins.len / 2 });
  const fp1 = E.toScreen(fins.pos);
  fire(cv, 'pointerdown', { pointerId: 3, clientX: fp1.x, clientY: fp1.y });
  fire(cv, 'pointermove', { pointerId: 3, clientX: back.x + 4, clientY: back.y + 3 });
  fire(cv, 'pointerup', { pointerId: 3, clientX: back.x + 4, clientY: back.y + 3 });
  check(fins.parent === tankA && !fins.loose && E.main().includes(fins), 'dragging the floating part back attaches it again');

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
  check(!E.drag && E.parts.length === 19 && E.main().length === 17, 'clicking empty space with the copy leaves it floating there');
  E.remove(E.parts[E.parts.length - 2]);
  check(E.parts.length === 17, 'and the floating copy can be removed');
  // overlays
  doc.getElementById('ovl_cop').click();
  check(!E.overlays.cop, 'the Pressure switch hides the centre of pressure');
  doc.getElementById('ovl_cop').click();
  const od = E.overlayData(E.main());
  check(od.cot && od.cop && Math.abs(od.miss) < 1e-4 && Math.abs(od.cot.dir.x) < 1e-9, `overlays: thrust on the centre line, centre of pressure ${od.cop.ahead.toFixed(2)} m from the centre of mass`);
  key('x');

  // ---- Step A4: stretch a tank to 9 m, give it a look, custom staging, save, export, import ----
  loadSample('Orbiter I');
  const tank = E.parts.filter((p) => p.def.id === 't800')[1];
  const tc = E.toScreen(tank.pos);
  const ctxEv = new w.Event('contextmenu', { bubbles: true, cancelable: true });
  Object.assign(ctxEv, { clientX: tc.x, clientY: tc.y });
  cv.dispatchEvent(ctxEv);
  check(E.sel === tank && !doc.querySelector('#editor .part-panel').hidden && /Length/.test(doc.querySelector('#editor .part-panel').textContent), 'right-clicking a tank opens its settings');
  // drag its stretch handle (at the free bottom end) down by 5 m
  const hp = E.toScreen({ x: tank.pos.x, y: tank.pos.y - tank.len / 2 - 10 / E.cam.s });
  fire(cv, 'pointerdown', { pointerId: 40, clientX: hp.x, clientY: hp.y });
  fire(cv, 'pointermove', { pointerId: 40, clientX: hp.x, clientY: hp.y + E.cam.s * 5 });
  fire(cv, 'pointerup', { pointerId: 40, clientX: hp.x, clientY: hp.y + E.cam.s * 5 });
  check(tank.len === 9 && tank.cap === 9000, `dragging the stretch handle makes a 9 m tank with 9 t of fuel (${tank.len} m)`);
  [...doc.querySelectorAll('#editor .part-panel .pp-choice')].find((b) => /Gold foil/.test(b.textContent)).click();
  check(tank.skin === 'gold', 'the Look buttons change the tank to gold foil');
  // custom staging: give the Wren its own stage, with the keyboard on its chip
  const wrenChip = [...doc.querySelectorAll('#stageList .stg-chip')].find((c) => /Wren/.test(c.textContent));
  wrenChip.dispatchEvent(new w.KeyboardEvent('keydown', { key: ']', bubbles: true }));
  const order = () => FS.stagesOf(E.parts).map((e) => e.parts.map((p) => p.def.id).sort().join('+')).join(' | ');
  check(order() === 'kestrel | decoupler | decoupler+wren | canopy' && doc.getElementById('stageMode').textContent === 'Custom', `] on a stage chip moves it a stage later (${order()})`);
  const configured = JSON.stringify(FS.serialParts(E.parts));
  // save, load something else, load it back
  doc.getElementById('craftName').value = 'Long Gold';
  doc.getElementById('craftName').dispatchEvent(new w.Event('input'));
  doc.getElementById('btnSave').click();
  loadSample('Hopper');
  const sel = doc.getElementById('craftLoad');
  sel.value = 'saved::Long Gold';
  sel.dispatchEvent(new w.Event('change'));
  check(JSON.stringify(FS.serialParts(E.parts)) === configured, 'the saved craft reloads with its 9 m gold tank and custom staging');
  // export as text, load another craft, paste the text back in
  doc.getElementById('btnFiles').click();
  check(!doc.getElementById('craftFiles').hidden, 'Files opens the craft file dialog');
  doc.getElementById('cfCopy').click();
  const shared = doc.getElementById('cfText').value;
  check(/^FLATSPACE-CRAFT-1:/.test(shared), 'Copy as text gives the share text');
  loadSample('Hopper');
  doc.getElementById('cfText').value = shared;
  doc.getElementById('cfPaste').click();
  check(E.name === 'Long Gold' && JSON.stringify(FS.serialParts(E.parts)) === configured, 'pasting the text back loads the same craft');
  const fv = new FS.Vessel('Long Gold', FS.serialParts(E.parts), FS.root, {});
  check(fv.parts.some((p) => p.len === 9 && p.skin === 'gold') && fv.stages.length === 4 && fv.stages[2].engines[0].def.id === 'wren', 'and it goes to the pad as configured');
  doc.getElementById('cfClose').click();
  FS.PartPanel.closeAll('editor');

  // Pop-ups: selecting a part opens one with a pointer line; selecting another replaces it
  // unless it is pinned; the title bar drags it.
  loadSample('Orbiter I');
  const popups = () => [...doc.querySelectorAll('#editor .part-panel')];
  const tapPart = (p, id) => {
    const s = E.toScreen(p.pos);
    fire(cv, 'pointerdown', { pointerId: id, clientX: s.x, clientY: s.y });
    fire(cv, 'pointerup', { pointerId: id, clientX: s.x, clientY: s.y });
  };
  const eng = E.parts.find((p) => p.def.id === 'kestrel');
  const capsule = E.parts.find((p) => p.def.id === 'canopy');
  tapPart(eng, 50);
  E.render();
  check(E.sel === eng && popups().length === 1 && /Thrust limit/.test(popups()[0].textContent), 'clicking a part opens its pop-up');
  check(doc.querySelector('#editor .pp-lines line') && doc.querySelector('#editor .pp-lines circle'), 'the pop-up has a pointer line to its part');
  tapPart(capsule, 51);
  check(popups().length === 1 && FS.PartPanel.panels('editor')[0].part === capsule, 'selecting another part swaps the unpinned pop-up for its own');
  const pinBtn = popups()[0].querySelector('.pp-pin');
  pinBtn.click();
  check(pinBtn.getAttribute('aria-pressed') === 'true' && popups()[0].classList.contains('pinned'), 'the pin button pins it');
  tapPart(eng, 52);
  check(popups().length === 2, 'a pinned pop-up stays open when another part is selected');
  const pinned = FS.PartPanel.panels('editor').find((pn) => pn.part === capsule);
  const off0 = { ...pinned.off };
  const head = pinned.el.querySelector('.pp-head');
  fire(head, 'pointerdown', { pointerId: 53, button: 0, clientX: 10, clientY: 10 });
  fire(head, 'pointermove', { pointerId: 53, clientX: 50, clientY: 70 });
  fire(head, 'pointerup', { pointerId: 53, clientX: 50, clientY: 70 });
  check(pinned.off.x === off0.x + 40 && pinned.off.y === off0.y + 60, 'the pop-up can be dragged by its title bar');
  pinned.el.querySelector('.pp-close').click();
  check(popups().length === 1, 'the × closes it');
  FS.PartPanel.closeAll('editor');

  // A floating part set to launch with the craft goes along, where it was placed.
  loadSample('Hopper');
  const loose = E.parts.find((p) => p.def.id === 'hornet');
  const lp0 = E.toScreen(loose.pos);
  fire(cv, 'pointerdown', { pointerId: 54, clientX: lp0.x, clientY: lp0.y });
  fire(cv, 'pointermove', { pointerId: 54, clientX: lp0.x + 250, clientY: lp0.y });
  fire(cv, 'pointerup', { pointerId: 54, clientX: lp0.x + 250, clientY: lp0.y });
  check(loose.loose === 'drop', 'the engine floats beside the Hopper');
  FS.PartPanel.select(loose, 'editor');
  [...popups()[0].querySelectorAll('.pp-choice')].find((b) => /Launch with/.test(b.textContent)).click();
  check(loose.loose === 'keep', 'its pop-up sets it to launch with the craft');
  FS.Editor.launch();
  await sleep(200);
  const extra = G.debris.find((d) => d.parts.some((p) => p.def.id === 'hornet'));
  check(G.scene === 'flight' && extra && !G.vessel.parts.some((p) => p.def.id === 'hornet'), 'it launches as a separate object next to the craft');
  const gap = extra && FS.vec.len(FS.vec.sub(extra.r, G.vessel.r));
  check(extra && gap > 3 && gap < 40, `placed where it floated in the hangar (${gap && gap.toFixed(1)} m away)`);
  G.showScene('editor');
  await sleep(100);

  loadSample('Hopper');

  FS.Editor.launch();
  await sleep(200);
  check(G.scene === 'flight', 'launching opens the flight scene');
  const padAlt = G.vessel.altitude;
  key(' ');
  await sleep(2000);
  const climb = G.vessel.altitude - padAlt;
  check(G.vessel.thrustNow > 0 && climb > 1, `the rocket lifts off (climbed ${climb.toFixed(1)} m in 2 s)`);

  // Tapping a part in flight opens its pop-up, and its settings still work.
  const fview = doc.getElementById('view');
  const hornetF = G.vessel.parts.find((p) => p.def.id === 'hornet');
  const hsF = FS.Renderer.partToScreen(G.cam, G.vessel, G.t, hornetF.c);
  fire(fview, 'pointerdown', { pointerId: 60, clientX: hsF.x, clientY: hsF.y });
  fire(fview, 'pointerup', { pointerId: 60, clientX: hsF.x, clientY: hsF.y });
  const fpop = doc.querySelector('#flight .part-panel');
  check(fpop && FS.PartPanel.panels('flight')[0].part === hornetF, 'tapping a part in flight opens its pop-up');
  const lim = fpop && fpop.querySelector('input[type=range]');
  if (lim) { lim.value = 50; lim.dispatchEvent(new w.Event('input', { bubbles: true })); lim.dispatchEvent(new w.Event('change', { bubbles: true })); }
  check(hornetF.limit === 0.5, `its thrust limit can be changed mid-flight (${hornetF.limit})`);
  FS.PartPanel.closeAll('flight');

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

  check(FS.Renderer === FS.Render && doc.querySelector('.gl-notice') && /WebGL2/.test(doc.querySelector('.gl-notice').textContent), 'without WebGL2 the game uses the Canvas 2D renderer and says so');
  check(errors.length === 0, 'no script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  done();
})();
