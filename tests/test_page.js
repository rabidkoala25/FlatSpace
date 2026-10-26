// Loads the real page in jsdom, launches a rocket, and checks for script errors.
// Needs jsdom: run "npm install" once in the project folder. Skipped if it's missing.
const fileSystem = require('fs');
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

let html = fileSystem.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1]);
// Every local file carries ?v=<version> so browsers never mix cached old files with new ones.
const assetTags = [...html.matchAll(/(?:src|href)="((?:js|data|css)\/[^"]+)"/g)].map((match) => match[1]);
const tagged = assetTags.map((tag) => tag.split('?v=')[1] || '');
const versionInFile = (fileSystem
  .readFileSync(path.join(ROOT, 'js/util.js'), 'utf8')
  .match(/Flatspace\.VERSION = '([^']+)'/) || [])[1];
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

for (const source of scripts) {
  try {
    pageWindow.eval(fileSystem.readFileSync(path.join(ROOT, source.split('?')[0]), 'utf8'));
  } catch (error) {
    errors.push(source + ': ' + error.message);
  }
}
check(
  scripts.some((source) => source.startsWith('data/parts.js')) &&
    scripts.some((source) => source.startsWith('js/save.js')),
  'index.html loads the data files and save.js',
);
check(
  assetTags.length > 10 && tagged.every((version) => version === versionInFile),
  `every script and style link in index.html ends in ?v=${versionInFile} (bump them with Flatspace.VERSION)`,
);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const key = (keyName) => {
  pageWindow.dispatchEvent(new pageWindow.KeyboardEvent('keydown', { key: keyName }));
  pageWindow.dispatchEvent(new pageWindow.KeyboardEvent('keyup', { key: keyName }));
};

(async () => {
  await sleep(300);
  const Flatspace = pageWindow.Flatspace;
  const game = Flatspace.game;
  check(
    pageWindow.document.getElementById('version').textContent === 'v' + Flatspace.VERSION,
    'the hangar shows the version number',
  );

  // ---- Building by dragging (step A2) ----
  const Editor = Flatspace.Editor;
  const pageDocument = pageWindow.document;
  const editorCanvas = pageDocument.getElementById('editorCanvas');
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
    [...pageDocument.getElementById('paletteTabs').children]
      .find((tab) => tab.textContent === Flatspace.PART[partId].category)
      .click();
    return pageDocument.querySelector(`#palette [data-part="${partId}"]`);
  };
  const dragFromTray = (partId, target, pointerType = 'mouse') => {
    const button = trayButton(partId);
    fire(button, 'pointerdown', { pointerId: 7, pointerType, clientX: -150, clientY: 120 });
    fire(button, 'pointermove', { pointerId: 7, pointerType, clientX: target.x, clientY: target.y });
    fire(button, 'pointerup', { pointerId: 7, pointerType, clientX: target.x, clientY: target.y });
  };
  const partIds = () => Editor.parts.map((part) => part.type.id).join(',');
  const hopper = Flatspace.SAMPLE_CRAFT.find((craft) => craft.name === 'Hopper').parts;
  const deltaVOf = (parts) => Flatspace.stageStats(parts, Flatspace.stagesOf(parts), 0, 0, 9.81).total;

  pageDocument.getElementById('newButton').click();
  check(
    Editor.parts.length === 0 && pageDocument.getElementById('launchButton').disabled,
    'New starts an empty craft',
  );
  hopper.forEach((partId, index) => {
    let target = { x: 640, y: 260 };
    if (Editor.parts.length) {
      const freeNode = Flatspace.Build.freeNodes(Editor.parts)
        .filter((node) => node.node === 'bottom')
        .sort((first, second) => first.position.y - second.position.y)[0];
      const screenPoint = Editor.toScreen({
        x: freeNode.position.x,
        y: freeNode.position.y - Flatspace.PART[partId].length / 2,
      });
      target = { x: screenPoint.x + (index % 2 ? 9 : -7), y: screenPoint.y + 6 }; // a few pixels off, as a hand would be
    }
    dragFromTray(partId, target);
  });
  check(partIds() === hopper.join(','), `Hopper rebuilt by dragging from the tray (${partIds()})`);
  const hopperDeltaV = deltaVOf(Flatspace.stackToParts(hopper));
  check(
    Math.abs(deltaVOf(Editor.parts) - hopperDeltaV) < 0.5,
    `…with the sample's Δv (${deltaVOf(Editor.parts).toFixed(0)} m/s)`,
  );
  check(
    /Hornet|Hop/.test(pageDocument.getElementById('stageList').textContent),
    'the stage list follows the new craft',
  );

  // Touch: hold the engine, carry it to the tray, and let go: it is removed.
  const hornet = Editor.parts.find((part) => part.type.id === 'hornet');
  const hornetScreen = Editor.toScreen(hornet.position);
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
  const fins = Editor.parts.find((part) => part.type.id === 'fins');
  const finsBefore = Editor.toScreen(fins.position);
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
  const tankA = Editor.parts.find((part) => part.type.id === 't100');
  const back = Editor.toScreen({
    x: tankA.position.x,
    y: tankA.position.y - tankA.length / 2 - fins.length / 2,
  });
  const finsAfter = Editor.toScreen(fins.position);
  fire(editorCanvas, 'pointerdown', { pointerId: 3, clientX: finsAfter.x, clientY: finsAfter.y });
  fire(editorCanvas, 'pointermove', { pointerId: 3, clientX: back.x + 4, clientY: back.y + 3 });
  fire(editorCanvas, 'pointerup', { pointerId: 3, clientX: back.x + 4, clientY: back.y + 3 });
  check(
    fins.parent === tankA && !fins.loose && Editor.main().includes(fins),
    'dragging the floating part back attaches it again',
  );

  // Pinch to zoom the build area.
  const startScale = Editor.camera.scale;
  fire(editorCanvas, 'pointerdown', { pointerId: 31, pointerType: 'touch', clientX: 500, clientY: 400 });
  fire(editorCanvas, 'pointerdown', { pointerId: 32, pointerType: 'touch', clientX: 600, clientY: 400 });
  fire(editorCanvas, 'pointermove', { pointerId: 32, pointerType: 'touch', clientX: 700, clientY: 400 });
  fire(editorCanvas, 'pointerup', { pointerId: 32, pointerType: 'touch', clientX: 700, clientY: 400 });
  fire(editorCanvas, 'pointerup', { pointerId: 31, pointerType: 'touch', clientX: 500, clientY: 400 });
  check(
    Math.abs(Editor.camera.scale / startScale - 2) < 0.01 && !Editor.drag,
    `pinching zooms the build area (×${(Editor.camera.scale / startScale).toFixed(2)})`,
  );

  // Tap the capsule and make it the root.
  const lark = Editor.parts.find((part) => part.type.id === 'lark');
  const larkScreen = Editor.toScreen(lark.position);
  fire(editorCanvas, 'pointerdown', { pointerId: 4, clientX: larkScreen.x, clientY: larkScreen.y });
  fire(editorCanvas, 'pointerup', { pointerId: 4, clientX: larkScreen.x, clientY: larkScreen.y });
  check(Editor.selected === lark, 'clicking a part selects it');
  pageDocument.getElementById('rootButton').click();
  check(Editor.parts[0] === lark && !lark.parent, 'Make root makes the capsule the root');

  // Tapping a tray part adds it at the lowest free spot: the engine goes back under the fins.
  Editor.selected = null;
  trayButton('hornet').click();
  check(
    Editor.parts[Editor.parts.length - 1].type.id === 'hornet' &&
      Editor.parts[Editor.parts.length - 1].parent === fins,
    'tapping a tray part attaches it below the craft',
  );
  check(Math.abs(deltaVOf(Editor.parts) - hopperDeltaV) < 0.5, 'the craft is a working Hopper again');

  // ---- Editor tools (step A3): build a craft with mirrored boosters, tilted fins and an offset, then undo it all ----
  const loadSample = (name) => {
    const select = pageDocument.getElementById('craftLoad');
    select.value = 'sample::' + name;
    select.dispatchEvent(new pageWindow.Event('change'));
  };
  loadSample('Orbiter I');
  const start = JSON.stringify(Flatspace.serialParts(Editor.parts));
  const startHistory = Editor.historyIndex;
  const tanks = Editor.parts.filter((part) => part.type.id === 't800');
  const screenOffset = (part, deltaX, deltaY) =>
    Editor.toScreen({ x: part.position.x + deltaX, y: part.position.y + deltaY });
  key('x');
  check(
    Editor.mirror && pageDocument.getElementById('mirrorButton').getAttribute('aria-pressed') === 'true',
    'X turns mirror symmetry on',
  );
  dragFromTray('sidedecoupler', screenOffset(tanks[1], 0.8, 0.3));
  const radialDecoupler = Editor.parts.find((part) => part.type.id === 'sidedecoupler');
  dragFromTray('rumbler', screenOffset(radialDecoupler, 0.75, 0.1));
  check(
    Editor.parts.filter((part) => part.type.id === 'rumbler').length === 2 &&
      Editor.parts.filter((part) => part.type.id === 'sidedecoupler').length === 2,
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
  const fins2 = Editor.parts.filter((part) => part.type.id === 'sweptfin');
  check(
    fins2.length === 2 &&
      Math.abs(Math.abs(fins2[0].rotation) - Math.PI / 12) < 1e-9 &&
      Math.abs(fins2[0].rotation + fins2[1].rotation) < 1e-9,
    'the fin lands tilted 15°, with a twin tilted the mirror way',
  );
  // Alt-drag the fin 1 m down its tank
  const fin = fins2[0];
  const finStartY = Flatspace.Build.surfaceHeight(fin);
  const finScreen = Editor.toScreen(fin.position);
  fire(editorCanvas, 'pointerdown', {
    pointerId: 9,
    clientX: finScreen.x,
    clientY: finScreen.y,
    altKey: true,
  });
  fire(editorCanvas, 'pointermove', {
    pointerId: 9,
    clientX: finScreen.x,
    clientY: finScreen.y + Editor.camera.scale * 1.0,
    altKey: true,
  });
  fire(editorCanvas, 'pointerup', {
    pointerId: 9,
    clientX: finScreen.x,
    clientY: finScreen.y + Editor.camera.scale * 1.0,
    altKey: true,
  });
  const finEndY = Flatspace.Build.surfaceHeight(fin);
  check(
    Math.abs(finEndY - (finStartY - 1)) < 0.13 &&
      Math.abs(Flatspace.Build.surfaceHeight(Flatspace.Build.twinOf(Editor.parts, fin)) - finEndY) < 1e-9,
    `Alt-drag slides the fin down its tank, and its twin with it (${finStartY.toFixed(2)} → ${finEndY.toFixed(2)} m)`,
  );
  check(Editor.parts.length === 17, `the craft now has 17 parts (${Editor.parts.length})`);
  const built = JSON.stringify(Flatspace.serialParts(Editor.parts));
  let undoCount = 0;
  while (Editor.historyIndex > startHistory && undoCount < 20) {
    pageWindow.dispatchEvent(new pageWindow.KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    undoCount++;
  }
  check(
    JSON.stringify(Flatspace.serialParts(Editor.parts)) === start,
    `Ctrl+Z reverses every step back to the original craft (${undoCount} undos)`,
  );
  for (let undoIndex = 0; undoIndex < undoCount; undoIndex++) {
    pageWindow.dispatchEvent(new pageWindow.KeyboardEvent('keydown', { key: 'y', ctrlKey: true }));
  }
  check(JSON.stringify(Flatspace.serialParts(Editor.parts)) === built, 'Ctrl+Y brings every step back');

  // Save a booster as a subassembly; it appears in the tray
  Editor.selected = Editor.parts.find((part) => part.type.id === 'sidedecoupler');
  Editor.render();
  pageDocument.getElementById('subassemblyButton').click();
  check(
    Editor.subassemblies.length === 1 &&
      Editor.tab === 'Subassemblies' &&
      pageDocument.querySelector('#palette [data-subassembly-index="0"]'),
    `“Save sub” keeps the side decoupler and booster in the tray (${Editor.subassemblies[0] && Editor.subassemblies[0].name})`,
  );
  // Alt-click copies a part; the copy follows the pointer and is dropped by the next click
  const collar = Editor.parts.find((part) => part.type.id === 'fins');
  const collarScreen = Editor.toScreen(collar.position);
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
  pageDocument.getElementById('overlay-centreOfPressure').click();
  check(!Editor.overlays.centreOfPressure, 'the Pressure switch hides the centre of pressure');
  pageDocument.getElementById('overlay-centreOfPressure').click();
  const overlayInfo = Editor.overlayData(Editor.main());
  check(
    overlayInfo.centreOfThrust &&
      overlayInfo.centreOfPressure &&
      Math.abs(overlayInfo.miss) < 1e-4 &&
      Math.abs(overlayInfo.centreOfThrust.direction.x) < 1e-9,
    `overlays: thrust on the centre line, centre of pressure ${overlayInfo.centreOfPressure.ahead.toFixed(2)} m from the centre of mass`,
  );
  key('x');

  // ---- Step A4: stretch a tank to 9 m, give it a look, custom staging, save, export, import ----
  loadSample('Orbiter I');
  const tank = Editor.parts.filter((part) => part.type.id === 't800')[1];
  const tankScreen = Editor.toScreen(tank.position);
  const contextMenuEvent = new pageWindow.Event('contextmenu', { bubbles: true, cancelable: true });
  Object.assign(contextMenuEvent, { clientX: tankScreen.x, clientY: tankScreen.y });
  editorCanvas.dispatchEvent(contextMenuEvent);
  check(
    Editor.selected === tank &&
      !pageDocument.querySelector('#editor .part-panel').hidden &&
      /Length/.test(pageDocument.querySelector('#editor .part-panel').textContent),
    'right-clicking a tank opens its settings',
  );
  // drag its stretch handle (at the free bottom end) down by 5 m
  const handlePoint = Editor.toScreen({
    x: tank.position.x,
    y: tank.position.y - tank.length / 2 - 10 / Editor.camera.scale,
  });
  fire(editorCanvas, 'pointerdown', { pointerId: 40, clientX: handlePoint.x, clientY: handlePoint.y });
  fire(editorCanvas, 'pointermove', {
    pointerId: 40,
    clientX: handlePoint.x,
    clientY: handlePoint.y + Editor.camera.scale * 5,
  });
  fire(editorCanvas, 'pointerup', {
    pointerId: 40,
    clientX: handlePoint.x,
    clientY: handlePoint.y + Editor.camera.scale * 5,
  });
  check(
    tank.length === 9 && tank.fuelCapacity === 9000,
    `dragging the stretch handle makes a 9 m tank with 9 t of fuel (${tank.length} m)`,
  );
  [...pageDocument.querySelectorAll('#editor .part-panel .part-panel-choice')]
    .find((button) => /Gold foil/.test(button.textContent))
    .click();
  check(tank.skin === 'gold', 'the Look buttons change the tank to gold foil');
  // custom staging: give the Wren its own stage, with the keyboard on its chip
  const wrenChip = [...pageDocument.querySelectorAll('#stageList .stage-chip')].find((chip) =>
    /Wren/.test(chip.textContent),
  );
  wrenChip.dispatchEvent(new pageWindow.KeyboardEvent('keydown', { key: ']', bubbles: true }));
  const order = () =>
    Flatspace.stagesOf(Editor.parts)
      .map((stage) =>
        stage.parts
          .map((part) => part.type.id)
          .sort()
          .join('+'),
      )
      .join(' | ');
  check(
    order() === 'kestrel | decoupler | decoupler+wren | canopy' &&
      pageDocument.getElementById('stageMode').textContent === 'Custom',
    `] on a stage chip moves it a stage later (${order()})`,
  );
  const configured = JSON.stringify(Flatspace.serialParts(Editor.parts));
  // save, load something else, load it back
  pageDocument.getElementById('craftName').value = 'Long Gold';
  pageDocument.getElementById('craftName').dispatchEvent(new pageWindow.Event('input'));
  pageDocument.getElementById('saveButton').click();
  loadSample('Hopper');
  const select = pageDocument.getElementById('craftLoad');
  select.value = 'saved::Long Gold';
  select.dispatchEvent(new pageWindow.Event('change'));
  check(
    JSON.stringify(Flatspace.serialParts(Editor.parts)) === configured,
    'the saved craft reloads with its 9 m gold tank and custom staging',
  );
  // export as text, load another craft, paste the text back in
  pageDocument.getElementById('filesButton').click();
  check(!pageDocument.getElementById('craftFiles').hidden, 'Files opens the craft file dialog');
  pageDocument.getElementById('craftFilesCopy').click();
  const shared = pageDocument.getElementById('craftFilesText').value;
  check(/^FLATSPACE-CRAFT-1:/.test(shared), 'Copy as text gives the share text');
  loadSample('Hopper');
  pageDocument.getElementById('craftFilesText').value = shared;
  pageDocument.getElementById('craftFilesPaste').click();
  check(
    Editor.name === 'Long Gold' && JSON.stringify(Flatspace.serialParts(Editor.parts)) === configured,
    'pasting the text back loads the same craft',
  );
  const flightVessel = new Flatspace.Vessel(
    'Long Gold',
    Flatspace.serialParts(Editor.parts),
    Flatspace.root,
    {},
  );
  check(
    flightVessel.parts.some((part) => part.length === 9 && part.skin === 'gold') &&
      flightVessel.stages.length === 4 &&
      flightVessel.stages[2].engines[0].type.id === 'wren',
    'and it goes to the pad as configured',
  );
  pageDocument.getElementById('craftFilesClose').click();
  Flatspace.PartPanel.closeAll('editor');

  // Pop-ups: selecting a part opens one with a pointer line; selecting another replaces it
  // unless it is pinned; the title bar drags it.
  loadSample('Orbiter I');
  const popups = () => [...pageDocument.querySelectorAll('#editor .part-panel')];
  const tapPart = (part, pointerId) => {
    const screenPoint = Editor.toScreen(part.position);
    fire(editorCanvas, 'pointerdown', {
      pointerId,
      clientX: screenPoint.x,
      clientY: screenPoint.y,
    });
    fire(editorCanvas, 'pointerup', { pointerId, clientX: screenPoint.x, clientY: screenPoint.y });
  };
  const engine = Editor.parts.find((part) => part.type.id === 'kestrel');
  const capsule = Editor.parts.find((part) => part.type.id === 'canopy');
  tapPart(engine, 50);
  Editor.render();
  check(
    Editor.selected === engine && popups().length === 1 && /Thrust limit/.test(popups()[0].textContent),
    'clicking a part opens its pop-up',
  );
  check(
    pageDocument.querySelector('#editor .part-panel-lines line') &&
      pageDocument.querySelector('#editor .part-panel-lines circle'),
    'the pop-up has a pointer line to its part',
  );
  tapPart(capsule, 51);
  check(
    popups().length === 1 && Flatspace.PartPanel.panels('editor')[0].part === capsule,
    'selecting another part swaps the unpinned pop-up for its own',
  );
  const pinButton = popups()[0].querySelector('.part-panel-pin');
  pinButton.click();
  check(
    pinButton.getAttribute('aria-pressed') === 'true' && popups()[0].classList.contains('pinned'),
    'the pin button pins it',
  );
  tapPart(engine, 52);
  check(popups().length === 2, 'a pinned pop-up stays open when another part is selected');
  const pinned = Flatspace.PartPanel.panels('editor').find((panel) => panel.part === capsule);
  const off0 = { ...pinned.offset };
  const head = pinned.element.querySelector('.part-panel-head');
  fire(head, 'pointerdown', { pointerId: 53, button: 0, clientX: 10, clientY: 10 });
  fire(head, 'pointermove', { pointerId: 53, clientX: 50, clientY: 70 });
  fire(head, 'pointerup', { pointerId: 53, clientX: 50, clientY: 70 });
  check(
    pinned.offset.x === off0.x + 40 && pinned.offset.y === off0.y + 60,
    'the pop-up can be dragged by its title bar',
  );
  pinned.element.querySelector('.part-panel-close').click();
  check(popups().length === 1, 'the × closes it');
  Flatspace.PartPanel.closeAll('editor');

  // A floating part set to launch with the craft goes along, where it was placed.
  loadSample('Hopper');
  const loose = Editor.parts.find((part) => part.type.id === 'hornet');
  const looseStart = Editor.toScreen(loose.position);
  fire(editorCanvas, 'pointerdown', { pointerId: 54, clientX: looseStart.x, clientY: looseStart.y });
  fire(editorCanvas, 'pointermove', { pointerId: 54, clientX: looseStart.x + 250, clientY: looseStart.y });
  fire(editorCanvas, 'pointerup', { pointerId: 54, clientX: looseStart.x + 250, clientY: looseStart.y });
  check(loose.loose === 'drop', 'the engine floats beside the Hopper');
  Flatspace.PartPanel.select(loose, 'editor');
  [...popups()[0].querySelectorAll('.part-panel-choice')]
    .find((button) => /Launch with/.test(button.textContent))
    .click();
  check(loose.loose === 'keep', 'its pop-up sets it to launch with the craft');
  Flatspace.Editor.launch();
  await sleep(200);
  const extra = game.debris.find((debrisVessel) =>
    debrisVessel.parts.some((part) => part.type.id === 'hornet'),
  );
  check(
    game.scene === 'flight' && extra && !game.vessel.parts.some((part) => part.type.id === 'hornet'),
    'it launches as a separate object next to the craft',
  );
  const gap =
    extra && Flatspace.Vector.length(Flatspace.Vector.subtract(extra.position, game.vessel.position));
  check(
    extra && gap > 3 && gap < 40,
    `placed where it floated in the hangar (${gap && gap.toFixed(1)} m away)`,
  );
  game.showScene('editor');
  await sleep(100);

  loadSample('Hopper');

  Flatspace.Editor.launch();
  await sleep(200);
  check(game.scene === 'flight', 'launching opens the flight scene');
  const padAltitude = game.vessel.altitude;
  key(' ');
  await sleep(2000);
  const climb = game.vessel.altitude - padAltitude;
  check(
    game.vessel.thrustNow > 0 && climb > 1,
    `the rocket lifts off (climbed ${climb.toFixed(1)} m in 2 s)`,
  );

  // Tapping a part in flight opens its pop-up, and its settings still work.
  const flightView = pageDocument.getElementById('view');
  const flightHornet = game.vessel.parts.find((part) => part.type.id === 'hornet');
  const hornetFlightScreen = Flatspace.Renderer.partToScreen(
    game.camera,
    game.vessel,
    game.time,
    flightHornet.centreOffset,
  );
  fire(flightView, 'pointerdown', {
    pointerId: 60,
    clientX: hornetFlightScreen.x,
    clientY: hornetFlightScreen.y,
  });
  fire(flightView, 'pointerup', {
    pointerId: 60,
    clientX: hornetFlightScreen.x,
    clientY: hornetFlightScreen.y,
  });
  const flightPopup = pageDocument.querySelector('#flight .part-panel');
  check(
    flightPopup && Flatspace.PartPanel.panels('flight')[0].part === flightHornet,
    'tapping a part in flight opens its pop-up',
  );
  const limitSlider = flightPopup && flightPopup.querySelector('input[type=range]');
  if (limitSlider) {
    limitSlider.value = 50;
    limitSlider.dispatchEvent(new pageWindow.Event('input', { bubbles: true }));
    limitSlider.dispatchEvent(new pageWindow.Event('change', { bubbles: true }));
  }
  check(flightHornet.limit === 0.5, `its thrust limit can be changed mid-flight (${flightHornet.limit})`);
  Flatspace.PartPanel.closeAll('flight');

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
    Object.assign(event, { pointerId, clientX: pointerX, clientY: 300 });
    view.dispatchEvent(event);
  };
  const mapStartScale = game.mapCamera.scale;
  pointer('pointerdown', 1, 500);
  pointer('pointerdown', 2, 600);
  pointer('pointermove', 2, 700);
  pointer('pointerup', 2, 700);
  pointer('pointerup', 1, 500);
  const ratio = game.mapCamera.scale / mapStartScale;
  check(Math.abs(ratio - 2) < 0.01, `pinching zooms the map (scale ×${ratio.toFixed(2)})`);
  check(!game.node, 'lifting fingers after a pinch does not add a maneuver node');
  key('Escape');
  await sleep(100);
  check(
    !pageWindow.document.getElementById('dialog').hidden &&
      /v\d/.test(pageWindow.document.getElementById('dialogBody').textContent),
    'Esc opens the menu with the version number',
  );

  check(
    Flatspace.Renderer === Flatspace.Render &&
      pageDocument.querySelector('.webgl-notice') &&
      /WebGL2/.test(pageDocument.querySelector('.webgl-notice').textContent),
    'without WebGL2 the game uses the Canvas 2D renderer and says so',
  );
  check(errors.length === 0, 'no script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  done();
})();
