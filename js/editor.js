// editor.js — the Vehicle Assembly hangar: build a craft by dragging parts, see Δv per stage, launch.
// Layout: part tray (category tabs, hover cards, saved subassemblies) · build area (pan, zoom,
// no size limit, tool rail, overlays) · stats. The attach geometry (snapping, overlap,
// mirror twins, offsets, re-rooting) lives in build.js.
//
// Mouse: drag a part from the tray; drag a placed part to move it with everything below it;
// drop on the tray to remove; Alt-drag a side part to slide it; Alt-click to copy;
// drag empty space (or middle/right-drag) to pan; wheel to zoom.
// Keys: X mirror · Q / E rotate 15° (Shift 5°) · F flip · Ctrl+Z / Ctrl+Y undo / redo.
// Touch: hold a part to pick it up; one finger pans, two fingers pan and pinch-zoom; the
// tool rail has buttons for everything the keys do.
(function () {
  const Editor = (Flatspace.Editor = {});
  const Build = Flatspace.Build;
  const Vector = Flatspace.Vector;
  const byId = (elementId) => document.getElementById(elementId);
  const SNAP_PIXELS = 34; // snapping distance on screen
  const LONG_PRESS = 380; // milliseconds to pick up with a finger
  const HISTORY = 100; // undo steps
  const SUBASSEMBLY_TAB = 'Subassemblies';
  const RADIANS_PER_DEGREE = Math.PI / 180;
  let canvas;
  let context;
  let viewWidth = 0;
  let viewHeight = 0;
  let pixelRatio = 1;
  let game;
  let needFit = true;
  let railWidth = 0; // room taken by the tool rail on the left of the build area

  const sampleParts = (craft) =>
    craft.tree ? Flatspace.partsFromSerial(craft.tree) : Flatspace.stackToParts(craft.parts);

  Editor.name = 'Orbiter I';
  Editor.parts = []; // the craft; the first part is the root
  Editor.selected = null; // the selected part
  Editor.camera = { x: 0, y: 0, scale: 30 }; // centre of the view (craft frame, m) and pixels per metre
  Editor.drag = null; // the parts being carried, if any
  Editor.tab = Flatspace.PART_CATEGORIES[0];
  Editor.mirror = false; // mirror symmetry (X)
  Editor.snap = true; // snap offsets to 0.25 m and the middle of a side
  Editor.offsetMode = false; // dragging a side part slides it (for touch; Alt does it with a mouse)
  Editor.overlays = { centreOfMass: true, centreOfThrust: true, centreOfPressure: true };
  Editor.history = []; // saved craft states, oldest first
  Editor.historyIndex = -1; // the state shown now
  Editor.subassemblies = []; // saved subassemblies: [{ name, parts: [saved parts] }]

  // ---------- Coordinates ----------
  Editor.toScreen = (point) => ({
    x: viewWidth / 2 + (point.x - Editor.camera.x) * Editor.camera.scale,
    y: viewHeight / 2 - (point.y - Editor.camera.y) * Editor.camera.scale,
  });
  Editor.toWorld = (screenX, screenY) => ({
    x: Editor.camera.x + (screenX - viewWidth / 2) / Editor.camera.scale,
    y: Editor.camera.y - (screenY - viewHeight / 2) / Editor.camera.scale,
  });
  const canvasPoint = (event) => {
    const bounds = canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const worldOf = (event) => {
    const point = canvasPoint(event);
    return Editor.toWorld(point.x, point.y);
  };
  const inside = (element, event) => {
    if (!element) {
      return false;
    }
    const bounds = element.getBoundingClientRect();
    return (
      bounds.width > 0 &&
      event.clientX >= bounds.left &&
      event.clientX <= bounds.right &&
      event.clientY >= bounds.top &&
      event.clientY <= bounds.bottom
    );
  };
  const overTray = (event) => inside(document.querySelector('#editor .palette'), event);

  // ---------- Set-up ----------
  Editor.initialise = (theGame) => {
    game = theGame;
    canvas = byId('editorCanvas');
    context = canvas.getContext('2d');
    const saved = Flatspace.store.load('flatspace.current', null);
    if (saved && Array.isArray(saved.parts)) {
      Editor.name = saved.name || 'Untitled';
      Editor.parts = Flatspace.partsFromSerial(saved.parts);
      Editor.normalize();
    } else {
      Editor.parts = sampleParts(Flatspace.SAMPLE_CRAFT[1]);
    }
    Editor.subassemblies = Flatspace.store.load('flatspace.subassemblies', []) || [];
    const view = Flatspace.store.get('flatspace.editorView', null);
    if (view && view.overlays) {
      // views saved before 0.8 used com, cot and cop
      const OLD_OVERLAY_NAMES = { com: 'centreOfMass', cot: 'centreOfThrust', cop: 'centreOfPressure' };
      for (const [overlayName, isOn] of Object.entries(view.overlays)) {
        Editor.overlays[OLD_OVERLAY_NAMES[overlayName] || overlayName] = isOn;
      }
    }
    if (view && typeof view.snap === 'boolean') {
      Editor.snap = view.snap;
    }
    buildTabs();
    buildPalette();
    refreshLoadList();

    byId('craftName').value = Editor.name;
    byId('craftName').addEventListener('input', (event) => {
      Editor.name = event.target.value || 'Untitled';
      persist();
    });
    byId('launchButton').addEventListener('click', () => Editor.launch());
    byId('newButton').addEventListener('click', () => {
      Editor.name = 'Untitled';
      Editor.parts = [];
      Editor.selected = null;
      byId('craftName').value = Editor.name;
      Editor.fit();
      Editor.changed();
    });
    byId('saveButton').addEventListener('click', () => {
      const all = Flatspace.store.load('flatspace.crafts', {});
      all[Editor.name] = Flatspace.serialParts(Editor.parts);
      const saved = Flatspace.store.save('flatspace.crafts', all);
      refreshLoadList();
      showPartInfo(saved ? `Saved “${Editor.name}”.` : 'Could not save: browser storage is unavailable.');
    });
    byId('craftLoad').addEventListener('change', (event) => {
      const choice = event.target.value;
      if (!choice) {
        return;
      }
      const [kind, name] = choice.split('::');
      let parts = null;
      if (kind === 'sample') {
        parts = sampleParts(Flatspace.SAMPLE_CRAFT.find((craft) => craft.name === name));
      } else {
        const savedCraft = Flatspace.store.load('flatspace.crafts', {})[name];
        if (savedCraft) {
          parts = Flatspace.partsFromSerial(savedCraft);
        }
      }
      if (parts) {
        Editor.load(name, parts);
      }
      event.target.value = '';
    });
    const onClick = (elementId, handler) => byId(elementId).addEventListener('click', handler);
    onClick('fitButton', () => {
      Editor.fit();
      Editor.render();
    });
    onClick('rootButton', () => Editor.reroot(Editor.selected));
    onClick('deleteButton', () => Editor.remove(Editor.selected));
    onClick('undoButton', () => Editor.undo());
    onClick('redoButton', () => Editor.redo());
    onClick('mirrorButton', () => Editor.toggleMirror());
    onClick('rotateLeftButton', () => Editor.rotate(15 * RADIANS_PER_DEGREE));
    onClick('rotateRightButton', () => Editor.rotate(-15 * RADIANS_PER_DEGREE));
    onClick('flipButton', () => Editor.flip());
    onClick('offsetButton', () => {
      Editor.offsetMode = !Editor.offsetMode;
      showPartInfo(Editor.offsetMode ? 'Offset on: drag a side part to slide it along its parent.' : hint());
      Editor.render();
    });
    onClick('snapButton', () => {
      Editor.snap = !Editor.snap;
      saveView();
      showPartInfo(
        Editor.snap
          ? 'Snap on: offsets move in 0.25 m steps and catch the middle of a side.'
          : 'Snap off: offsets move freely.',
      );
      Editor.render();
    });
    onClick('copyButton', () => Editor.copy(Editor.selected));
    onClick('subassemblyButton', () => Editor.saveSubassembly(Editor.selected));
    onClick('settingsButton', () => {
      if (Editor.selected) {
        Flatspace.PartPanel.select(Editor.selected, 'editor');
        Editor.render();
      } else {
        showPartInfo('Select a part to see its settings.');
      }
    });
    onClick('filesButton', () => Flatspace.CraftFiles.open());
    Flatspace.PartPanel.initialise(Editor);
    Flatspace.CraftFiles.initialise();
    Flatspace.StagingEditor.initialise(Editor);
    for (const overlayName of ['centreOfMass', 'centreOfThrust', 'centreOfPressure']) {
      onClick('overlay-' + overlayName, () => {
        Editor.overlays[overlayName] = !Editor.overlays[overlayName];
        saveView();
        Editor.render();
      });
    }
    setUpPointer();
    window.addEventListener('keydown', onKey);
    Editor.changed();
  };

  function onKey(event) {
    if (game.scene !== 'editor' || event.target.tagName === 'INPUT' || event.target.tagName === 'SELECT') {
      return;
    }
    const key = event.key.toLowerCase();
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && key === 'z') {
      event.shiftKey ? Editor.redo() : Editor.undo();
      event.preventDefault();
      return;
    }
    if (modifier && key === 'y') {
      Editor.redo();
      event.preventDefault();
      return;
    }
    if (modifier) {
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && Editor.selected) {
      Editor.remove(Editor.selected);
      event.preventDefault();
    } else if (event.key === 'Escape') {
      if (Editor.drag) {
        Editor.cancelDrag();
      } else {
        Editor.selected = null;
        Editor.render();
      }
    } else if (event.key === 'Home') {
      Editor.fit();
      Editor.render();
    } else if (key === 'x') {
      Editor.toggleMirror();
    } else if (key === 'q' || key === 'e') {
      Editor.rotate((key === 'q' ? 1 : -1) * (event.shiftKey ? 5 : 15) * RADIANS_PER_DEGREE);
    } else if (key === 'f') {
      Editor.flip();
    }
  }

  // The craft proper is the root (the first part) and everything attached to it. Any other
  // tree is a floating part, left where it was dropped; its loose setting says whether it
  // launches with the craft at that spot ('keep') or is left behind ('drop', the default).
  Editor.main = () => (Editor.parts.length ? Flatspace.subtree(Editor.parts, Editor.parts[0]) : []);
  Editor.floating = () => {
    const mainSet = new Set(Editor.main());
    return Editor.parts.filter((part) => !mainSet.has(part));
  };
  // Keep the part list tidy: the root first; every other tree marked as floating.
  Editor.normalize = () => {
    if (!Editor.parts.length) {
      return;
    }
    let root = Editor.parts[0];
    while (root.parent && Editor.parts.includes(root.parent)) {
      root = root.parent;
    }
    if (root !== Editor.parts[0]) {
      Editor.parts = [root].concat(Editor.parts.filter((part) => part !== root));
    }
    delete root.loose;
    for (const part of Editor.parts) {
      if (part === root) {
        continue;
      }
      if (!part.parent || !Editor.parts.includes(part.parent)) {
        part.parent = null;
        if (!part.loose) {
          part.loose = 'drop';
        }
      } else {
        delete part.loose;
      }
    }
  };

  Editor.load = (name, parts) => {
    Editor.name = name;
    Editor.parts = parts;
    Editor.normalize();
    Editor.selected = null;
    byId('craftName').value = name;
    Editor.fit();
    Editor.changed();
  };

  function persist() {
    Flatspace.store.save('flatspace.current', {
      name: Editor.name,
      parts: Flatspace.serialParts(Editor.parts),
    });
  }
  function saveView() {
    Flatspace.store.set('flatspace.editorView', { overlays: Editor.overlays, snap: Editor.snap });
  }
  function showPartInfo(text) {
    byId('partInfo').textContent = text;
  }
  Editor.say = showPartInfo;
  Editor.refreshLoadList = () => refreshLoadList();
  const hint = () =>
    window.matchMedia && matchMedia('(pointer: coarse)').matches
      ? 'Drag or tap a part in the tray to add it. Hold a placed part to pick it up. Pinch to zoom.'
      : 'Drag parts from the tray. Drag a placed part to move it; drop it on the tray to remove it. Alt-drag slides a side part, Alt-click copies.';

  function refreshLoadList() {
    const select = byId('craftLoad');
    const saved = Flatspace.store.load('flatspace.crafts', {});
    let html = '<option value="">Load craft…</option><optgroup label="Sample craft">';
    for (const craft of Flatspace.SAMPLE_CRAFT) {
      html += `<option value="sample::${craft.name}">${craft.name}</option>`;
    }
    html += '</optgroup>';
    const names = Object.keys(saved);
    if (names.length) {
      html += '<optgroup label="Your craft">';
      for (const craftName of names) {
        html += `<option value="saved::${craftName.replace(/"/g, '&quot;')}">${craftName.replace(/</g, '&lt;')}</option>`;
      }
      html += '</optgroup>';
    }
    select.innerHTML = html;
  }

  // ---------- History ----------
  // Every change to the craft is kept (up to 100 steps back), so undo reverses anything.
  function record() {
    const state = JSON.stringify(Flatspace.serialParts(Editor.parts));
    if (state === Editor.history[Editor.historyIndex]) {
      return;
    }
    Editor.history = Editor.history.slice(0, Editor.historyIndex + 1);
    Editor.history.push(state);
    if (Editor.history.length > HISTORY + 1) {
      Editor.history.shift();
    }
    Editor.historyIndex = Editor.history.length - 1;
  }
  function restore(historyIndex) {
    if (Editor.drag) {
      Editor.cancelDrag();
    }
    Editor.historyIndex = historyIndex;
    Editor.parts = Flatspace.partsFromSerial(JSON.parse(Editor.history[historyIndex]));
    Editor.selected = null;
    persist();
    Flatspace.PartPanel.rebuildAll('editor', (part) => Editor.parts.includes(part));
    Editor.render();
    Editor.updateStats();
  }
  Editor.undo = () => {
    if (Editor.historyIndex > 0) {
      restore(Editor.historyIndex - 1);
      showPartInfo('Undone.');
    } else {
      showPartInfo('Nothing to undo.');
    }
  };
  Editor.redo = () => {
    if (Editor.historyIndex < Editor.history.length - 1) {
      restore(Editor.historyIndex + 1);
      showPartInfo('Redone.');
    } else {
      showPartInfo('Nothing to redo.');
    }
  };

  // ---------- Tray ----------
  function partSummary(partType) {
    if (partType.engine) {
      return `${(partType.engine.vacuumThrust / 1000).toFixed(0)} kN · Isp ${partType.engine.vacuumSpecificImpulse} s`;
    }
    if (partType.fuel) {
      return `${(partType.fuel / 1000).toFixed(partType.fuel < 1000 ? 2 : 1)} t fuel`;
    }
    if (partType.command) {
      return partType.crew
        ? `${partType.crew} crew · ${(partType.mass / 1000).toFixed(2)} t`
        : `probe · ${(partType.mass / 1000).toFixed(2)} t`;
    }
    return `${(partType.mass / 1000).toFixed(2)} t`;
  }

  function buildTabs() {
    const host = byId('paletteTabs');
    host.innerHTML = '';
    for (const category of Flatspace.PART_CATEGORIES.concat(SUBASSEMBLY_TAB)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'palette-tab';
      button.setAttribute('role', 'tab');
      button.textContent = category;
      button.addEventListener('click', () => {
        Editor.tab = category;
        buildPalette();
      });
      host.appendChild(button);
    }
  }

  function trayButton(label, subtitle, thumb) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'part-button';
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 88;
    thumbCanvas.height = 104;
    button.appendChild(thumbCanvas);
    const textSpan = document.createElement('span');
    textSpan.innerHTML = `<span class="part-name"></span><span class="part-stats"></span>`;
    textSpan.firstChild.textContent = label;
    textSpan.lastChild.textContent = subtitle;
    button.appendChild(textSpan);
    thumb(thumbCanvas);
    return button;
  }

  function hoverCard(button, show) {
    button.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'mouse' && !Editor.drag) {
        show();
      }
    });
    button.addEventListener('pointerleave', hideCard);
    button.addEventListener('focus', () => {
      try {
        if (button.matches(':focus-visible')) {
          show();
        }
      } catch (error) {
        /* no :focus-visible */
      }
    });
    button.addEventListener('blur', hideCard);
  }

  function buildPalette() {
    for (const tabButton of byId('paletteTabs').children) {
      tabButton.setAttribute('aria-selected', String(tabButton.textContent === Editor.tab));
    }
    const host = byId('palette');
    host.innerHTML = '';
    if (Editor.tab === SUBASSEMBLY_TAB) {
      if (!Editor.subassemblies.length) {
        const paragraph = document.createElement('p');
        paragraph.className = 'palette-empty';
        paragraph.textContent =
          'Select a part and press “Save sub” to keep it here, with everything attached below it, for reuse in any craft.';
        host.appendChild(paragraph);
      }
      Editor.subassemblies.forEach((subassembly, index) => {
        const parts = Flatspace.partsFromSerial(subassembly.parts);
        const mass = parts.reduce((sum, part) => sum + Flatspace.partMass(part), 0);
        const button = trayButton(
          subassembly.name,
          `${parts.length} part${parts.length > 1 ? 's' : ''} · ${(mass / 1000).toFixed(2)} t`,
          (thumbCanvas) => drawGroupThumb(thumbCanvas, parts),
        );
        button.dataset.subassemblyIndex = String(index);
        button.setAttribute('aria-label', `Subassembly ${subassembly.name}`);
        button.addEventListener('click', () => {
          if (suppressClick) {
            suppressClick = false;
            return;
          }
          showPartInfo('Drag a subassembly into the build area to add it.');
        });
        button.addEventListener('pointerdown', (event) => trayDown(event, { subassemblyIndex: index }));
        hoverCard(button, () =>
          showCard(button, subassembly.name, 'Saved subassembly', subassemblyRows(parts)),
        );
        const row = document.createElement('div');
        row.className = 'subassembly-row';
        row.appendChild(button);
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'subassembly-delete';
        deleteButton.textContent = '×';
        deleteButton.title = 'Delete this subassembly';
        deleteButton.setAttribute('aria-label', `Delete subassembly ${subassembly.name}`);
        deleteButton.addEventListener('click', () => {
          Editor.subassemblies.splice(index, 1);
          Flatspace.store.save('flatspace.subassemblies', Editor.subassemblies);
          buildPalette();
        });
        row.appendChild(deleteButton);
        host.appendChild(row);
      });
      return;
    }
    if (Editor.tab === 'Fuel') {
      // tank presets, grouped by width; each is a stretchable tank of its base type
      let width = null;
      Flatspace.DATA.tankPresets.forEach((preset, index) => {
        if (preset.size !== width) {
          width = preset.size;
          const heading = document.createElement('div');
          heading.className = 'palette-subassemblies';
          heading.textContent = `${width} m wide`;
          host.appendChild(heading);
        }
        const partType = Flatspace.PART[preset.base];
        const options = { length: preset.length, size: preset.size };
        const sample = Flatspace.newPart(preset.base, options);
        Flatspace.relayout([sample]);
        const button = trayButton(
          preset.name,
          `${(sample.fuelCapacity / 1000).toFixed(sample.fuelCapacity < 1000 ? 2 : 1)} t fuel · ${preset.length} × ${preset.size} m`,
          (thumbCanvas) => drawThumb(thumbCanvas, partType, sample),
        );
        button.dataset.preset = String(index);
        if (preset.length === partType.length && preset.size === partType.width) {
          button.dataset.part = partType.id;
        }
        button.setAttribute('aria-label', `${preset.name}: ${partType.description}`);
        button.addEventListener('click', () => {
          if (suppressClick) {
            suppressClick = false;
            return;
          }
          Editor.quickAdd(preset.base, options);
        });
        button.addEventListener('pointerdown', (event) => trayDown(event, { id: preset.base, options }));
        hoverCard(button, () =>
          showCard(
            button,
            preset.name,
            `${partType.description} Stretch it with the handle at its end, and change its width and look in its settings. (KSP: ${preset.kerbalEquivalent}.)`,
            cardRows(partType, sample),
          ),
        );
        host.appendChild(button);
      });
      return;
    }
    for (const partType of Flatspace.PARTS.filter((partType) => partType.category === Editor.tab)) {
      const button = trayButton(partType.name, partSummary(partType), (thumbCanvas) =>
        drawThumb(thumbCanvas, partType),
      );
      button.dataset.part = partType.id;
      button.setAttribute('aria-label', `${partType.name}: ${partType.description}`);
      button.addEventListener('click', () => {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        Editor.quickAdd(partType.id);
      });
      button.addEventListener('pointerdown', (event) => trayDown(event, partType.id));
      hoverCard(button, () => showCard(button, partType.name, partType.description, cardRows(partType)));
      host.appendChild(button);
    }
  }

  function drawThumb(thumbCanvas, partType, sample) {
    const graphics = thumbCanvas.getContext('2d');
    const part = sample || Flatspace.newPart(partType.id);
    Flatspace.relayout([part]);
    const scale = Math.min(
      70 / Math.max(part.width + (partType.fin && !partType.radial ? 1.6 : 0), 0.6),
      84 / part.length,
      60,
    );
    graphics.setTransform(scale, 0, 0, scale, 44, 52 - (part.length * scale) / 2);
    Flatspace.drawPart(graphics, part, 0, 1 / scale, {});
  }

  function drawGroupThumb(thumbCanvas, parts) {
    const graphics = thumbCanvas.getContext('2d');
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const part of parts) {
      for (const corner of Build.corners(part)) {
        minX = Math.min(minX, corner.x);
        maxX = Math.max(maxX, corner.x);
        minY = Math.min(minY, corner.y);
        maxY = Math.max(maxY, corner.y);
      }
    }
    const scale = Math.min(80 / Math.max(maxX - minX, 0.5), 96 / Math.max(maxY - minY, 0.5), 60);
    const centreX = (minX + maxX) / 2;
    const centreY = (minY + maxY) / 2;
    for (const part of parts) {
      graphics.setTransform(1, 0, 0, 1, 0, 0);
      graphics.translate(44 + (part.position.x - centreX) * scale, 52 - (part.position.y - centreY) * scale);
      graphics.scale(scale, scale);
      graphics.rotate(-part.rotation);
      if (part.flip) {
        graphics.scale(-1, 1);
      }
      Flatspace.drawPart(graphics, part, -part.length / 2, 1 / scale, {});
    }
  }

  // The hover card: everything the tray row has no room for.
  function cardRows(partType, part) {
    const rows = [];
    const tonnes = (kilograms) => (kilograms / 1000).toFixed(kilograms < 1000 ? 3 : 2) + ' t';
    const dryMass = part ? part.dry : partType.mass;
    const fuel = part ? part.fuelCapacity : partType.fuel || 0;
    const wetMass = dryMass + fuel + (partType.solid || 0);
    rows.push([
      'Mass',
      wetMass > dryMass ? `${tonnes(wetMass)} (${tonnes(dryMass)} empty)` : tonnes(dryMass),
    ]);
    rows.push([
      'Size',
      `${part ? part.length : partType.length} m long · ${partType.width === 'auto' ? 'fits its neighbours' : (part ? part.size : partType.width) + ' m wide'}`,
    ]);
    if (partType.engine) {
      const engine = partType.engine;
      rows.push([
        'Thrust',
        `${(engine.seaLevelThrust / 1000).toFixed(0)} kN sea level · ${(engine.vacuumThrust / 1000).toFixed(0)} kN vacuum`,
      ]);
      rows.push([
        'Isp',
        `${engine.seaLevelSpecificImpulse} s sea level · ${engine.vacuumSpecificImpulse} s vacuum`,
      ]);
      if (engine.solid) {
        rows.push([
          'Burn',
          `${(partType.solid / (engine.vacuumThrust / (engine.vacuumSpecificImpulse * Flatspace.STANDARD_GRAVITY))).toFixed(0)} s, cannot throttle`,
        ]);
      }
      rows.push(['Gimbal', engine.gimbal ? `±${engine.gimbal}°` : 'none']);
    }
    if (partType.fuel) {
      rows.push(['Fuel', tonnes(fuel)]);
    }
    if (partType.stretch) {
      rows.push(['Stretchable', `${Flatspace.LENGTH_STEP} m steps, ${Flatspace.TANK_WIDTHS.length} widths`]);
    }
    if (partType.torque) {
      rows.push(['Reaction wheel', `${(partType.torque / 1000).toFixed(0)} kN·m`]);
    }
    if (partType.chute) {
      rows.push(['Parachute', 'semi-deploys in thick air, opens fully below 1 km']);
    }
    if (partType.fin) {
      rows.push(['Fins', `${partType.fin} m² of side area`]);
    }
    rows.push(['Crash tolerance', `${partType.crash} m/s`]);
    rows.push([
      'Attaches',
      partType.radial
        ? 'to the side of a part'
        : Build.hasNode(partType, 'top')
          ? 'above, below or to a side'
          : 'on top of a part',
    ]);
    return rows;
  }
  function subassemblyRows(parts) {
    const count = {};
    parts.forEach((part) => (count[part.type.name] = (count[part.type.name] || 0) + 1));
    return Object.entries(count).map(([partName, count]) => [count + '×', partName]);
  }
  function showCard(button, title, description, rows) {
    const card = byId('partCard');
    card.innerHTML = '<h3></h3><p></p><dl></dl>';
    card.querySelector('h3').textContent = title;
    card.querySelector('p').textContent = description;
    card.querySelector('dl').innerHTML = rows
      .map(([label, value]) => `<dt>${label}</dt><dd>${String(value).replace(/</g, '&lt;')}</dd>`)
      .join('');
    card.hidden = false;
    const bounds = button.getBoundingClientRect();
    const cardWidth = card.offsetWidth || 280;
    const cardHeight = card.offsetHeight || 220;
    let cardX = bounds.right + 10;
    let cardY = bounds.top;
    if (cardX + cardWidth > innerWidth - 8) {
      cardX = Math.max(8, bounds.left);
      cardY = bounds.bottom + 8;
    }
    cardY = Math.max(8, Math.min(cardY, innerHeight - cardHeight - 8));
    card.style.left = cardX + 'px';
    card.style.top = cardY + 'px';
  }
  function hideCard() {
    const card = byId('partCard');
    if (card) {
      card.hidden = true;
    }
  }

  // ---------- Carrying parts ----------
  // All in craft-frame coordinates, so tests can drive them without a pointer.
  // held: the carried parts, root first. twin: the mirror twin the held parts were picked
  // up with (put back if the drop fails). mirror: whether the drop makes a mirror twin.
  function startDrag(held, root, grab, origin, pointerId, extra = {}) {
    hideCard();
    Editor.drag = Object.assign(
      {
        held,
        root,
        grab,
        origin,
        pointerId,
        candidate: null,
        block: null,
        valid: false,
        overTray: false,
        statKey: null,
        twin: null,
        ghostTwin: null,
        world: Vector.add(root.position, Vector.scale(grab, -1)),
      },
      extra,
    );
    Editor.drag.mirror = Editor.mirror || !!Editor.drag.twin;
  }

  // The angle the player has given a side part, as seen on the right-hand side.
  const spinOf = (part) => {
    if (part.node !== 'surface' || !part.parent) {
      return 0;
    }
    const left = part.surfaceOffset && part.surfaceOffset.x < 0;
    return (part.type.radial && left ? -1 : 1) * (part.relativeRotation || 0);
  };

  // Pick up a new part from the tray, centred on the pointer.
  Editor.pickNew = (partId, world, pointerId, options) => {
    const part = Flatspace.newPart(partId, options);
    if (!part) {
      return;
    }
    part.spin = 0;
    Flatspace.relayout([part]);
    startDrag([part], part, { x: 0, y: 0 }, null, pointerId);
    Editor.dragTo(world);
  };

  // Pick up a copy of a group of saved parts (a subassembly), root first.
  Editor.pickGroup = (serial, world, pointerId) => {
    const held = Build.clone(Flatspace.partsFromSerial(serial));
    if (!held.length) {
      return;
    }
    for (const part of held) {
      delete part.stage;
    } // the craft's own staging decides
    held[0].spin = 0;
    startDrag(held, held[0], { x: 0, y: 0 }, null, pointerId);
    Editor.dragTo(world);
  };

  // Pick up a placed part, with everything attached below it (and its mirror twin, if any).
  Editor.pickPart = (part, world, pointerId) => {
    const held = Flatspace.subtree(Editor.parts, part);
    const set = new Set(held);
    const twinPart = Build.twinOf(Editor.parts, part);
    let twin = null;
    if (twinPart && !set.has(twinPart)) {
      const twinTree = Flatspace.subtree(Editor.parts, twinPart);
      twinTree.forEach((part) => set.add(part));
      twin = { held: twinTree, root: twinPart, origin: poseOf(twinPart) };
    }
    const origin = poseOf(part);
    const isMain = part === Editor.parts[0];
    part.spin = spinOf(part);
    Editor.parts = Editor.parts.filter((part) => !set.has(part));
    part.parent = null;
    if (part.type.radial) {
      part.flip = false;
    }
    Flatspace.relayout(Editor.parts);
    Flatspace.relayout(held);
    startDrag(held, part, Vector.subtract(part.position, world), origin, pointerId, { twin, isMain });
    Editor.selected = part;
    Editor.dragTo(world);
  };

  const poseOf = (part) => ({
    parent: part.parent,
    node: part.node,
    position: { ...part.position },
    rotation: part.rotation,
    flip: part.flip,
    surfaceOffset: part.surfaceOffset && { ...part.surfaceOffset },
    relativeRotation: part.relativeRotation,
    loose: part.loose,
  });

  // Carry a copy of a placed part and everything below it (Alt-click, or the Copy button).
  // The copy follows the pointer without a button held and drops on the next click or tap.
  Editor.copy = (part, world) => {
    if (Editor.drag) {
      return;
    }
    if (!part || !Editor.parts.includes(part)) {
      showPartInfo('Select a part to copy it, with everything attached below it.');
      return;
    }
    const held = Build.clone(Flatspace.subtree(Editor.parts, part));
    const root = held[0];
    root.spin = spinOf(part);
    if (root.type.radial) {
      root.flip = false;
    }
    const spot = world || Vector.add(part.position, { x: Math.max(part.width, part.topWidth) + 1, y: 0 });
    startDrag(held, root, { x: 0, y: 0 }, null, 'carry');
    Editor.dragTo(spot);
    showPartInfo(
      `Copy of the ${part.type.name}${held.length > 1 ? ` and ${held.length - 1} more` : ''}: click or tap where it should go. Esc cancels.`,
    );
  };

  Editor.dragTo = (world, toTray = false) => {
    const drag = Editor.drag;
    if (!drag) {
      return;
    }
    drag.world = world;
    drag.overTray = toTray;
    drag.mirror = Editor.mirror || !!drag.twin;
    const free = Vector.add(world, drag.grab);
    Build.placeHeld(drag.held, drag.root, free);
    drag.candidate = toTray
      ? null
      : Build.candidate(
          Editor.parts,
          drag.held,
          drag.root,
          free,
          SNAP_PIXELS / Editor.camera.scale,
          drag.mirror,
        );
    // the whole craft can be moved anywhere
    if (!drag.candidate && !toTray && drag.isMain) {
      drag.candidate = {
        kind: 'root',
        parent: null,
        position: { ...free },
        rotation: drag.root.spin || 0,
        distance: 0,
      };
    }
    drag.block = drag.candidate
      ? Build.blocker(Editor.parts, drag.held, drag.root, drag.candidate, drag.mirror)
      : null;
    // nothing to attach to: it can be left floating here, if it overlaps nothing
    drag.loose = false;
    if (!drag.candidate && !toTray) {
      Build.placeHeld(drag.held, drag.root, free);
      drag.block =
        Editor.parts.find((part) => drag.held.some((heldPart) => Build.overlap(heldPart, part))) || null;
      drag.loose = !drag.block;
    }
    drag.valid = (!!drag.candidate && !drag.block) || drag.loose;
    if (drag.loose || (drag.candidate && drag.candidate.kind === 'root')) {
      Build.placeHeld(drag.held, drag.root, free);
    }
    // the mirror twin's ghost, and live stats for the craft as it would be if dropped here
    drag.ghostTwin = null;
    const key = drag.loose
      ? 'loose'
      : drag.valid
        ? `${drag.candidate.kind}:${drag.candidate.parent ? drag.candidate.parent.uniqueId : 0}:${drag.candidate.side || 0}:${drag.candidate.position.y.toFixed(2)}:${drag.candidate.rotation.toFixed(3)}:${drag.mirror}`
        : 'none';
    if (drag.valid && drag.candidate) {
      const line = drag.mirror
        ? Build.mirrorFor(Editor.parts, drag.candidate.parent, drag.candidate.kind)
        : null;
      let all = Build.attach(Editor.parts, drag.held, drag.root, drag.candidate);
      if (line) {
        drag.ghostTwin = Build.makeTwin(drag.held, line, drag.candidate.kind);
        all = all.concat(drag.ghostTwin);
        Flatspace.relayout(all);
      }
      // the craft it would be part of: the main craft, unless it is dropped onto a floating part
      let root = drag.isMain ? drag.root : all[0];
      while (root.parent) {
        root = root.parent;
      }
      drag.joinsMain = drag.isMain || root === Editor.parts[0];
      if (key !== drag.statKey) {
        Editor.updateStats(Flatspace.subtree(all, root));
      }
      Build.detach(Editor.parts, drag.held, drag.root);
    } else if (key !== drag.statKey) {
      Editor.updateStats(Editor.main());
    }
    drag.statKey = key;
    const tray = document.querySelector('#editor .palette');
    if (tray) {
      tray.classList.toggle('drop-remove', toTray);
    }
    if (toTray) {
      showPartInfo(`Release to remove ${drag.held.length > 1 || drag.twin ? 'these parts' : 'this part'}.`);
    } else if (drag.block) {
      showPartInfo(`Can't go there: it would overlap the ${drag.block.type.name}.`);
    } else if (drag.loose) {
      showPartInfo(
        'Release to leave it floating here. Its settings say whether it launches with the craft or stays behind.',
      );
    } else if (!drag.candidate) {
      showPartInfo('Bring it next to an attach point or the side of a part.');
    } else {
      showPartInfo(
        `${drag.root.type.name}: release to attach${drag.candidate.kind === 'surface' ? ' to the side of the ' + drag.candidate.parent.type.name : drag.candidate.parent ? ' to the ' + drag.candidate.parent.type.name : ''}${drag.ghostTwin ? ', with a mirror twin' : ''}.`,
      );
    }
    Editor.render();
  };

  // Attach held parts as candidate, with a mirror twin if asked and possible.
  function place(held, root, candidate, mirror) {
    const line = mirror ? Build.mirrorFor(Editor.parts, candidate.parent, candidate.kind) : null;
    Editor.parts = Build.attach(Editor.parts, held, root, candidate);
    const set = new Set(held);
    if (line) {
      const twin = Build.makeTwin(held, line, candidate.kind);
      Build.linkTwins(held, twin);
      Editor.parts = Editor.parts.concat(twin);
      Flatspace.relayout(Editor.parts);
    } else {
      // keep mirror links inside the group; drop links to twins left behind
      for (const heldPart of held) {
        if (
          heldPart.symmetryGroup &&
          !held.some((other) => other !== heldPart && other.symmetryGroup === heldPart.symmetryGroup)
        ) {
          delete heldPart.symmetryGroup;
        }
      }
    }
    for (const heldPart of held) {
      delete heldPart.spin;
    }
    return set;
  }

  // Let go of the carried parts.
  Editor.drop = () => {
    const drag = Editor.drag;
    if (!drag) {
      return;
    }
    Editor.drag = null;
    const tray = document.querySelector('#editor .palette');
    if (tray) {
      tray.classList.remove('drop-remove');
    }
    if (drag.overTray) {
      if (drag.held.includes(Editor.selected)) {
        Editor.selected = null;
      }
      Editor.changed();
      showPartInfo(
        drag.origin ? `Removed ${drag.held.length + (drag.twin ? drag.twin.held.length : 0)} parts.` : hint(),
      );
      return;
    }
    if (drag.valid && drag.loose) {
      // left floating where it was dropped
      drag.root.parent = null;
      drag.root.loose = drag.root.loose || 'drop';
      for (const heldPart of drag.held) {
        delete heldPart.spin;
        if (
          heldPart.symmetryGroup &&
          !drag.held.some((other) => other !== heldPart && other.symmetryGroup === heldPart.symmetryGroup)
        ) {
          delete heldPart.symmetryGroup;
        }
      }
      Editor.parts = Editor.parts.concat(drag.held);
      Flatspace.relayout(Editor.parts);
      Editor.selected = drag.root;
      Editor.changed();
      showPartInfo(
        `Floating ${drag.root.type.name}: it ${drag.root.loose === 'keep' ? 'launches with the craft' : 'is left behind at launch'}. Change that in its settings.`,
      );
      return;
    }
    if (drag.valid) {
      place(drag.held, drag.root, drag.candidate, drag.mirror);
      if (drag.isMain) {
        let root = drag.root;
        while (root.parent) {
          root = root.parent;
        }
        Editor.parts = [root].concat(Editor.parts.filter((part) => part !== root));
      }
      Editor.selected = drag.root;
      Editor.changed();
      showPartInfo(`${drag.root.type.name}: ${drag.root.type.description}`);
      return;
    }
    putBack(drag);
    Editor.changed();
    showPartInfo(
      drag.origin
        ? "Can't attach there, so it went back where it was."
        : "Can't attach there, so it went back to the tray.",
    );
  };

  Editor.cancelDrag = () => {
    const drag = Editor.drag;
    if (!drag) {
      return;
    }
    Editor.drag = null;
    const tray = document.querySelector('#editor .palette');
    if (tray) {
      tray.classList.remove('drop-remove');
    }
    putBack(drag);
    Editor.changed();
    showPartInfo(hint());
  };

  function putBack(drag) {
    if (!drag.origin) {
      return;
    } // a new part or a copy simply goes away
    const back = (part, origin) => {
      Object.assign(part, {
        parent: origin.parent,
        node: origin.node,
        position: origin.position,
        rotation: origin.rotation,
        flip: origin.flip,
      });
      if (origin.surfaceOffset) {
        part.surfaceOffset = origin.surfaceOffset;
        part.relativeRotation = origin.relativeRotation;
      } else {
        delete part.surfaceOffset;
        delete part.relativeRotation;
      }
      delete part.spin;
    };
    back(drag.root, drag.origin);
    let all = Editor.parts.concat(drag.held);
    if (drag.twin) {
      back(drag.twin.root, drag.twin.origin);
      all = all.concat(drag.twin.held);
    }
    if (drag.isMain) {
      all = drag.held.concat(all.filter((part) => !drag.held.includes(part)));
    }
    if (drag.origin.loose) {
      drag.root.loose = drag.origin.loose;
    }
    Editor.parts = all;
    Flatspace.relayout(Editor.parts);
  }

  // Click or tap on a tray part (and the keyboard): attach it somewhere sensible without dragging.
  Editor.quickAdd = (partId, options) => {
    if (Editor.drag) {
      return;
    }
    const part = Flatspace.newPart(partId, options);
    if (!part) {
      return;
    }
    Flatspace.relayout([part]);
    const held = [part];
    const tryCandidate = (candidate) =>
      candidate && !Build.blocker(Editor.parts, held, part, candidate, Editor.mirror) ? candidate : null;
    let chosenCandidate = null;
    const wasEmpty = !Editor.parts.length;
    if (wasEmpty) {
      chosenCandidate = { kind: 'root', parent: null, position: { x: 0, y: 0 }, rotation: 0 };
    } else if (part.type.radial) {
      const base =
        Editor.selected && Editor.parts.includes(Editor.selected) && Build.takesSurface(Editor.selected.type)
          ? Editor.selected
          : null;
      for (const side of [1, -1]) {
        if (chosenCandidate || !base) {
          break;
        }
        const spot = Vector.add(
          base.position,
          Flatspace.rotateVector(
            { x: side * (Math.max(base.width, base.topWidth) / 2 + part.width / 2), y: 0 },
            base.rotation,
          ),
        );
        const candidate = Build.candidate([base], held, part, spot, 0.01);
        chosenCandidate = tryCandidate(candidate && candidate.kind === 'surface' ? candidate : null);
      }
      if (!chosenCandidate) {
        showPartInfo(
          `Select a tank or other part first, then add the ${part.type.name} to its side (or drag it there).`,
        );
        return;
      }
    } else {
      // below the selected part if it has room, otherwise at the lowest free node (or the highest, for a parachute)
      const nodes = Build.freeNodes(Editor.parts).filter((freeNode) =>
        Build.hasNode(part.type, freeNode.node === 'bottom' ? 'top' : 'bottom'),
      );
      nodes.sort(
        (first, second) =>
          (first.part === Editor.selected) - (second.part === Editor.selected) ||
          (part.type.chute ? first.position.y - second.position.y : second.position.y - first.position.y),
      );
      while (!chosenCandidate && nodes.length) {
        const freeNode = nodes.pop();
        const axis = Flatspace.partAxis(freeNode.part.rotation);
        const spot = Vector.add(
          freeNode.position,
          Vector.scale(axis, ((freeNode.node === 'top' ? 1 : -1) * part.length) / 2),
        );
        const candidate = Build.candidate([freeNode.part], held, part, spot, 0.05);
        chosenCandidate = tryCandidate(candidate && candidate.parent === freeNode.part ? candidate : null);
      }
      if (!chosenCandidate) {
        showPartInfo(
          `No free attach point for the ${part.type.name}. Drag it onto the side of a part instead.`,
        );
        return;
      }
    }
    place(held, part, chosenCandidate, Editor.mirror);
    Editor.selected = part;
    if (wasEmpty || !inView(part)) {
      Editor.fit();
    }
    Editor.changed();
    showPartInfo(`${part.type.name}: ${part.type.description}`);
  };

  // Remove a part, everything below it, and its mirror twin.
  Editor.remove = (part) => {
    if (!part || !Editor.parts.includes(part)) {
      return;
    }
    const gone = new Set(Flatspace.subtree(Editor.parts, part));
    const twin = Build.twinOf(Editor.parts, part);
    if (twin) {
      Flatspace.subtree(Editor.parts, twin).forEach((part) => gone.add(part));
    }
    Editor.parts = Editor.parts.filter((part) => !gone.has(part));
    Editor.selected = part.parent && Editor.parts.includes(part.parent) ? part.parent : null;
    Flatspace.relayout(Editor.parts);
    Editor.changed();
    showPartInfo(`Removed ${gone.size} part${gone.size > 1 ? 's' : ''}.`);
  };

  // Stretch goal of A2: make the selected part the root.
  Editor.reroot = (part) => {
    if (!part || !Editor.parts.includes(part) || !part.parent) {
      return;
    }
    Build.reroot(Editor.parts, part);
    Editor.changed();
    showPartInfo(`The ${part.type.name} is now the root part.`);
  };

  // ---------- Precision tools ----------
  Editor.toggleMirror = () => {
    Editor.mirror = !Editor.mirror;
    showPartInfo(
      Editor.mirror ? 'Mirror on: parts on the side of a part come in mirrored pairs.' : 'Mirror off.',
    );
    if (Editor.drag) {
      Editor.dragTo(Editor.drag.world, Editor.drag.overTray);
    } else {
      Editor.render();
    }
  };

  // Turn the carried part, or the selected side part, by a (radians, counter-clockwise).
  Editor.rotate = (angle) => {
    if (Editor.drag) {
      Editor.drag.root.spin = (Editor.drag.root.spin || 0) + angle;
      Editor.dragTo(Editor.drag.world, Editor.drag.overTray);
      return;
    }
    const part = Editor.selected && Editor.parts.includes(Editor.selected) ? Editor.selected : null;
    if (!part) {
      showPartInfo('Select a side part (or carry a part) to rotate it.');
      return;
    }
    if (part.node !== 'surface') {
      showPartInfo('Only side parts turn: stack parts line up with the part they sit on.');
      return;
    }
    const hit = Build.moveOnSurface(Editor.parts, part, Build.surfaceHeight(part), part.rotation + angle);
    if (hit) {
      showPartInfo(`Can't turn it that far: it would hit the ${hit.type.name}.`);
      return;
    }
    Editor.changed();
    showPartInfo(`${part.type.name} at ${Math.round(spinOf(part) / RADIANS_PER_DEGREE)}°.`);
  };

  // Mirror the carried part, or the selected part, left to right.
  Editor.flip = () => {
    const part = Editor.drag
      ? Editor.drag.root
      : Editor.selected && Editor.parts.includes(Editor.selected)
        ? Editor.selected
        : null;
    if (!part) {
      showPartInfo('Select a part (or carry one) to flip it.');
      return;
    }
    if (part.type.radial) {
      showPartInfo(`The ${part.type.name} always faces away from the part it is on.`);
      return;
    }
    part.flip = !part.flip;
    if (Editor.drag) {
      Editor.dragTo(Editor.drag.world, Editor.drag.overTray);
      return;
    }
    Build.syncTwin(Editor.parts, part);
    Editor.changed();
  };

  // Slide a side part along its parent to height alongY (snapped if snap is on).
  Editor.offsetTo = (part, alongY) => {
    if (Editor.snap) {
      alongY = Math.abs(alongY) < 0.15 ? 0 : Math.round(alongY * 4) / 4;
    } else {
      alongY = Math.round(alongY * 100) / 100;
    }
    const hit = Build.moveOnSurface(Editor.parts, part, alongY, part.rotation);
    if (hit) {
      showPartInfo(`Can't slide further: the ${hit.type.name} is in the way.`);
    } else {
      showPartInfo(
        `${part.type.name}: ${alongY >= 0 ? '+' : ''}${alongY.toFixed(2)} m from the middle of the ${part.parent.type.name}.`,
      );
    }
    return !hit;
  };

  // Keep the selected part, with everything below it, as a subassembly in the tray.
  Editor.saveSubassembly = (part) => {
    if (!part || !Editor.parts.includes(part)) {
      showPartInfo('Select a part to save it, with everything attached below it, as a subassembly.');
      return;
    }
    const group = Flatspace.subtree(Editor.parts, part);
    let name = part.type.name + (group.length > 1 ? ` + ${group.length - 1}` : '');
    const taken = new Set(Editor.subassemblies.map((subassembly) => subassembly.name));
    for (let copyNumber = 2; taken.has(name); copyNumber++) {
      name = `${part.type.name}${group.length > 1 ? ` + ${group.length - 1}` : ''} (${copyNumber})`;
    }
    const serial = Flatspace.serialParts(group);
    for (const serialPart of serial) {
      delete serialPart.stage;
    }
    serial[0].parent = -1;
    serial[0].node = 'bottom';
    Editor.subassemblies.push({ name, parts: serial });
    const saved = Flatspace.store.save('flatspace.subassemblies', Editor.subassemblies);
    Editor.tab = SUBASSEMBLY_TAB;
    buildPalette();
    showPartInfo(
      saved
        ? `Saved “${name}” to Subassemblies in the tray.`
        : 'Could not save: browser storage is unavailable.',
    );
  };

  // ---------- Tank size and part settings (A4) ----------
  // Pairs of parts that overlap (ignoring each part and its own parent).
  function overlaps(parts) {
    let count = 0;
    for (let first = 0; first < parts.length; first++) {
      for (let second = first + 1; second < parts.length; second++) {
        const partA = parts[first];
        const partB = parts[second];
        if (partA.parent === partB || partB.parent === partA) {
          continue;
        }
        if (Build.overlap(partA, partB)) {
          count++;
        }
      }
    }
    return count;
  }
  const snapshot = (parts) =>
    parts.map((part) => ({
      part,
      length: part.length,
      size: part.size,
      position: { ...part.position },
      rotation: part.rotation,
      flip: part.flip,
      surfaceOffset: part.surfaceOffset && { ...part.surfaceOffset },
      relativeRotation: part.relativeRotation,
    }));
  function restoreSnap(snap) {
    for (const saved of snap) {
      Object.assign(saved.part, {
        length: saved.length,
        size: saved.size,
        position: saved.position,
        rotation: saved.rotation,
        flip: saved.flip,
        surfaceOffset: saved.surfaceOffset,
        relativeRotation: saved.relativeRotation,
      });
      Flatspace.applySize(saved.part);
    }
    Flatspace.relayout(Editor.parts);
  }

  // Where the selected tank's stretch handle is: its free end (away from its parent).
  function handleOf(part) {
    if (!part || !part.type.stretch || !Editor.parts.includes(part) || Editor.drag) {
      return null;
    }
    const axis = Flatspace.partAxis(part.rotation);
    const sign = part.node === 'top' && part.parent ? 1 : -1;
    const direction = Vector.scale(axis, sign);
    return {
      position: Vector.add(
        part.position,
        Vector.scale(direction, part.length / 2 + 10 / Editor.camera.scale),
      ),
      direction,
    };
  }

  // Change a tank's length or width, keeping the end it is attached by in place; side parts
  // on it stay on its surface; its mirror twin changes too. Refused if it would make parts
  // overlap. record: add an undo step now (a handle drag records once, when let go).
  function resize(part, change, record) {
    if (!part || !part.type.stretch) {
      return false;
    }
    const twin = Build.twinOf(Editor.parts, part);
    const snap = snapshot(Editor.parts);
    const before = overlaps(Editor.parts);
    const apply = (target) => {
      const axis = Flatspace.partAxis(target.rotation);
      const freeTop = target.node === 'top' && target.parent;
      const fixed = Vector.add(target.position, Vector.scale(axis, ((freeTop ? -1 : 1) * target.length) / 2)); // the end that stays put
      change(target);
      Flatspace.applySize(target);
      if (!target.parent || target.node === 'surface') {
        target.position = Vector.subtract(
          fixed,
          Vector.scale(axis, ((freeTop ? -1 : 1) * target.length) / 2),
        );
        Flatspace.syncOffsets([target]);
      }
      Flatspace.relayout(Editor.parts);
      // keep side parts on the (maybe wider) surface
      for (const child of Editor.parts.filter(
        (child) => child.parent === target && child.node === 'surface',
      )) {
        const side = child.surfaceOffset.x < 0 ? -1 : 1;
        const spot = Build.surfaceSpot(target, child, side, child.surfaceOffset.y, child.rotation);
        child.position = spot.position;
        Flatspace.syncOffsets([child]);
      }
      Flatspace.relayout(Editor.parts);
    };
    apply(part);
    if (twin) {
      apply(twin);
      Build.syncTwin(Editor.parts, part);
    }
    if (overlaps(Editor.parts) > before) {
      restoreSnap(snap);
      showPartInfo(`The ${part.type.name} can't grow there: it would run into another part.`);
      Editor.render();
      return false;
    }
    if (record) {
      Editor.changed();
    } else {
      Editor.render();
      Editor.updateStats();
    }
    showPartInfo(
      `${part.type.name}: ${part.length} m long, ${part.size} m wide, ${(part.fuelCapacity / 1000).toFixed(2)} t of fuel.`,
    );
    return true;
  }
  Editor.setLength = (part, newLength, record = true) =>
    resize(
      part,
      (target) => (target.length = Math.round(newLength / Flatspace.LENGTH_STEP) * Flatspace.LENGTH_STEP),
      record,
    );
  Editor.setWidth = (part, size, record = true) => resize(part, (target) => (target.size = size), record);

  // Set one of a part's settings (and its twin's), e.g. Editor.setSetting(part, 'limit', 0.5).
  Editor.setSetting = (part, key, value, record = true) => {
    if (!part || !Editor.parts.includes(part)) {
      return;
    }
    for (const target of [part, Build.twinOf(Editor.parts, part)].filter(Boolean)) {
      target[key] = value;
      if (key === 'fill') {
        Flatspace.applySize(target);
      }
    }
    if (record) {
      Editor.changed();
    } else {
      Editor.render();
      Editor.updateStats();
    }
  };

  // ---------- Pointer and touch ----------
  let suppressClick = false;
  let trayPress = null;

  function trayDown(event, what) {
    if (event.button !== 0 || Editor.drag) {
      return;
    }
    suppressClick = false;
    trayPress = {
      what,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      touch: event.pointerType !== 'mouse',
      last: event,
      timer: null,
    };
    if (trayPress.touch) {
      trayPress.timer = setTimeout(() => startTrayDrag(), LONG_PRESS);
    }
  }
  function startTrayDrag() {
    const press = trayPress;
    if (!press) {
      return;
    }
    clearTimeout(press.timer);
    trayPress = null;
    suppressClick = true;
    if (press.touch && navigator.vibrate) {
      navigator.vibrate(12);
    }
    if (typeof press.what === 'string') {
      Editor.pickNew(press.what, worldOf(press.last), press.pointerId);
    } else if (press.what.id) {
      Editor.pickNew(press.what.id, worldOf(press.last), press.pointerId, press.what.options);
    } else {
      Editor.pickGroup(
        Editor.subassemblies[press.what.subassemblyIndex].parts,
        worldOf(press.last),
        press.pointerId,
      );
    }
    Editor.dragTo(worldOf(press.last), overTray(press.last));
  }

  const pointers = new Map();
  let gesture = null;

  function setUpPointer() {
    canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      // right-click a part: its settings
      const point = canvasPoint(event);
      const hit = Build.partAt(Editor.parts, Editor.toWorld(point.x, point.y), 3 / Editor.camera.scale);
      if (hit && !Editor.drag) {
        Editor.selected = hit;
        Flatspace.PartPanel.select(hit, 'editor');
        Editor.render();
      }
    });
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const point = canvasPoint(event);
        zoomAt(point, Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0015)));
      },
      { passive: false },
    );

    canvas.addEventListener('pointerdown', (event) => {
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch (error) {
        /* old browsers */
      }
      const point = canvasPoint(event);
      pointers.set(event.pointerId, point);
      if (Editor.drag) {
        return;
      }
      if (gesture && gesture.timer) {
        clearTimeout(gesture.timer);
      }
      if (pointers.size === 2) {
        const [firstPointer, secondPointer] = [...pointers.values()];
        const midpoint = {
          x: (firstPointer.x + secondPointer.x) / 2,
          y: (firstPointer.y + secondPointer.y) / 2,
        };
        gesture = {
          type: 'pinch',
          startDistance: Math.hypot(firstPointer.x - secondPointer.x, firstPointer.y - secondPointer.y) || 1,
          startScale: Editor.camera.scale,
          anchor: Editor.toWorld(midpoint.x, midpoint.y),
        };
        return;
      }
      if (pointers.size > 2) {
        return;
      }
      if (event.button === 1 || event.button === 2) {
        event.preventDefault();
        gesture = { type: 'pan', last: point };
        return;
      }
      const touch = event.pointerType !== 'mouse';
      // the stretch handle of the selected tank comes first
      const handle = handleOf(Editor.selected);
      if (handle && event.button === 0) {
        const handleScreen = Editor.toScreen(handle.position);
        if (Math.hypot(handleScreen.x - point.x, handleScreen.y - point.y) < (touch ? 22 : 12)) {
          gesture = {
            type: 'stretch',
            part: Editor.selected,
            startLength: Editor.selected.length,
            startWidth: Editor.toWorld(point.x, point.y),
            direction: handle.direction,
          };
          return;
        }
      }
      const hit = Build.partAt(
        Editor.parts,
        Editor.toWorld(point.x, point.y),
        (touch ? 10 : 3) / Editor.camera.scale,
      );
      gesture = {
        type: 'press',
        id: event.pointerId,
        start: point,
        last: point,
        hitPart: hit,
        touch,
        altHeld: event.altKey,
        timer: null,
        wasSelected: hit && hit === Editor.selected,
      };
      if (touch && hit && !Editor.offsetMode) {
        const startGesture = gesture;
        startGesture.timer = setTimeout(() => {
          if (gesture !== startGesture || Editor.drag) {
            return;
          }
          if (navigator.vibrate) {
            navigator.vibrate(12);
          }
          Editor.pickPart(hit, Editor.toWorld(startGesture.start.x, startGesture.start.y), startGesture.id);
          Editor.dragTo(Editor.toWorld(startGesture.last.x, startGesture.last.y));
          gesture = { type: 'drag' };
        }, LONG_PRESS);
      }
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!pointers.has(event.pointerId)) {
        return;
      }
      const point = canvasPoint(event);
      pointers.set(event.pointerId, point);
      if (Editor.drag || !gesture) {
        return;
      }
      if (gesture.type === 'pinch' && pointers.size >= 2) {
        const [firstPointer, secondPointer] = [...pointers.values()];
        const midpoint = {
          x: (firstPointer.x + secondPointer.x) / 2,
          y: (firstPointer.y + secondPointer.y) / 2,
        };
        Editor.camera.scale = Flatspace.clamp(
          (gesture.startScale *
            Math.hypot(firstPointer.x - secondPointer.x, firstPointer.y - secondPointer.y)) /
            gesture.startDistance,
          3,
          240,
        );
        // keep the point that was under the fingers under them
        Editor.camera.x = gesture.anchor.x - (midpoint.x - viewWidth / 2) / Editor.camera.scale;
        Editor.camera.y = gesture.anchor.y + (midpoint.y - viewHeight / 2) / Editor.camera.scale;
        Editor.render();
      } else if (gesture.type === 'pan') {
        Editor.camera.x -= (point.x - gesture.last.x) / Editor.camera.scale;
        Editor.camera.y += (point.y - gesture.last.y) / Editor.camera.scale;
        gesture.last = point;
        Editor.render();
      } else if (gesture.type === 'offset') {
        slide(point);
      } else if (gesture.type === 'stretch') {
        const world = Editor.toWorld(point.x, point.y);
        const newLength =
          gesture.startLength + Vector.dot(Vector.subtract(world, gesture.startWidth), gesture.direction);
        Editor.setLength(gesture.part, newLength, false);
      } else if (gesture.type === 'press' && event.pointerId === gesture.id) {
        gesture.last = point;
        const moved = Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y);
        if (moved > (gesture.touch ? 9 : 4)) {
          clearTimeout(gesture.timer);
          const hit = gesture.hitPart;
          if (hit && (gesture.altHeld || Editor.offsetMode) && hit.node === 'surface') {
            // Alt-drag (or offset mode): slide the side part along its parent
            const startWorld = Editor.toWorld(gesture.start.x, gesture.start.y);
            const grabLy =
              Vector.dot(
                Vector.subtract(startWorld, hit.parent.position),
                Flatspace.partAxis(hit.parent.rotation),
              ) - Build.surfaceHeight(hit);
            Editor.selected = hit;
            gesture = { type: 'offset', part: hit, grabLy };
            slide(point);
          } else if (hit && gesture.altHeld && !gesture.touch) {
            // Alt-drag on any other part: drag a copy
            Editor.copy(hit, Editor.toWorld(point.x, point.y));
            if (Editor.drag) {
              Editor.drag.pointerId = event.pointerId;
            }
            gesture = { type: 'drag' };
          } else if (hit && !gesture.touch && !Editor.offsetMode) {
            Editor.pickPart(hit, Editor.toWorld(gesture.start.x, gesture.start.y), event.pointerId);
            Editor.dragTo(Editor.toWorld(point.x, point.y));
            gesture = { type: 'drag' };
          } else {
            if (hit && Editor.offsetMode) {
              showPartInfo('Offset slides side parts along their parent. Turn Offset off to move this part.');
            }
            gesture = { type: 'pan', last: gesture.start };
            Editor.camera.x -= (point.x - gesture.last.x) / Editor.camera.scale;
            Editor.camera.y += (point.y - gesture.last.y) / Editor.camera.scale;
            gesture.last = point;
            Editor.render();
          }
        }
      }
    });

    function slide(point) {
      const world = Editor.toWorld(point.x, point.y);
      const part = gesture.part;
      const alongY =
        Vector.dot(Vector.subtract(world, part.parent.position), Flatspace.partAxis(part.parent.rotation)) -
        gesture.grabLy;
      Editor.offsetTo(part, alongY);
      Editor.render();
      Editor.updateStats();
    }

    const end = (event) => {
      if (!pointers.has(event.pointerId)) {
        return;
      }
      pointers.delete(event.pointerId);
      if (!gesture) {
        return;
      }
      if (gesture.timer) {
        clearTimeout(gesture.timer);
      }
      if (gesture.type === 'press' && event.type === 'pointerup' && event.pointerId === gesture.id) {
        if (gesture.altHeld && gesture.hitPart) {
          Editor.copy(gesture.hitPart, Editor.toWorld(gesture.last.x, gesture.last.y));
        } // Alt-click: copy
        else {
          Editor.selected = gesture.hitPart;
          showPartInfo(
            Editor.selected ? `${Editor.selected.type.name}: ${Editor.selected.type.description}` : hint(),
          );
          // selecting a part opens its settings pop-up (unpinned ones give way)
          Flatspace.PartPanel.select(Editor.selected, 'editor');
          Editor.render();
        }
        gesture = null;
      } else if (gesture.type === 'stretch') {
        gesture = null;
        Editor.changed();
      } else if (gesture.type === 'offset') {
        gesture = null;
        Editor.changed();
      } else if (gesture.type === 'pinch') {
        // the finger left on the glass carries on panning without a jump
        gesture = pointers.size === 1 ? { type: 'pan', last: [...pointers.values()][0] } : null;
      } else if (!pointers.size) {
        gesture = null;
      }
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    // A copy being carried without a button held drops on the next click or tap.
    window.addEventListener(
      'pointerdown',
      (event) => {
        if (!Editor.drag || Editor.drag.pointerId !== 'carry') {
          return;
        }
        if (event.target.closest && event.target.closest('.hangar-tools, .tool-rail, .overlay-chips')) {
          return;
        }
        if (!inside(canvas, event) && !overTray(event)) {
          return;
        }
        event.stopPropagation();
        event.preventDefault();
        suppressClick = true;
        Editor.dragTo(worldOf(event), overTray(event));
        Editor.drop();
        setTimeout(() => (suppressClick = false), 0);
      },
      true,
    );

    // Carrying a part, from the tray or the build area, is followed on the whole window.
    window.addEventListener('pointermove', (event) => {
      if (trayPress && event.pointerId === trayPress.pointerId) {
        trayPress.last = event;
        if (
          Math.hypot(event.clientX - trayPress.x, event.clientY - trayPress.y) > (trayPress.touch ? 10 : 5)
        ) {
          startTrayDrag();
        }
      }
      if (
        Editor.drag &&
        (event.pointerId === Editor.drag.pointerId ||
          (Editor.drag.pointerId === 'carry' && event.pointerType !== 'touch'))
      ) {
        Editor.dragTo(worldOf(event), overTray(event));
      }
    });
    window.addEventListener('pointerup', (event) => {
      if (trayPress && event.pointerId === trayPress.pointerId) {
        clearTimeout(trayPress.timer);
        trayPress = null;
      }
      if (Editor.drag && event.pointerId === Editor.drag.pointerId) {
        Editor.dragTo(worldOf(event), overTray(event));
        Editor.drop();
      }
      // a click that follows this release belongs to the drag; later clicks count again
      if (suppressClick) {
        setTimeout(() => (suppressClick = false), 0);
      }
    });
    // while a finger carries a part, the page and the tray must not scroll
    window.addEventListener(
      'touchmove',
      (event) => {
        if (Editor.drag) {
          event.preventDefault();
        }
      },
      { passive: false },
    );
    window.addEventListener('pointercancel', (event) => {
      // the browser took the touch to scroll the tray
      if (trayPress && event.pointerId === trayPress.pointerId) {
        clearTimeout(trayPress.timer);
        trayPress = null;
      }
      if (Editor.drag && event.pointerId === Editor.drag.pointerId) {
        Editor.cancelDrag();
      }
    });
  }

  function zoomAt(point, factor) {
    const before = Editor.toWorld(point.x, point.y);
    Editor.camera.scale = Flatspace.clamp(Editor.camera.scale * factor, 3, 240);
    const after = Editor.toWorld(point.x, point.y);
    Editor.camera.x += before.x - after.x;
    Editor.camera.y += before.y - after.y;
    Editor.render();
  }

  // Whether a part is fully on screen (above the hangar tools).
  function inView(part) {
    return Build.corners(part).every((corner) => {
      const screenCorner = Editor.toScreen(corner);
      return (
        screenCorner.x >= 0 &&
        screenCorner.x <= viewWidth &&
        screenCorner.y >= 0 &&
        screenCorner.y <= viewHeight - 60
      );
    });
  }

  // Frame the whole craft.
  Editor.fit = () => {
    if (!viewWidth || !viewHeight) {
      needFit = true;
      return;
    }
    needFit = false;
    if (!Editor.parts.length) {
      Editor.camera = { x: 0, y: -2, scale: Flatspace.clamp(viewHeight / 16, 14, 48) };
      return;
    }
    const layout = Flatspace.massLayout(Editor.parts);
    const craftHeight = Math.max(layout.height, 3);
    const craftWidth = Math.max(layout.width, 3);
    Editor.camera.scale = Flatspace.clamp(
      Math.min((viewHeight - 130) / craftHeight, (viewWidth - railWidth - 160) / craftWidth),
      3,
      70,
    );
    // centred in the space right of the tool rail
    Editor.camera.x =
      layout.centreOfMass.x + (layout.minX + layout.maxX) / 2 - railWidth / 2 / Editor.camera.scale;
    // a little extra room below, where the hangar tools sit
    Editor.camera.y = layout.centreOfMass.y + (layout.minY + layout.maxY) / 2 - 22 / Editor.camera.scale;
  };

  Editor.changed = () => {
    Editor.normalize();
    Flatspace.PartPanel.rebuildAll('editor', (part) => Editor.parts.includes(part));
    const added = Flatspace.StagingEditor.assignNew(Editor.main());
    record();
    persist();
    Editor.render();
    Editor.updateStats();
    if (added) {
      showPartInfo(
        `Staging is custom, so the new part${added > 1 ? 's go' : ' goes'} into a new last stage. Drag ${added > 1 ? 'them' : 'it'} where you want in the stage list.`,
      );
    }
  };

  Editor.resize = () => {
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    viewWidth = canvas.clientWidth;
    viewHeight = canvas.clientHeight;
    canvas.width = Math.round(viewWidth * pixelRatio);
    canvas.height = Math.round(viewHeight * pixelRatio);
    const rail = document.querySelector('#editor .tool-rail');
    railWidth = rail ? rail.offsetLeft + rail.offsetWidth : 0;
    if (needFit) {
      Editor.fit();
    }
    Editor.render();
  };

  // ---------- Drawing ----------
  function drawParts(list, options) {
    const scale = Editor.camera.scale;
    for (const part of list) {
      const screenCentre = Editor.toScreen(part.position);
      context.save();
      context.translate(screenCentre.x, screenCentre.y);
      context.scale(scale, scale);
      context.rotate(-part.rotation);
      if (part.flip) {
        context.scale(-1, 1);
      }
      Flatspace.drawPart(context, part, -part.length / 2, 1 / scale, {
        selected: options.selected && part === Editor.selected,
      });
      context.restore();
    }
  }

  function outlinePath(part) {
    context.beginPath();
    Build.corners(part).forEach((corner, index) => {
      const screenCorner = Editor.toScreen(corner);
      if (index) {
        context.lineTo(screenCorner.x, screenCorner.y);
      } else {
        context.moveTo(screenCorner.x, screenCorner.y);
      }
    });
    context.closePath();
  }

  function arrow(startX, startY, deltaX, deltaY, length, color) {
    const arrowLength = Math.hypot(deltaX, deltaY) || 1;
    const unitX = deltaX / arrowLength;
    const unitY = deltaY / arrowLength;
    const tipX = startX + unitX * length;
    const tipY = startY + unitY * length;
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 2.5;
    context.beginPath();
    context.moveTo(startX, startY);
    context.lineTo(tipX, tipY);
    context.stroke();
    context.beginPath();
    context.moveTo(tipX + unitX * 9, tipY + unitY * 9);
    context.lineTo(tipX - unitY * 6, tipY + unitX * 6);
    context.lineTo(tipX + unitY * 6, tipY - unitX * 6);
    context.closePath();
    context.fill();
  }

  // Centre of mass, centre of thrust (with its thrust line) and centre of pressure.
  // Exposed for tests: Editor.overlayData(parts).
  Editor.overlayData = (parts) => {
    if (!parts.length) {
      return null;
    }
    const layout = Flatspace.massLayout(parts);
    const first = Flatspace.stagesOf(parts).find((stage) => stage.ignite);
    const centreOfThrust = first ? Flatspace.centreOfThrust(first.engines) : null;
    let miss = 0;
    if (centreOfThrust) {
      miss = Vector.cross(
        Vector.subtract(layout.centreOfMass, centreOfThrust.position),
        centreOfThrust.direction,
      );
    } // how far the thrust line passes from the centre of mass
    const centreOfPressure = parts.some((part) => part.type.engine)
      ? Flatspace.centreOfPressure(parts)
      : null;
    return { centreOfMass: layout.centreOfMass, centreOfThrust, miss, centreOfPressure };
  };

  function drawOverlays(parts) {
    const overlay = Editor.overlayData(parts);
    if (!overlay) {
      return;
    }
    if (Editor.overlays.centreOfThrust && overlay.centreOfThrust) {
      const screenPoint = Editor.toScreen(overlay.centreOfThrust.position);
      const deltaX = overlay.centreOfThrust.direction.x;
      const deltaY = -overlay.centreOfThrust.direction.y;
      // the thrust line, through the whole view
      context.setLineDash([7, 6]);
      context.strokeStyle = 'rgba(255,120,200,0.55)';
      context.lineWidth = 1.5;
      context.beginPath();
      context.moveTo(screenPoint.x - deltaX * 3000, screenPoint.y - deltaY * 3000);
      context.lineTo(screenPoint.x + deltaX * 3000, screenPoint.y + deltaY * 3000);
      context.stroke();
      context.setLineDash([]);
      arrow(screenPoint.x, screenPoint.y, -deltaX, -deltaY, 26, '#ff78c8'); // the exhaust direction, as in KSP
      context.beginPath();
      context.arc(screenPoint.x, screenPoint.y, 7, 0, Flatspace.TAU);
      context.fillStyle = '#ff78c8';
      context.fill();
      context.strokeStyle = '#2a0b1f';
      context.lineWidth = 2;
      context.stroke();
    }
    if (Editor.overlays.centreOfPressure && overlay.centreOfPressure) {
      const screenPoint = Editor.toScreen(overlay.centreOfPressure.position);
      arrow(screenPoint.x, screenPoint.y, 1, 0, 24, '#55d6ff'); // the push of air flowing across the craft
      context.beginPath();
      context.arc(screenPoint.x, screenPoint.y, 7, 0, Flatspace.TAU);
      context.fillStyle = '#55d6ff';
      context.fill();
      context.strokeStyle = '#04222c';
      context.lineWidth = 2;
      context.stroke();
    }
    if (Editor.overlays.centreOfMass) {
      const massPoint = Editor.toScreen(overlay.centreOfMass);
      context.beginPath();
      context.arc(massPoint.x, massPoint.y, 8, 0, Flatspace.TAU);
      context.fillStyle = '#ffd34d';
      context.fill();
      context.fillStyle = '#1b1405';
      context.beginPath();
      context.moveTo(massPoint.x, massPoint.y);
      context.arc(massPoint.x, massPoint.y, 8, 0, Math.PI / 2);
      context.closePath();
      context.fill();
      context.beginPath();
      context.moveTo(massPoint.x, massPoint.y);
      context.arc(massPoint.x, massPoint.y, 8, Math.PI, Math.PI * 1.5);
      context.closePath();
      context.fill();
    }
  }

  Editor.render = () => {
    if (!context || !viewWidth) {
      return;
    }
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    const background = context.createLinearGradient(0, 0, 0, viewHeight);
    background.addColorStop(0, '#0f1a33');
    background.addColorStop(1, '#0a1224');
    context.fillStyle = background;
    context.fillRect(0, 0, viewWidth, viewHeight);

    // grid, fixed to the craft frame so it pans and zooms with the craft: 1 m lines, brighter every 5 m
    const scale = Editor.camera.scale;
    const step = scale >= 10 ? 1 : 5;
    const topLeft = Editor.toWorld(0, 0);
    const bottomRight = Editor.toWorld(viewWidth, viewHeight);
    context.lineWidth = 1;
    for (let gridX = Math.floor(topLeft.x / step) * step; gridX <= bottomRight.x; gridX += step) {
      const lineX = Math.round(Editor.toScreen({ x: gridX, y: 0 }).x) + 0.5;
      context.strokeStyle = Math.round(gridX) % 5 === 0 ? 'rgba(120,160,230,0.13)' : 'rgba(120,160,230,0.06)';
      context.beginPath();
      context.moveTo(lineX, 0);
      context.lineTo(lineX, viewHeight);
      context.stroke();
    }
    for (let gridY = Math.floor(bottomRight.y / step) * step; gridY <= topLeft.y; gridY += step) {
      const lineY = Math.round(Editor.toScreen({ x: 0, y: gridY }).y) + 0.5;
      context.strokeStyle = Math.round(gridY) % 5 === 0 ? 'rgba(120,160,230,0.13)' : 'rgba(120,160,230,0.06)';
      context.beginPath();
      context.moveTo(0, lineY);
      context.lineTo(viewWidth, lineY);
      context.stroke();
    }

    syncButtons();
    Flatspace.PartPanel.layout(
      'editor',
      (part) => (Editor.parts.includes(part) ? Editor.toScreen(part.position) : null),
      !!Editor.drag,
    );
    const parts = Editor.parts;
    const drag = Editor.drag;
    if (!parts.length && !drag) {
      context.textAlign = 'center';
      context.fillStyle = 'rgba(200,215,240,0.6)';
      context.font = '500 15px Barlow, system-ui, sans-serif';
      context.fillText('Drag a part here to start your rocket.', viewWidth / 2, viewHeight / 2 - 10);
      context.font = '400 13px Barlow, system-ui, sans-serif';
      context.fillStyle = 'rgba(200,215,240,0.45)';
      context.fillText('The first part you place becomes the root.', viewWidth / 2, viewHeight / 2 + 14);
      return;
    }

    const main = Editor.main();
    const mainSet = new Set(main);
    if (parts.length) {
      const layout = Flatspace.massLayout(main);
      const top = Editor.toScreen({ x: 0, y: layout.centreOfMass.y + layout.maxY }).y;
      const bottomY = Editor.toScreen({ x: 0, y: layout.centreOfMass.y + layout.minY }).y;
      const railX = Math.max(
        railWidth + 58,
        Editor.toScreen({ x: layout.centreOfMass.x + layout.minX, y: 0 }).x - 46,
      );
      // height ruler
      context.strokeStyle = 'rgba(200,215,240,0.4)';
      context.fillStyle = 'rgba(200,215,240,0.65)';
      context.font = '500 11px "IBM Plex Mono", ui-monospace, monospace';
      context.textAlign = 'right';
      context.beginPath();
      context.moveTo(railX + 0.5, top);
      context.lineTo(railX + 0.5, bottomY);
      context.stroke();
      const tick =
        layout.height * scale > 400
          ? scale < 12
            ? 10
            : 5
          : layout.height > 30
            ? 5
            : layout.height > 12
              ? 2
              : 1;
      for (let metres = 0; metres <= layout.height + 0.001; metres += tick) {
        const tickY = bottomY - metres * scale;
        context.beginPath();
        context.moveTo(railX - 5, tickY + 0.5);
        context.lineTo(railX + 0.5, tickY + 0.5);
        context.stroke();
        context.fillText(metres + ' m', railX - 8, tickY + 4);
      }
      drawParts(main, { selected: !drag });
      // floating parts: faded if they stay behind, with a dashed outline and a tag
      const floating = parts.filter((part) => !mainSet.has(part));
      for (const part of floating) {
        let root = part;
        while (root.parent) {
          root = root.parent;
        }
        const keep = root.loose === 'keep';
        context.globalAlpha = keep ? 0.95 : 0.5;
        drawParts([part], { selected: !drag });
        context.globalAlpha = 1;
        outlinePath(part);
        context.setLineDash([4, 4]);
        context.strokeStyle = keep ? 'rgba(127,224,164,0.85)' : 'rgba(200,215,240,0.55)';
        context.lineWidth = 1.2;
        context.stroke();
        context.setLineDash([]);
        if (part === root) {
          const top = Math.min(...Build.corners(part).map((corner) => Editor.toScreen(corner).y));
          const screenPoint = Editor.toScreen(part.position);
          context.font = '600 10.5px "Saira Semi Condensed", sans-serif';
          context.textAlign = 'center';
          context.fillStyle = keep ? 'rgba(127,224,164,0.95)' : 'rgba(200,215,240,0.75)';
          context.fillText(keep ? 'FLOATING · LAUNCHES' : 'FLOATING · LEFT BEHIND', screenPoint.x, top - 8);
        }
      }

      // the selected part's mirror twin, outlined
      const handle = handleOf(Editor.selected);
      if (handle) {
        const screenPoint = Editor.toScreen(handle.position);
        const angle = Math.atan2(-handle.direction.y, handle.direction.x);
        context.save();
        context.translate(screenPoint.x, screenPoint.y);
        context.rotate(angle);
        context.fillStyle = '#ffb547';
        context.strokeStyle = '#241500';
        context.lineWidth = 1.5;
        context.beginPath();
        context.roundRect ? context.roundRect(-9, -13, 18, 26, 6) : context.rect(-9, -13, 18, 26);
        context.fill();
        context.stroke();
        context.fillStyle = '#241500';
        context.beginPath();
        context.moveTo(-5, -5);
        context.lineTo(5, -5);
        context.moveTo(-5, 0);
        context.lineTo(5, 0);
        context.moveTo(-5, 5);
        context.lineTo(5, 5);
        context.strokeStyle = '#241500';
        context.lineWidth = 1.6;
        context.stroke();
        context.restore();
      }
      const twin = !drag && Editor.selected ? Build.twinOf(parts, Editor.selected) : null;
      if (twin) {
        outlinePath(twin);
        context.setLineDash([5, 4]);
        context.strokeStyle = 'rgba(255,181,71,0.7)';
        context.lineWidth = 1.5;
        context.stroke();
        context.setLineDash([]);
      }

      // root marker: a small ring at the root's centre
      const root = parts[0];
      if (root) {
        const screenPoint = Editor.toScreen(root.position);
        context.strokeStyle = 'rgba(85,214,255,0.85)';
        context.lineWidth = 2;
        context.beginPath();
        context.arc(screenPoint.x, screenPoint.y, 5, 0, Flatspace.TAU);
        context.stroke();
      }

      if (!drag) {
        context.font = '600 11px "Saira Semi Condensed", sans-serif';
        context.textAlign = 'left';
        const labelX = Editor.toScreen({ x: layout.centreOfMass.x + layout.maxX, y: 0 }).x + 14;
        Flatspace.stagesOf(main).forEach((stage, stageIndex) => {
          const part = stage.parts[0];
          if (!part) {
            return;
          }
          context.fillStyle = 'rgba(255,181,71,0.9)';
          context.fillText('STAGE ' + (stageIndex + 1), labelX, Editor.toScreen(part.position).y + 4);
        });
      }
    }

    if (drag) {
      // attach points the held part could use
      const heldChildren = Flatspace.childrenOf(drag.held);
      for (const freeNode of Build.freeNodes(parts)) {
        if (
          !Build.nodeFree(drag.held, drag.root, freeNode.node === 'bottom' ? 'top' : 'bottom', heldChildren)
        ) {
          continue;
        }
        const screenPoint = Editor.toScreen(freeNode.position);
        const isTarget =
          drag.candidate &&
          drag.candidate.node &&
          drag.candidate.node.part === freeNode.part &&
          drag.candidate.node.node === freeNode.node;
        context.beginPath();
        context.arc(screenPoint.x, screenPoint.y, isTarget ? 8 : 5, 0, Flatspace.TAU);
        context.fillStyle = isTarget ? 'rgba(255,181,71,0.9)' : 'rgba(85,214,255,0.55)';
        context.fill();
      }
      if (drag.candidate && drag.candidate.kind === 'surface') {
        // light up the side being attached to
        const corners = Build.corners(drag.candidate.parent);
        const [cornerA, cornerB] =
          drag.candidate.side > 0 ? [corners[1], corners[2]] : [corners[0], corners[3]];
        const screenA = Editor.toScreen(cornerA);
        const screenB = Editor.toScreen(cornerB);
        context.strokeStyle = drag.valid ? 'rgba(255,181,71,0.95)' : 'rgba(255,107,90,0.9)';
        context.lineWidth = 3;
        context.beginPath();
        context.moveTo(screenA.x, screenA.y);
        context.lineTo(screenB.x, screenB.y);
        context.stroke();
      }
      if (!drag.overTray) {
        const ghosts = drag.held.concat(drag.ghostTwin || []);
        context.globalAlpha = 0.82;
        drawParts(ghosts, {});
        context.globalAlpha = 1;
        const valid = drag.valid;
        for (const part of ghosts) {
          outlinePath(part);
          context.fillStyle = valid ? 'rgba(85,214,255,0.10)' : 'rgba(255,80,60,0.38)';
          context.fill();
          context.strokeStyle = valid ? 'rgba(85,214,255,0.8)' : 'rgba(255,107,90,0.95)';
          context.lineWidth = 1.5;
          context.stroke();
        }
      }
    }

    // overlays: for the craft as it would be if the carried part were dropped here
    const shown =
      drag && drag.valid && drag.candidate && drag.joinsMain && !drag.overTray
        ? main.concat(drag.held, drag.ghostTwin || [])
        : main;
    drawOverlays(shown);
  };

  function syncButtons() {
    const selected = Editor.selected && Editor.parts.includes(Editor.selected) ? Editor.selected : null;
    const set = (elementId, pressed, disabled) => {
      const button = byId(elementId);
      if (!button) {
        return;
      }
      if (pressed !== null) {
        button.setAttribute('aria-pressed', String(pressed));
      }
      if (disabled !== undefined) {
        button.disabled = disabled;
      }
    };
    set('rootButton', null, !!Editor.drag || !selected || selected === Editor.parts[0]);
    set('deleteButton', null, !!Editor.drag || !selected);
    set('undoButton', null, Editor.historyIndex <= 0);
    set('redoButton', null, Editor.historyIndex >= Editor.history.length - 1);
    set('mirrorButton', Editor.mirror);
    set('offsetButton', Editor.offsetMode);
    set('snapButton', Editor.snap);
    set('copyButton', null, !!Editor.drag || !selected);
    set('subassemblyButton', null, !!Editor.drag || !selected);
    set('settingsButton', null, !!Editor.drag || !selected);
    for (const overlayName of ['centreOfMass', 'centreOfThrust', 'centreOfPressure']) {
      set('overlay-' + overlayName, Editor.overlays[overlayName]);
    }
  }

  // ---------- Stats ----------
  Editor.updateStats = (parts = Editor.main()) => {
    const stages = Flatspace.stagesOf(parts);
    const vacuumStats = Flatspace.stageStats(parts, stages, 0, 0, 9.81);
    const seaLevelStats = Flatspace.stageStats(parts, stages, 0, 1, 9.81);
    Flatspace.StagingEditor.render(parts, stages, vacuumStats, seaLevelStats, !Editor.drag);
    const layout = Flatspace.massLayout(parts);
    const first = stages.findIndex((stage) => stage.ignite);
    const thrustToWeight = first >= 0 ? seaLevelStats.events[first].thrustToWeight : 0;
    byId('editorTotals').innerHTML =
      `<dt>Total Δv (vacuum)</dt><dd class="delta-v-total">${vacuumStats.total.toFixed(0)} m/s</dd>
      <dt>Launch TWR</dt><dd${first >= 0 && thrustToWeight < 1 ? ' class="bad"' : ''}>${first >= 0 ? thrustToWeight.toFixed(2) : '—'}</dd>
      <dt>Mass</dt><dd>${(layout.mass / 1000).toFixed(2)} t</dd>
      <dt>Height</dt><dd>${layout.height.toFixed(1)} m</dd>
      <dt>Parts</dt><dd>${parts.length}</dd>${floatNote()}`;
    const warn = [];
    if (parts.length && !parts.some((part) => part.type.command)) {
      warn.push('Add a capsule or probe core so the craft can be controlled.');
    }
    if (parts.length && !parts.some((part) => part.type.engine)) {
      warn.push('No engines yet.');
    }
    if (first >= 0 && thrustToWeight < 1) {
      warn.push('First stage thrust is lower than its weight (TWR under 1). It will not lift off.');
    }
    const kids = Flatspace.childrenOf(parts);
    if (parts.some((part) => part.type.decoupler && !(kids.get(part) || []).length)) {
      warn.push('A decoupler has nothing attached below it.');
    }
    if (
      parts.some((part) => part.type.engine) &&
      !parts.some((part) => part.type.chute) &&
      parts.some((part) => part.type.crew)
    ) {
      warn.push('No parachute. The crew will need one to come home.');
    }
    const overlay = Editor.overlayData(parts);
    if (overlay && overlay.centreOfPressure && overlay.centreOfPressure.ahead > 0.05) {
      warn.push(
        `The centre of pressure is ${overlay.centreOfPressure.ahead.toFixed(1)} m ahead of the centre of mass, so the air will try to turn it sideways and SAS has to hold it straight. Fins near the bottom make it fly straight on its own.`,
      );
    }
    if (overlay && overlay.centreOfThrust && Math.abs(overlay.miss) > 0.1) {
      warn.push(
        `The first stage's thrust line misses the centre of mass by ${Math.abs(overlay.miss).toFixed(2)} m, so the craft will turn under power.`,
      );
    }
    byId('editorWarnings').innerHTML = warn.map((warning) => `<li>${warning}</li>`).join('');
    byId('launchButton').disabled = !Editor.parts.length;
  };
  function floatNote() {
    const roots = Editor.floating().filter((part) => !part.parent);
    if (!roots.length) {
      return '';
    }
    const keep = roots.filter((part) => part.loose === 'keep').length;
    return `<dt>Floating</dt><dd>${roots.length} (${keep} launch${keep === 1 ? 'es' : ''})</dd>`;
  }

  Editor.launch = () => {
    if (!Editor.parts.length) {
      return;
    }
    persist();
    // floating parts set to launch come along as separate objects, where they were placed
    const extras = Editor.floating()
      .filter((part) => !part.parent && part.loose === 'keep')
      .map((root) => ({ parts: Flatspace.serialParts(Flatspace.subtree(Editor.parts, root)) }));
    game.launch({ name: Editor.name, parts: Flatspace.serialParts(Editor.main()), extras });
  };
})();
