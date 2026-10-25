// Loads the real page in jsdom, launches a rocket, and checks for script errors.
// Needs jsdom: run "npm install" once in the project folder. Skipped if it's missing.
const fs = require('fs');
const path = require('path');
const { ROOT, check, done } = require('./lib');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (error) {
  console.log('  skip page test: jsdom is not installed (run "npm install")');
  process.exit(0);
}

// A canvas context that accepts every drawing call and does nothing.
function fakeContext() {
  const gradient = { addColorStop() {} };
  const target = {};
  return new Proxy(target, {
    get(target, property) {
      if (property in target) {
        return target[property];
      }
      if (property === 'measureText') {
        return () => ({ width: 0 });
      }
      if (typeof property === 'string' && property.startsWith('create')) {
        return () => gradient;
      }
      if (typeof property === 'string' && /^[a-z]/.test(property)) {
        return (target[property] = () => {});
      }
      return undefined;
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    },
  });
}

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1]);
// Every local file carries ?v=<version> so browsers never mix cached old files with new ones.
const assetTags = [...html.matchAll(/(?:src|href)="((?:js|data|css)\/[^"]+)"/g)].map((match) => match[1]);
const tagged = assetTags.map((tag) => tag.split('?v=')[1] || '');
const versionInFile = (fs
  .readFileSync(path.join(ROOT, 'js/util.js'), 'utf8')
  .match(/FS\.VERSION = '([^']+)'/) || [])[1];
html = html.replace(/<script src="[^"]+"><\/script>/g, '').replace(/<link[^>]*>/g, '');

const errors = [];
const pageDom = new JSDOM(html, {
  url: 'http://localhost/', // so the page has browser storage, like the real site
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  beforeParse(pageWindow) {
    // no WebGL in jsdom: the page falls back to the Canvas 2D renderer (the WebGL one is
    // tested in a real browser by test_gl.js)
    pageWindow.HTMLCanvasElement.prototype.getContext = (type) => (/webgl/.test(type) ? null : fakeContext());
    pageWindow.Element.prototype.setPointerCapture = () => {}; // not in jsdom
    Object.defineProperty(pageWindow.HTMLElement.prototype, 'clientWidth', { get: () => 1280 });
    Object.defineProperty(pageWindow.HTMLElement.prototype, 'clientHeight', { get: () => 800 });
    pageWindow.addEventListener('error', (event) => errors.push(event.message));
  },
});
const pageWindow = pageDom.window;
pageWindow.console.error = (...parts) => errors.push(parts.join(' '));

for (const src of scripts) {
  try {
    pageWindow.eval(fs.readFileSync(path.join(ROOT, src.split('?')[0]), 'utf8'));
  } catch (error) {
    errors.push(src + ': ' + error.message);
  }
}
check(
  scripts.some((source) => source.startsWith('data/parts.js')) &&
    scripts.some((source) => source.startsWith('js/save.js')),
  'index.html loads the data files and save.js',
);
check(
  assetTags.length > 10 && tagged.every((version) => version === versionInFile),
  `every script and style link in index.html ends in ?v=${versionInFile} (bump them with FS.VERSION)`,
);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const key = (keyName) => {
  pageWindow.dispatchEvent(new pageWindow.KeyboardEvent('keydown', { key: keyName }));
  pageWindow.dispatchEvent(new pageWindow.KeyboardEvent('keyup', { key: keyName }));
};

(async () => {
  await sleep(300);
  const FS = pageWindow.FS;
  const game = FS.game;
  check(
    pageWindow.document.getElementById('version').textContent === 'v' + FS.VERSION,
    'the hangar shows the version number',
  );

  // ---- Building by dragging (step A2) ----
  const Editor = FS.Editor;
  const pageDocument = pageWindow.document;
  const editorCanvas = pageDocument.getElementById('edCanvas');
  editorCanvas.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 1280,
    bottom: 800,
    width: 1280,
    height: 800,
  });
  // The tray sits left of the build area (jsdom has no layout, so give it a box).
  pageDocument.querySelector('#editor .palette').getBoundingClientRect = () => ({
    left: -300,
    right: -10,
    top: 0,
    bottom: 800,
    width: 290,
    height: 800,
  });
  const fire = (element, type, options) => {
    const event = new pageWindow.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 0, clientY: 0 }, options);
    element.dispatchEvent(event);
  };
  const trayButton = (partId) => {
    [...pageDocument.getElementById('palTabs').children]
      .find((tab) => tab.textContent === FS.PART[partId].cat)
      .click();
    return pageDocument.querySelector(`#palette [data-part="${partId}"]`);
  };
  const dragFromTray = (partId, target, pointerType = 'mouse') => {
    const button = trayButton(partId);
    fire(button, 'pointerdown', { pointerId: 7, pointerType, clientX: -150, clientY: 120 });
    fire(button, 'pointermove', { pointerId: 7, pointerType, clientX: target.x, clientY: target.y });
    fire(button, 'pointerup', { pointerId: 7, pointerType, clientX: target.x, clientY: target.y });
  };
  const partIds = () => Editor.parts.map((part) => part.def.id).join(',');
  const hopper = FS.SAMPLE_CRAFT.find((craft) => craft.name === 'Hopper').parts;
  const dvOf = (parts) => FS.stageStats(parts, FS.stagesOf(parts), 0, 0, 9.81).total;

  pageDocument.getElementById('btnNew').click();
  check(
    Editor.parts.length === 0 && pageDocument.getElementById('btnLaunch').disabled,
    'New starts an empty craft',
  );
  hopper.forEach((partId, index) => {
    let target = { x: 640, y: 260 };
    if (Editor.parts.length) {
      const freeNode = FS.Build.freeNodes(Editor.parts)
        .filter((node) => node.node === 'bottom')
        .sort((first, second) => first.pos.y - second.pos.y)[0];
      const screenPoint = Editor.toScreen({ x: freeNode.pos.x, y: freeNode.pos.y - FS.PART[partId].len / 2 });
      target = { x: screenPoint.x + (index % 2 ? 9 : -7), y: screenPoint.y + 6 }; // a few pixels off, as a hand would be
    }
    dragFromTray(partId, target);
  });
  check(partIds() === hopper.join(','), `Hopper rebuilt by dragging from the tray (${partIds()})`);
  const hopperDv = dvOf(FS.stackToParts(hopper));
  check(
    Math.abs(dvOf(Editor.parts) - hopperDv) < 0.5,
    `…with the sample's Δv (${dvOf(Editor.parts).toFixed(0)} m/s)`,
  );
  check(
    /Hornet|Hop/.test(pageDocument.getElementById('stageList').textContent),
    'the stage list follows the new craft',
  );

  // Touch: hold the engine, carry it to the tray, and let go: it is removed.
  const hornet = Editor.parts.find((part) => part.def.id === 'hornet');
  const hornetScreen = Editor.toScreen(hornet.pos);
  fire(editorCanvas, 'pointerdown', {
    pointerId: 21,
    pointerType: 'touch',
    clientX: hornetScreen.x,
    clientY: hornetScreen.y,
  });
  await sleep(500);
  check(Editor.drag && Editor.drag.root === hornet, 'holding a finger on a part picks it up');
  fire(editorCanvas, 'pointermove', { pointerId: 21, pointerType: 'touch', clientX: -120, clientY: 300 });
  check(
    pageDocument.querySelector('#editor .palette').classList.contains('drop-remove'),
    'the tray lights up as a place to remove it',
  );
  fire(editorCanvas, 'pointerup', { pointerId: 21, pointerType: 'touch', clientX: -120, clientY: 300 });
  check(
    !Editor.drag && !Editor.parts.includes(hornet) && Editor.parts.length === 4,
    'dropping it on the tray removes it',
  );

  // A mouse drag of the fins to empty space leaves them floating there; dragging them back reattaches them.
  const fins = Editor.parts.find((part) => part.def.id === 'fins');
  const finsBefore = Editor.toScreen(fins.pos);
  fire(editorCanvas, 'pointerdown', { pointerId: 3, clientX: finsBefore.x, clientY: finsBefore.y });
  fire(editorCanvas, 'pointermove', {
    pointerId: 3,
    clientX: finsBefore.x + 300,
    clientY: finsBefore.y - 200,
  });
  check(
    Editor.drag && Editor.drag.valid && Editor.drag.loose,
    'a part dragged into empty space can be left floating',
  );
  fire(editorCanvas, 'pointerup', { pointerId: 3, clientX: finsBefore.x + 300, clientY: finsBefore.y - 200 });
  check(
    Editor.parts.includes(fins) && !fins.parent && fins.loose === 'drop' && !Editor.main().includes(fins),
    'it floats, left out of the craft (left behind at launch by default)',
  );
  const tankA = Editor.parts.find((part) => part.def.id === 't100');
  const back = Editor.toScreen({ x: tankA.pos.x, y: tankA.pos.y - tankA.len / 2 - fins.len / 2 });
  const finsAfter = Editor.toScreen(fins.pos);
  fire(editorCanvas, 'pointerdown', { pointerId: 3, clientX: finsAfter.x, clientY: finsAfter.y });
  fire(editorCanvas, 'pointermove', { pointerId: 3, clientX: back.x + 4, clientY: back.y + 3 });
  fire(editorCanvas, 'pointerup', { pointerId: 3, clientX: back.x + 4, clientY: back.y + 3 });
  check(
    fins.parent === tankA && !fins.loose && Editor.main().includes(fins),
    'dragging the floating part back attaches it again',
  );

  // Pinch to zoom the build area.
  const startScale = Editor.cam.s;
  fire(editorCanvas, 'pointerdown', { pointerId: 31, pointerType: 'touch', clientX: 500, clientY: 400 });
  fire(editorCanvas, 'pointerdown', { pointerId: 32, pointerType: 'touch', clientX: 600, clientY: 400 });
  fire(editorCanvas, 'pointermove', { pointerId: 32, pointerType: 'touch', clientX: 700, clientY: 400 });
  fire(editorCanvas, 'pointerup', { pointerId: 32, pointerType: 'touch', clientX: 700, clientY: 400 });
  fire(editorCanvas, 'pointerup', { pointerId: 31, pointerType: 'touch', clientX: 500, clientY: 400 });
  check(
    Math.abs(Editor.cam.s / startScale - 2) < 0.01 && !Editor.drag,
    `pinching zooms the build area (×${(Editor.cam.s / startScale).toFixed(2)})`,
  );

  // Tap the capsule and make it the root.
  const lark = Editor.parts.find((part) => part.def.id === 'lark');
  const larkScreen = Editor.toScreen(lark.pos);
  fire(editorCanvas, 'pointerdown', { pointerId: 4, clientX: larkScreen.x, clientY: larkScreen.y });
  fire(editorCanvas, 'pointerup', { pointerId: 4, clientX: larkScreen.x, clientY: larkScreen.y });
  check(Editor.sel === lark, 'clicking a part selects it');
  pageDocument.getElementById('btnRoot').click();
  check(Editor.parts[0] === lark && !lark.parent, 'Make root makes the capsule the root');

  // Tapping a tray part adds it at the lowest free spot: the engine goes back under the fins.
  Editor.sel = null;
  trayButton('hornet').click();
  check(
    Editor.parts[Editor.parts.length - 1].def.id === 'hornet' &&
      Editor.parts[Editor.parts.length - 1].parent === fins,
    'tapping a tray part attaches it below the craft',
  );
  check(Math.abs(dvOf(Editor.parts) - hopperDv) < 0.5, 'the craft is a working Hopper again');

  // ---- Editor tools (step A3): build a craft with mirrored boosters, tilted fins and an offset, then undo it all ----
  const loadSample = (name) => {
    const select = pageDocument.getElementById('craftLoad');
    select.value = 'sample::' + name;
    select.dispatchEvent(new pageWindow.Event('change'));
  };
  loadSample('Orbiter I');
  const start = JSON.stringify(FS.serialParts(Editor.parts));
  const startHistory = Editor.hpos;
  const tanks = Editor.parts.filter((part) => part.def.id === 't800');
  const screenOffset = (part, deltaX, deltaY) =>
    Editor.toScreen({ x: part.pos.x + deltaX, y: part.pos.y + deltaY });
  key('x');
  check(
    Editor.mirror && pageDocument.getElementById('btnMirror').getAttribute('aria-pressed') === 'true',
    'X turns mirror symmetry on',
  );
  dragFromTray('radec', screenOffset(tanks[1], 0.8, 0.3));
  const radec = Editor.parts.find((part) => part.def.id === 'radec');
  dragFromTray('rumbler', screenOffset(radec, 0.75, 0.1));
  check(
    Editor.parts.filter((part) => part.def.id === 'rumbler').length === 2 &&
      Editor.parts.filter((part) => part.def.id === 'radec').length === 2,
    'dragging one side decoupler and one booster gives a mirrored pair of each',
  );
  // carry a swept fin, turn it with Q, drop it on the side of the upper tank
  const finButton = trayButton('sweptfin');
  fire(finButton, 'pointerdown', { pointerId: 8, clientX: -150, clientY: 100 });
  const finTarget = screenOffset(tanks[0], 1.0, 0.1);
  fire(finButton, 'pointermove', { pointerId: 8, clientX: finTarget.x, clientY: finTarget.y });
  key('q');
  check(Editor.drag && Math.abs(Editor.drag.root.spin - Math.PI / 12) < 1e-9, 'Q turns the carried part 15°');
  fire(finButton, 'pointerup', { pointerId: 8, clientX: finTarget.x, clientY: finTarget.y });
  const fins2 = Editor.parts.filter((part) => part.def.id === 'sweptfin');
  check(
    fins2.length === 2 &&
      Math.abs(Math.abs(fins2[0].rot) - Math.PI / 12) < 1e-9 &&
      Math.abs(fins2[0].rot + fins2[1].rot) < 1e-9,
    'the fin lands tilted 15°, with a twin tilted the mirror way',
  );
  // Alt-drag the fin 1 m down its tank
  const fin = fins2[0];
  const finStartY = FS.Build.surfaceHeight(fin);
  const finScreen = Editor.toScreen(fin.pos);
  fire(editorCanvas, 'pointerdown', {
    pointerId: 9,
    clientX: finScreen.x,
    clientY: finScreen.y,
    altKey: true,
  });
  fire(editorCanvas, 'pointermove', {
    pointerId: 9,
    clientX: finScreen.x,
    clientY: finScreen.y + Editor.cam.s * 1.0,
    altKey: true,
  });
  fire(editorCanvas, 'pointerup', {
    pointerId: 9,
    clientX: finScreen.x,
    clientY: finScreen.y + Editor.cam.s * 1.0,
    altKey: true,
  });
  const finEndY = FS.Build.surfaceHeight(fin);
  check(
    Math.abs(finEndY - (finStartY - 1)) < 0.13 &&
      Math.abs(FS.Build.surfaceHeight(FS.Build.twinOf(Editor.parts, fin)) - finEndY) < 1e-9,
    `Alt-drag slides the fin down its tank, and its twin with it (${finStartY.toFixed(2)} → ${finEndY.toFixed(2)} m)`,
  );
  check(Editor.parts.length === 17, `the craft now has 17 parts (${Editor.parts.length})`);
  const built = JSON.stringify(FS.serialParts(Editor.parts));
  let undos = 0;
  while (Editor.hpos > startHistory && undos < 20) {
    pageWindow.dispatchEvent(new pageWindow.KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    undos++;
  }
  check(
    JSON.stringify(FS.serialParts(Editor.parts)) === start,
    `Ctrl+Z reverses every step back to the original craft (${undos} undos)`,
  );
  for (let undoIndex = 0; undoIndex < undos; undoIndex++) {
    pageWindow.dispatchEvent(new pageWindow.KeyboardEvent('keydown', { key: 'y', ctrlKey: true }));
  }
  check(JSON.stringify(FS.serialParts(Editor.parts)) === built, 'Ctrl+Y brings every step back');

  // Save a booster as a subassembly; it appears in the tray
  Editor.sel = Editor.parts.find((part) => part.def.id === 'radec');
  Editor.render();
  pageDocument.getElementById('btnSub').click();
  check(
    Editor.subs.length === 1 &&
      Editor.tab === 'Subassemblies' &&
      pageDocument.querySelector('#palette [data-sub="0"]'),
    `“Save sub” keeps the side decoupler and booster in the tray (${Editor.subs[0] && Editor.subs[0].name})`,
  );
  // Alt-click copies a part; the copy follows the pointer and is dropped by the next click
  const collar = Editor.parts.find((part) => part.def.id === 'fins');
  const collarScreen = Editor.toScreen(collar.pos);
  fire(editorCanvas, 'pointerdown', {
    pointerId: 10,
    clientX: collarScreen.x,
    clientY: collarScreen.y,
    altKey: true,
  });
  fire(editorCanvas, 'pointerup', {
    pointerId: 10,
    clientX: collarScreen.x,
    clientY: collarScreen.y,
    altKey: true,
  });
  check(
    Editor.drag && Editor.drag.pointerId === 'carry' && Editor.drag.held.length === 2,
    'Alt-click picks up a copy of the fin collar and the engine below it',
  );
  fire(editorCanvas, 'pointerdown', { pointerId: 11, clientX: 20, clientY: 20 });
  check(
    !Editor.drag && Editor.parts.length === 19 && Editor.main().length === 17,
    'clicking empty space with the copy leaves it floating there',
  );
  Editor.remove(Editor.parts[Editor.parts.length - 2]);
  check(Editor.parts.length === 17, 'and the floating copy can be removed');
  // overlays
  pageDocument.getElementById('ovl_cop').click();
  check(!Editor.overlays.cop, 'the Pressure switch hides the centre of pressure');
  pageDocument.getElementById('ovl_cop').click();
  const overlayInfo = Editor.overlayData(Editor.main());
  check(
    overlayInfo.cot &&
      overlayInfo.cop &&
      Math.abs(overlayInfo.miss) < 1e-4 &&
      Math.abs(overlayInfo.cot.dir.x) < 1e-9,
    `overlays: thrust on the centre line, centre of pressure ${overlayInfo.cop.ahead.toFixed(2)} m from the centre of mass`,
  );
  key('x');

  // ---- Step A4: stretch a tank to 9 m, give it a look, custom staging, save, export, import ----
  loadSample('Orbiter I');
  const tank = Editor.parts.filter((part) => part.def.id === 't800')[1];
  const tankScreen = Editor.toScreen(tank.pos);
  const ctxEv = new pageWindow.Event('contextmenu', { bubbles: true, cancelable: true });
  Object.assign(ctxEv, { clientX: tankScreen.x, clientY: tankScreen.y });
  editorCanvas.dispatchEvent(ctxEv);
  check(
    Editor.sel === tank &&
      !pageDocument.querySelector('#editor .part-panel').hidden &&
      /Length/.test(pageDocument.querySelector('#editor .part-panel').textContent),
    'right-clicking a tank opens its settings',
  );
  // drag its stretch handle (at the free bottom end) down by 5 m
  const handlePoint = Editor.toScreen({ x: tank.pos.x, y: tank.pos.y - tank.len / 2 - 10 / Editor.cam.s });
  fire(editorCanvas, 'pointerdown', { pointerId: 40, clientX: handlePoint.x, clientY: handlePoint.y });
  fire(editorCanvas, 'pointermove', {
    pointerId: 40,
    clientX: handlePoint.x,
    clientY: handlePoint.y + Editor.cam.s * 5,
  });
  fire(editorCanvas, 'pointerup', {
    pointerId: 40,
    clientX: handlePoint.x,
    clientY: handlePoint.y + Editor.cam.s * 5,
  });
  check(
    tank.len === 9 && tank.cap === 9000,
    `dragging the stretch handle makes a 9 m tank with 9 t of fuel (${tank.len} m)`,
  );
  [...pageDocument.querySelectorAll('#editor .part-panel .pp-choice')]
    .find((button) => /Gold foil/.test(button.textContent))
    .click();
  check(tank.skin === 'gold', 'the Look buttons change the tank to gold foil');
  // custom staging: give the Wren its own stage, with the keyboard on its chip
  const wrenChip = [...pageDocument.querySelectorAll('#stageList .stg-chip')].find((chip) =>
    /Wren/.test(chip.textContent),
  );
  wrenChip.dispatchEvent(new pageWindow.KeyboardEvent('keydown', { key: ']', bubbles: true }));
  const order = () =>
    FS.stagesOf(Editor.parts)
      .map((stage) =>
        stage.parts
          .map((part) => part.def.id)
          .sort()
          .join('+'),
      )
      .join(' | ');
  check(
    order() === 'kestrel | decoupler | decoupler+wren | canopy' &&
      pageDocument.getElementById('stageMode').textContent === 'Custom',
    `] on a stage chip moves it a stage later (${order()})`,
  );
  const configured = JSON.stringify(FS.serialParts(Editor.parts));
  // save, load something else, load it back
  pageDocument.getElementById('craftName').value = 'Long Gold';
  pageDocument.getElementById('craftName').dispatchEvent(new pageWindow.Event('input'));
  pageDocument.getElementById('btnSave').click();
  loadSample('Hopper');
  const select = pageDocument.getElementById('craftLoad');
  select.value = 'saved::Long Gold';
  select.dispatchEvent(new pageWindow.Event('change'));
  check(
    JSON.stringify(FS.serialParts(Editor.parts)) === configured,
    'the saved craft reloads with its 9 m gold tank and custom staging',
  );
  // export as text, load another craft, paste the text back in
  pageDocument.getElementById('btnFiles').click();
  check(!pageDocument.getElementById('craftFiles').hidden, 'Files opens the craft file dialog');
  pageDocument.getElementById('cfCopy').click();
  const shared = pageDocument.getElementById('cfText').value;
  check(/^FLATSPACE-CRAFT-1:/.test(shared), 'Copy as text gives the share text');
  loadSample('Hopper');
  pageDocument.getElementById('cfText').value = shared;
  pageDocument.getElementById('cfPaste').click();
  check(
    Editor.name === 'Long Gold' && JSON.stringify(FS.serialParts(Editor.parts)) === configured,
    'pasting the text back loads the same craft',
  );
  const flightVessel = new FS.Vessel('Long Gold', FS.serialParts(Editor.parts), FS.root, {});
  check(
    flightVessel.parts.some((part) => part.len === 9 && part.skin === 'gold') &&
      flightVessel.stages.length === 4 &&
      flightVessel.stages[2].engines[0].def.id === 'wren',
    'and it goes to the pad as configured',
  );
  pageDocument.getElementById('cfClose').click();
  FS.PartPanel.closeAll('editor');

  // Pop-ups: selecting a part opens one with a pointer line; selecting another replaces it
  // unless it is pinned; the title bar drags it.
  loadSample('Orbiter I');
  const popups = () => [...pageDocument.querySelectorAll('#editor .part-panel')];
  const tapPart = (part, pointerId) => {
    const screenPoint = Editor.toScreen(part.pos);
    fire(editorCanvas, 'pointerdown', {
      pointerId: pointerId,
      clientX: screenPoint.x,
      clientY: screenPoint.y,
    });
    fire(editorCanvas, 'pointerup', { pointerId: pointerId, clientX: screenPoint.x, clientY: screenPoint.y });
  };
  const engine = Editor.parts.find((part) => part.def.id === 'kestrel');
  const capsule = Editor.parts.find((part) => part.def.id === 'canopy');
  tapPart(engine, 50);
  Editor.render();
  check(
    Editor.sel === engine && popups().length === 1 && /Thrust limit/.test(popups()[0].textContent),
    'clicking a part opens its pop-up',
  );
  check(
    pageDocument.querySelector('#editor .pp-lines line') &&
      pageDocument.querySelector('#editor .pp-lines circle'),
    'the pop-up has a pointer line to its part',
  );
  tapPart(capsule, 51);
  check(
    popups().length === 1 && FS.PartPanel.panels('editor')[0].part === capsule,
    'selecting another part swaps the unpinned pop-up for its own',
  );
  const pinBtn = popups()[0].querySelector('.pp-pin');
  pinBtn.click();
  check(
    pinBtn.getAttribute('aria-pressed') === 'true' && popups()[0].classList.contains('pinned'),
    'the pin button pins it',
  );
  tapPart(engine, 52);
  check(popups().length === 2, 'a pinned pop-up stays open when another part is selected');
  const pinned = FS.PartPanel.panels('editor').find((panel) => panel.part === capsule);
  const off0 = { ...pinned.off };
  const head = pinned.el.querySelector('.pp-head');
  fire(head, 'pointerdown', { pointerId: 53, button: 0, clientX: 10, clientY: 10 });
  fire(head, 'pointermove', { pointerId: 53, clientX: 50, clientY: 70 });
  fire(head, 'pointerup', { pointerId: 53, clientX: 50, clientY: 70 });
  check(
    pinned.off.x === off0.x + 40 && pinned.off.y === off0.y + 60,
    'the pop-up can be dragged by its title bar',
  );
  pinned.el.querySelector('.pp-close').click();
  check(popups().length === 1, 'the × closes it');
  FS.PartPanel.closeAll('editor');

  // A floating part set to launch with the craft goes along, where it was placed.
  loadSample('Hopper');
  const loose = Editor.parts.find((part) => part.def.id === 'hornet');
  const looseStart = Editor.toScreen(loose.pos);
  fire(editorCanvas, 'pointerdown', { pointerId: 54, clientX: looseStart.x, clientY: looseStart.y });
  fire(editorCanvas, 'pointermove', { pointerId: 54, clientX: looseStart.x + 250, clientY: looseStart.y });
  fire(editorCanvas, 'pointerup', { pointerId: 54, clientX: looseStart.x + 250, clientY: looseStart.y });
  check(loose.loose === 'drop', 'the engine floats beside the Hopper');
  FS.PartPanel.select(loose, 'editor');
  [...popups()[0].querySelectorAll('.pp-choice')]
    .find((button) => /Launch with/.test(button.textContent))
    .click();
  check(loose.loose === 'keep', 'its pop-up sets it to launch with the craft');
  FS.Editor.launch();
  await sleep(200);
  const extra = game.debris.find((debrisVessel) =>
    debrisVessel.parts.some((part) => part.def.id === 'hornet'),
  );
  check(
    game.scene === 'flight' && extra && !game.vessel.parts.some((part) => part.def.id === 'hornet'),
    'it launches as a separate object next to the craft',
  );
  const gap = extra && FS.vec.len(FS.vec.sub(extra.r, game.vessel.r));
  check(
    extra && gap > 3 && gap < 40,
    `placed where it floated in the hangar (${gap && gap.toFixed(1)} m away)`,
  );
  game.showScene('editor');
  await sleep(100);

  loadSample('Hopper');

  FS.Editor.launch();
  await sleep(200);
  check(game.scene === 'flight', 'launching opens the flight scene');
  const padAlt = game.vessel.altitude;
  key(' ');
  await sleep(2000);
  const climb = game.vessel.altitude - padAlt;
  check(
    game.vessel.thrustNow > 0 && climb > 1,
    `the rocket lifts off (climbed ${climb.toFixed(1)} m in 2 s)`,
  );

  // Tapping a part in flight opens its pop-up, and its settings still work.
  const fview = pageDocument.getElementById('view');
  const hornetF = game.vessel.parts.find((part) => part.def.id === 'hornet');
  const hornetFlightScreen = FS.Renderer.partToScreen(game.cam, game.vessel, game.t, hornetF.c);
  fire(fview, 'pointerdown', { pointerId: 60, clientX: hornetFlightScreen.x, clientY: hornetFlightScreen.y });
  fire(fview, 'pointerup', { pointerId: 60, clientX: hornetFlightScreen.x, clientY: hornetFlightScreen.y });
  const fpop = pageDocument.querySelector('#flight .part-panel');
  check(
    fpop && FS.PartPanel.panels('flight')[0].part === hornetF,
    'tapping a part in flight opens its pop-up',
  );
  const limitSlider = fpop && fpop.querySelector('input[type=range]');
  if (limitSlider) {
    limitSlider.value = 50;
    limitSlider.dispatchEvent(new pageWindow.Event('input', { bubbles: true }));
    limitSlider.dispatchEvent(new pageWindow.Event('change', { bubbles: true }));
  }
  check(hornetF.limit === 0.5, `its thrust limit can be changed mid-flight (${hornetF.limit})`);
  FS.PartPanel.closeAll('flight');

  key('F3');
  await sleep(400);
  const overlay = pageWindow.document.getElementById('devOverlay');
  check(!overlay.hidden && /physics/.test(overlay.textContent), 'F3 shows the developer overlay');

  key('m');
  await sleep(300);
  check(game.mapMode, 'M opens the map');

  // Two-finger pinch on the map: fingers move from 100 px apart to 200 px apart.
  const view = pageWindow.document.getElementById('view');
  const pointer = (type, pointerId, pointerX) => {
    const event = new pageWindow.Event(type, { bubbles: true });
    Object.assign(event, { pointerId: pointerId, clientX: pointerX, clientY: 300 });
    view.dispatchEvent(event);
  };
  const mapStartScale = game.mapCam.s;
  pointer('pointerdown', 1, 500);
  pointer('pointerdown', 2, 600);
  pointer('pointermove', 2, 700);
  pointer('pointerup', 2, 700);
  pointer('pointerup', 1, 500);
  const ratio = game.mapCam.s / mapStartScale;
  check(Math.abs(ratio - 2) < 0.01, `pinching zooms the map (scale ×${ratio.toFixed(2)})`);
  check(!game.node, 'lifting fingers after a pinch does not add a maneuver node');
  key('Escape');
  await sleep(100);
  check(
    !pageWindow.document.getElementById('dialog').hidden &&
      /v\d/.test(pageWindow.document.getElementById('dlgBody').textContent),
    'Esc opens the menu with the version number',
  );

  check(
    FS.Renderer === FS.Render &&
      pageDocument.querySelector('.gl-notice') &&
      /WebGL2/.test(pageDocument.querySelector('.gl-notice').textContent),
    'without WebGL2 the game uses the Canvas 2D renderer and says so',
  );
  check(errors.length === 0, 'no script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  done();
})();
