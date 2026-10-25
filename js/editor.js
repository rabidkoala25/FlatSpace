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
  const Editor = (FS.Editor = {});
  const Build = FS.Build;
  const Vector = FS.vec;
  const byId = (elementId) => document.getElementById(elementId);
  const SNAP_PX = 34; // snapping distance on screen
  const LONG_PRESS = 380; // ms to pick up with a finger
  const HISTORY = 100; // undo steps
  const SUB_TAB = 'Subassemblies';
  const RADIANS_PER_DEGREE = Math.PI / 180;
  let canvas;
  let context;
  let viewWidth = 0;
  let viewHeight = 0;
  let pixelRatio = 1;
  let game;
  let needFit = true;
  let railW = 0; // room taken by the tool rail on the left of the build area

  const sampleParts = (craft) => (craft.tree ? FS.partsFromSerial(craft.tree) : FS.stackToParts(craft.parts));

  Editor.name = 'Orbiter I';
  Editor.parts = []; // the craft; the first part is the root
  Editor.sel = null; // the selected part
  Editor.cam = { x: 0, y: 0, s: 30 }; // centre of the view (craft frame, m) and pixels per metre
  Editor.drag = null; // the parts being carried, if any
  Editor.tab = FS.PART_CATS[0];
  Editor.mirror = false; // mirror symmetry (X)
  Editor.snap = true; // snap offsets to 0.25 m and the middle of a side
  Editor.offsetMode = false; // dragging a side part slides it (for touch; Alt does it with a mouse)
  Editor.overlays = { com: true, cot: true, cop: true };
  Editor.history = []; // saved craft states, oldest first
  Editor.hpos = -1; // the state shown now
  Editor.subs = []; // saved subassemblies: [{ name, parts: [saved parts] }]

  // ---------- Coordinates ----------
  Editor.toScreen = (point) => ({
    x: viewWidth / 2 + (point.x - Editor.cam.x) * Editor.cam.s,
    y: viewHeight / 2 - (point.y - Editor.cam.y) * Editor.cam.s,
  });
  Editor.toWorld = (screenX, screenY) => ({
    x: Editor.cam.x + (screenX - viewWidth / 2) / Editor.cam.s,
    y: Editor.cam.y - (screenY - viewHeight / 2) / Editor.cam.s,
  });
  const canvasPt = (event) => {
    const bounds = canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const worldOf = (event) => {
    const point = canvasPt(event);
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
  Editor.init = (theGame) => {
    game = theGame;
    canvas = byId('edCanvas');
    context = canvas.getContext('2d');
    const saved = FS.store.load('flatspace.current', null);
    if (saved && Array.isArray(saved.parts)) {
      Editor.name = saved.name || 'Untitled';
      Editor.parts = FS.partsFromSerial(saved.parts);
      Editor.normalize();
    } else {
      Editor.parts = sampleParts(FS.SAMPLE_CRAFT[1]);
    }
    Editor.subs = FS.store.load('flatspace.subassemblies', []) || [];
    const view = FS.store.get('flatspace.editorView', null);
    if (view && view.overlays) {
      Object.assign(Editor.overlays, view.overlays);
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
    byId('btnLaunch').addEventListener('click', () => Editor.launch());
    byId('btnNew').addEventListener('click', () => {
      Editor.name = 'Untitled';
      Editor.parts = [];
      Editor.sel = null;
      byId('craftName').value = Editor.name;
      Editor.fit();
      Editor.changed();
    });
    byId('btnSave').addEventListener('click', () => {
      const all = FS.store.load('flatspace.crafts', {});
      all[Editor.name] = FS.serialParts(Editor.parts);
      const saved = FS.store.save('flatspace.crafts', all);
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
        parts = sampleParts(FS.SAMPLE_CRAFT.find((craft) => craft.name === name));
      } else {
        const savedCraft = FS.store.load('flatspace.crafts', {})[name];
        if (savedCraft) {
          parts = FS.partsFromSerial(savedCraft);
        }
      }
      if (parts) {
        Editor.load(name, parts);
      }
      event.target.value = '';
    });
    const onClick = (elementId, handler) => byId(elementId).addEventListener('click', handler);
    onClick('btnFit', () => {
      Editor.fit();
      Editor.render();
    });
    onClick('btnRoot', () => Editor.reroot(Editor.sel));
    onClick('btnDel', () => Editor.remove(Editor.sel));
    onClick('btnUndo', () => Editor.undo());
    onClick('btnRedo', () => Editor.redo());
    onClick('btnMirror', () => Editor.toggleMirror());
    onClick('btnRotL', () => Editor.rotate(15 * RADIANS_PER_DEGREE));
    onClick('btnRotR', () => Editor.rotate(-15 * RADIANS_PER_DEGREE));
    onClick('btnFlip', () => Editor.flip());
    onClick('btnOffset', () => {
      Editor.offsetMode = !Editor.offsetMode;
      showPartInfo(Editor.offsetMode ? 'Offset on: drag a side part to slide it along its parent.' : hint());
      Editor.render();
    });
    onClick('btnSnap', () => {
      Editor.snap = !Editor.snap;
      saveView();
      showPartInfo(
        Editor.snap
          ? 'Snap on: offsets move in 0.25 m steps and catch the middle of a side.'
          : 'Snap off: offsets move freely.',
      );
      Editor.render();
    });
    onClick('btnCopy', () => Editor.copy(Editor.sel));
    onClick('btnSub', () => Editor.saveSub(Editor.sel));
    onClick('btnSettings', () => {
      if (Editor.sel) {
        FS.PartPanel.select(Editor.sel, 'editor');
        Editor.render();
      } else {
        showPartInfo('Select a part to see its settings.');
      }
    });
    onClick('btnFiles', () => FS.CraftFiles.open());
    FS.PartPanel.init(Editor);
    FS.CraftFiles.init();
    FS.StagingEditor.init(Editor);
    for (const overlayName of ['com', 'cot', 'cop']) {
      onClick('ovl_' + overlayName, () => {
        Editor.overlays[overlayName] = !Editor.overlays[overlayName];
        saveView();
        Editor.render();
      });
    }
    initPointer();
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
    if ((event.key === 'Delete' || event.key === 'Backspace') && Editor.sel) {
      Editor.remove(Editor.sel);
      event.preventDefault();
    } else if (event.key === 'Escape') {
      if (Editor.drag) {
        Editor.cancelDrag();
      } else {
        Editor.sel = null;
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
  Editor.main = () => (Editor.parts.length ? FS.subtree(Editor.parts, Editor.parts[0]) : []);
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
    Editor.sel = null;
    byId('craftName').value = name;
    Editor.fit();
    Editor.changed();
  };

  function persist() {
    FS.store.save('flatspace.current', { name: Editor.name, parts: FS.serialParts(Editor.parts) });
  }
  function saveView() {
    FS.store.set('flatspace.editorView', { overlays: Editor.overlays, snap: Editor.snap });
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
    const saved = FS.store.load('flatspace.crafts', {});
    let html = '<option value="">Load craft…</option><optgroup label="Sample craft">';
    for (const craft of FS.SAMPLE_CRAFT) {
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
    const state = JSON.stringify(FS.serialParts(Editor.parts));
    if (state === Editor.history[Editor.hpos]) {
      return;
    }
    Editor.history = Editor.history.slice(0, Editor.hpos + 1);
    Editor.history.push(state);
    if (Editor.history.length > HISTORY + 1) {
      Editor.history.shift();
    }
    Editor.hpos = Editor.history.length - 1;
  }
  function restore(historyIndex) {
    if (Editor.drag) {
      Editor.cancelDrag();
    }
    Editor.hpos = historyIndex;
    Editor.parts = FS.partsFromSerial(JSON.parse(Editor.history[historyIndex]));
    Editor.sel = null;
    persist();
    FS.PartPanel.rebuildAll('editor', (part) => Editor.parts.includes(part));
    Editor.render();
    Editor.updateStats();
  }
  Editor.undo = () => {
    if (Editor.hpos > 0) {
      restore(Editor.hpos - 1);
      showPartInfo('Undone.');
    } else {
      showPartInfo('Nothing to undo.');
    }
  };
  Editor.redo = () => {
    if (Editor.hpos < Editor.history.length - 1) {
      restore(Editor.hpos + 1);
      showPartInfo('Redone.');
    } else {
      showPartInfo('Nothing to redo.');
    }
  };

  // ---------- Tray ----------
  function partStat(partType) {
    if (partType.engine) {
      return `${(partType.engine.vac / 1000).toFixed(0)} kN · Isp ${partType.engine.ispVac} s`;
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
    const host = byId('palTabs');
    host.innerHTML = '';
    for (const category of FS.PART_CATS.concat(SUB_TAB)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pal-tab';
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
    button.className = 'part-btn';
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 88;
    thumbCanvas.height = 104;
    button.appendChild(thumbCanvas);
    const textSpan = document.createElement('span');
    textSpan.innerHTML = `<span class="pn"></span><span class="ps"></span>`;
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
    for (const tabButton of byId('palTabs').children) {
      tabButton.setAttribute('aria-selected', String(tabButton.textContent === Editor.tab));
    }
    const host = byId('palette');
    host.innerHTML = '';
    if (Editor.tab === SUB_TAB) {
      if (!Editor.subs.length) {
        const paragraph = document.createElement('p');
        paragraph.className = 'pal-empty';
        paragraph.textContent =
          'Select a part and press “Save sub” to keep it here, with everything attached below it, for reuse in any craft.';
        host.appendChild(paragraph);
      }
      Editor.subs.forEach((subassembly, index) => {
        const parts = FS.partsFromSerial(subassembly.parts);
        const mass = parts.reduce((sum, part) => sum + FS.partMass(part), 0);
        const button = trayButton(
          subassembly.name,
          `${parts.length} part${parts.length > 1 ? 's' : ''} · ${(mass / 1000).toFixed(2)} t`,
          (thumbCanvas) => drawGroupThumb(thumbCanvas, parts),
        );
        button.dataset.sub = String(index);
        button.setAttribute('aria-label', `Subassembly ${subassembly.name}`);
        button.addEventListener('click', () => {
          if (suppressClick) {
            suppressClick = false;
            return;
          }
          showPartInfo('Drag a subassembly into the build area to add it.');
        });
        button.addEventListener('pointerdown', (event) => trayDown(event, { sub: index }));
        hoverCard(button, () => showCard(button, subassembly.name, 'Saved subassembly', subRows(parts)));
        const row = document.createElement('div');
        row.className = 'sub-row';
        row.appendChild(button);
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'sub-del';
        deleteButton.textContent = '×';
        deleteButton.title = 'Delete this subassembly';
        deleteButton.setAttribute('aria-label', `Delete subassembly ${subassembly.name}`);
        deleteButton.addEventListener('click', () => {
          Editor.subs.splice(index, 1);
          FS.store.save('flatspace.subassemblies', Editor.subs);
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
      FS.DATA.tankPresets.forEach((preset, index) => {
        if (preset.size !== width) {
          width = preset.size;
          const heading = document.createElement('div');
          heading.className = 'pal-sub';
          heading.textContent = `${width} m wide`;
          host.appendChild(heading);
        }
        const partType = FS.PART[preset.base];
        const opts = { len: preset.len, size: preset.size };
        const sample = FS.newPart(preset.base, opts);
        FS.relayout([sample]);
        const button = trayButton(
          preset.name,
          `${(sample.cap / 1000).toFixed(sample.cap < 1000 ? 2 : 1)} t fuel · ${preset.len} × ${preset.size} m`,
          (thumbCanvas) => drawThumb(thumbCanvas, partType, sample),
        );
        button.dataset.preset = String(index);
        if (preset.len === partType.len && preset.size === partType.w) {
          button.dataset.part = partType.id;
        }
        button.setAttribute('aria-label', `${preset.name}: ${partType.desc}`);
        button.addEventListener('click', () => {
          if (suppressClick) {
            suppressClick = false;
            return;
          }
          Editor.quickAdd(preset.base, opts);
        });
        button.addEventListener('pointerdown', (event) => trayDown(event, { id: preset.base, opts }));
        hoverCard(button, () =>
          showCard(
            button,
            preset.name,
            `${partType.desc} Stretch it with the handle at its end, and change its width and look in its settings. (KSP: ${preset.ksp}.)`,
            cardRows(partType, sample),
          ),
        );
        host.appendChild(button);
      });
      return;
    }
    for (const partType of FS.PARTS.filter((partType) => partType.cat === Editor.tab)) {
      const button = trayButton(partType.name, partStat(partType), (thumbCanvas) =>
        drawThumb(thumbCanvas, partType),
      );
      button.dataset.part = partType.id;
      button.setAttribute('aria-label', `${partType.name}: ${partType.desc}`);
      button.addEventListener('click', () => {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        Editor.quickAdd(partType.id);
      });
      button.addEventListener('pointerdown', (event) => trayDown(event, partType.id));
      hoverCard(button, () => showCard(button, partType.name, partType.desc, cardRows(partType)));
      host.appendChild(button);
    }
  }

  function drawThumb(thumbCanvas, partType, sample) {
    const graphics = thumbCanvas.getContext('2d');
    const part = sample || FS.newPart(partType.id);
    FS.relayout([part]);
    const scale = Math.min(
      70 / Math.max(part.w + (partType.fin && !partType.radial ? 1.6 : 0), 0.6),
      84 / part.len,
      60,
    );
    graphics.setTransform(scale, 0, 0, scale, 44, 52 - (part.len * scale) / 2);
    FS.drawPart(graphics, part, 0, 1 / scale, {});
  }

  function drawGroupThumb(thumbCanvas, parts) {
    const graphics = thumbCanvas.getContext('2d');
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const part of parts) {
      for (const corner of Build.quad(part)) {
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
      graphics.translate(44 + (part.pos.x - centreX) * scale, 52 - (part.pos.y - centreY) * scale);
      graphics.scale(scale, scale);
      graphics.rotate(-part.rot);
      if (part.flip) {
        graphics.scale(-1, 1);
      }
      FS.drawPart(graphics, part, -part.len / 2, 1 / scale, {});
    }
  }

  // The hover card: everything the tray row has no room for.
  function cardRows(partType, part) {
    const rows = [];
    const tonnes = (kilograms) => (kilograms / 1000).toFixed(kilograms < 1000 ? 3 : 2) + ' t';
    const dryMass = part ? part.dry : partType.mass;
    const fuel = part ? part.cap : partType.fuel || 0;
    const wetMass = dryMass + fuel + (partType.solid || 0);
    rows.push([
      'Mass',
      wetMass > dryMass ? `${tonnes(wetMass)} (${tonnes(dryMass)} empty)` : tonnes(dryMass),
    ]);
    rows.push([
      'Size',
      `${part ? part.len : partType.len} m long · ${partType.w === 'auto' ? 'fits its neighbours' : (part ? part.size : partType.w) + ' m wide'}`,
    ]);
    if (partType.engine) {
      const engine = partType.engine;
      rows.push([
        'Thrust',
        `${(engine.asl / 1000).toFixed(0)} kN sea level · ${(engine.vac / 1000).toFixed(0)} kN vacuum`,
      ]);
      rows.push(['Isp', `${engine.ispAsl} s sea level · ${engine.ispVac} s vacuum`]);
      if (engine.solid) {
        rows.push([
          'Burn',
          `${(partType.solid / (engine.vac / (engine.ispVac * FS.G0))).toFixed(0)} s, cannot throttle`,
        ]);
      }
      rows.push(['Gimbal', engine.gimbal ? `±${engine.gimbal}°` : 'none']);
    }
    if (partType.fuel) {
      rows.push(['Fuel', tonnes(fuel)]);
    }
    if (partType.stretch) {
      rows.push(['Stretchable', `${FS.LEN_STEP} m steps, ${FS.TANK_WIDTHS.length} widths`]);
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
  function subRows(parts) {
    const count = {};
    parts.forEach((part) => (count[part.def.name] = (count[part.def.name] || 0) + 1));
    return Object.entries(count).map(([partName, count]) => [count + '×', partName]);
  }
  function showCard(button, title, desc, rows) {
    const card = byId('partCard');
    card.innerHTML = '<h3></h3><p></p><dl></dl>';
    card.querySelector('h3').textContent = title;
    card.querySelector('p').textContent = desc;
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
        cand: null,
        block: null,
        valid: false,
        overTray: false,
        statKey: null,
        twin: null,
        ghostTwin: null,
        world: Vector.add(root.pos, Vector.scale(grab, -1)),
      },
      extra,
    );
    Editor.drag.mirror = Editor.mirror || !!Editor.drag.twin;
  }

  // The angle the player has given a side part, as seen on the right-hand side.
  const spinOf = (part) => {
    if (part.node !== 'srf' || !part.parent) {
      return 0;
    }
    const left = part.srfOff && part.srfOff.x < 0;
    return (part.def.radial && left ? -1 : 1) * (part.rel || 0);
  };

  // Pick up a new part from the tray, centred on the pointer.
  Editor.pickNew = (partId, world, pointerId, opts) => {
    const part = FS.newPart(partId, opts);
    if (!part) {
      return;
    }
    part.spin = 0;
    FS.relayout([part]);
    startDrag([part], part, { x: 0, y: 0 }, null, pointerId);
    Editor.dragTo(world);
  };

  // Pick up a copy of a group of saved parts (a subassembly), root first.
  Editor.pickGroup = (serial, world, pointerId) => {
    const held = Build.clone(FS.partsFromSerial(serial));
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
    const held = FS.subtree(Editor.parts, part);
    const set = new Set(held);
    const twinPart = Build.twinOf(Editor.parts, part);
    let twin = null;
    if (twinPart && !set.has(twinPart)) {
      const twinTree = FS.subtree(Editor.parts, twinPart);
      twinTree.forEach((part) => set.add(part));
      twin = { held: twinTree, root: twinPart, origin: poseOf(twinPart) };
    }
    const origin = poseOf(part);
    const isMain = part === Editor.parts[0];
    part.spin = spinOf(part);
    Editor.parts = Editor.parts.filter((part) => !set.has(part));
    part.parent = null;
    if (part.def.radial) {
      part.flip = false;
    }
    FS.relayout(Editor.parts);
    FS.relayout(held);
    startDrag(held, part, Vector.sub(part.pos, world), origin, pointerId, { twin, isMain });
    Editor.sel = part;
    Editor.dragTo(world);
  };

  const poseOf = (part) => ({
    parent: part.parent,
    node: part.node,
    pos: { ...part.pos },
    rot: part.rot,
    flip: part.flip,
    srfOff: part.srfOff && { ...part.srfOff },
    rel: part.rel,
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
    const held = Build.clone(FS.subtree(Editor.parts, part));
    const root = held[0];
    root.spin = spinOf(part);
    if (root.def.radial) {
      root.flip = false;
    }
    const spot = world || Vector.add(part.pos, { x: Math.max(part.w, part.tw) + 1, y: 0 });
    startDrag(held, root, { x: 0, y: 0 }, null, 'carry');
    Editor.dragTo(spot);
    showPartInfo(
      `Copy of the ${part.def.name}${held.length > 1 ? ` and ${held.length - 1} more` : ''}: click or tap where it should go. Esc cancels.`,
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
    drag.cand = toTray
      ? null
      : Build.candidate(Editor.parts, drag.held, drag.root, free, SNAP_PX / Editor.cam.s, drag.mirror);
    // the whole craft can be moved anywhere
    if (!drag.cand && !toTray && drag.isMain) {
      drag.cand = { kind: 'root', parent: null, pos: { ...free }, rot: drag.root.spin || 0, dist: 0 };
    }
    drag.block = drag.cand ? Build.blocker(Editor.parts, drag.held, drag.root, drag.cand, drag.mirror) : null;
    // nothing to attach to: it can be left floating here, if it overlaps nothing
    drag.loose = false;
    if (!drag.cand && !toTray) {
      Build.placeHeld(drag.held, drag.root, free);
      drag.block =
        Editor.parts.find((part) => drag.held.some((heldPart) => Build.overlap(heldPart, part))) || null;
      drag.loose = !drag.block;
    }
    drag.valid = (!!drag.cand && !drag.block) || drag.loose;
    if (drag.loose || (drag.cand && drag.cand.kind === 'root')) {
      Build.placeHeld(drag.held, drag.root, free);
    }
    // the mirror twin's ghost, and live stats for the craft as it would be if dropped here
    drag.ghostTwin = null;
    const key = drag.loose
      ? 'loose'
      : drag.valid
        ? `${drag.cand.kind}:${drag.cand.parent ? drag.cand.parent.uid : 0}:${drag.cand.side || 0}:${drag.cand.pos.y.toFixed(2)}:${drag.cand.rot.toFixed(3)}:${drag.mirror}`
        : 'none';
    if (drag.valid && drag.cand) {
      const line = drag.mirror ? Build.mirrorFor(Editor.parts, drag.cand.parent, drag.cand.kind) : null;
      let all = Build.attach(Editor.parts, drag.held, drag.root, drag.cand);
      if (line) {
        drag.ghostTwin = Build.makeTwin(drag.held, line, drag.cand.kind);
        all = all.concat(drag.ghostTwin);
        FS.relayout(all);
      }
      // the craft it would be part of: the main craft, unless it is dropped onto a floating part
      let root = drag.isMain ? drag.root : all[0];
      while (root.parent) {
        root = root.parent;
      }
      drag.joinsMain = drag.isMain || root === Editor.parts[0];
      if (key !== drag.statKey) {
        Editor.updateStats(FS.subtree(all, root));
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
      showPartInfo(`Can't go there: it would overlap the ${drag.block.def.name}.`);
    } else if (drag.loose) {
      showPartInfo(
        'Release to leave it floating here. Its settings say whether it launches with the craft or stays behind.',
      );
    } else if (!drag.cand) {
      showPartInfo('Bring it next to an attach point or the side of a part.');
    } else {
      showPartInfo(
        `${drag.root.def.name}: release to attach${drag.cand.kind === 'srf' ? ' to the side of the ' + drag.cand.parent.def.name : drag.cand.parent ? ' to the ' + drag.cand.parent.def.name : ''}${drag.ghostTwin ? ', with a mirror twin' : ''}.`,
      );
    }
    Editor.render();
  };

  // Attach held parts as cand, with a mirror twin if asked and possible.
  function place(held, root, cand, mirror) {
    const line = mirror ? Build.mirrorFor(Editor.parts, cand.parent, cand.kind) : null;
    Editor.parts = Build.attach(Editor.parts, held, root, cand);
    const set = new Set(held);
    if (line) {
      const twin = Build.makeTwin(held, line, cand.kind);
      Build.linkTwins(held, twin);
      Editor.parts = Editor.parts.concat(twin);
      FS.relayout(Editor.parts);
    } else {
      // keep mirror links inside the group; drop links to twins left behind
      for (const heldPart of held) {
        if (heldPart.sym && !held.some((other) => other !== heldPart && other.sym === heldPart.sym)) {
          delete heldPart.sym;
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
      if (drag.held.includes(Editor.sel)) {
        Editor.sel = null;
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
        if (heldPart.sym && !drag.held.some((other) => other !== heldPart && other.sym === heldPart.sym)) {
          delete heldPart.sym;
        }
      }
      Editor.parts = Editor.parts.concat(drag.held);
      FS.relayout(Editor.parts);
      Editor.sel = drag.root;
      Editor.changed();
      showPartInfo(
        `Floating ${drag.root.def.name}: it ${drag.root.loose === 'keep' ? 'launches with the craft' : 'is left behind at launch'}. Change that in its settings.`,
      );
      return;
    }
    if (drag.valid) {
      place(drag.held, drag.root, drag.cand, drag.mirror);
      if (drag.isMain) {
        let root = drag.root;
        while (root.parent) {
          root = root.parent;
        }
        Editor.parts = [root].concat(Editor.parts.filter((part) => part !== root));
      }
      Editor.sel = drag.root;
      Editor.changed();
      showPartInfo(`${drag.root.def.name}: ${drag.root.def.desc}`);
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
        pos: origin.pos,
        rot: origin.rot,
        flip: origin.flip,
      });
      if (origin.srfOff) {
        part.srfOff = origin.srfOff;
        part.rel = origin.rel;
      } else {
        delete part.srfOff;
        delete part.rel;
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
    FS.relayout(Editor.parts);
  }

  // Click or tap on a tray part (and the keyboard): attach it somewhere sensible without dragging.
  Editor.quickAdd = (partId, opts) => {
    if (Editor.drag) {
      return;
    }
    const part = FS.newPart(partId, opts);
    if (!part) {
      return;
    }
    FS.relayout([part]);
    const held = [part];
    const tryCand = (cand) =>
      cand && !Build.blocker(Editor.parts, held, part, cand, Editor.mirror) ? cand : null;
    let cand = null;
    const wasEmpty = !Editor.parts.length;
    if (wasEmpty) {
      cand = { kind: 'root', parent: null, pos: { x: 0, y: 0 }, rot: 0 };
    } else if (part.def.radial) {
      const base =
        Editor.sel && Editor.parts.includes(Editor.sel) && Build.takesSurface(Editor.sel.def)
          ? Editor.sel
          : null;
      for (const side of [1, -1]) {
        if (cand || !base) {
          break;
        }
        const spot = Vector.add(
          base.pos,
          FS.rotV({ x: side * (Math.max(base.w, base.tw) / 2 + part.w / 2), y: 0 }, base.rot),
        );
        const candidate = Build.candidate([base], held, part, spot, 0.01);
        cand = tryCand(candidate && candidate.kind === 'srf' ? candidate : null);
      }
      if (!cand) {
        showPartInfo(
          `Select a tank or other part first, then add the ${part.def.name} to its side (or drag it there).`,
        );
        return;
      }
    } else {
      // below the selected part if it has room, otherwise at the lowest free node (or the highest, for a parachute)
      const nodes = Build.freeNodes(Editor.parts).filter((freeNode) =>
        Build.hasNode(part.def, freeNode.node === 'bottom' ? 'top' : 'bottom'),
      );
      nodes.sort(
        (first, second) =>
          (first.part === Editor.sel) - (second.part === Editor.sel) ||
          (part.def.chute ? first.pos.y - second.pos.y : second.pos.y - first.pos.y),
      );
      while (!cand && nodes.length) {
        const freeNode = nodes.pop();
        const axis = FS.partAxis(freeNode.part.rot);
        const spot = Vector.add(
          freeNode.pos,
          Vector.scale(axis, ((freeNode.node === 'top' ? 1 : -1) * part.len) / 2),
        );
        const candidate = Build.candidate([freeNode.part], held, part, spot, 0.05);
        cand = tryCand(candidate && candidate.parent === freeNode.part ? candidate : null);
      }
      if (!cand) {
        showPartInfo(
          `No free attach point for the ${part.def.name}. Drag it onto the side of a part instead.`,
        );
        return;
      }
    }
    place(held, part, cand, Editor.mirror);
    Editor.sel = part;
    if (wasEmpty || !inView(part)) {
      Editor.fit();
    }
    Editor.changed();
    showPartInfo(`${part.def.name}: ${part.def.desc}`);
  };

  // Remove a part, everything below it, and its mirror twin.
  Editor.remove = (part) => {
    if (!part || !Editor.parts.includes(part)) {
      return;
    }
    const gone = new Set(FS.subtree(Editor.parts, part));
    const twin = Build.twinOf(Editor.parts, part);
    if (twin) {
      FS.subtree(Editor.parts, twin).forEach((part) => gone.add(part));
    }
    Editor.parts = Editor.parts.filter((part) => !gone.has(part));
    Editor.sel = part.parent && Editor.parts.includes(part.parent) ? part.parent : null;
    FS.relayout(Editor.parts);
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
    showPartInfo(`The ${part.def.name} is now the root part.`);
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
    const part = Editor.sel && Editor.parts.includes(Editor.sel) ? Editor.sel : null;
    if (!part) {
      showPartInfo('Select a side part (or carry a part) to rotate it.');
      return;
    }
    if (part.node !== 'srf') {
      showPartInfo('Only side parts turn: stack parts line up with the part they sit on.');
      return;
    }
    const hit = Build.moveOnSurface(Editor.parts, part, Build.surfaceHeight(part), part.rot + angle);
    if (hit) {
      showPartInfo(`Can't turn it that far: it would hit the ${hit.def.name}.`);
      return;
    }
    Editor.changed();
    showPartInfo(`${part.def.name} at ${Math.round(spinOf(part) / RADIANS_PER_DEGREE)}°.`);
  };

  // Mirror the carried part, or the selected part, left to right.
  Editor.flip = () => {
    const part = Editor.drag
      ? Editor.drag.root
      : Editor.sel && Editor.parts.includes(Editor.sel)
        ? Editor.sel
        : null;
    if (!part) {
      showPartInfo('Select a part (or carry one) to flip it.');
      return;
    }
    if (part.def.radial) {
      showPartInfo(`The ${part.def.name} always faces away from the part it is on.`);
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

  // Slide a side part along its parent to height ly (snapped if snap is on).
  Editor.offsetTo = (part, alongY) => {
    if (Editor.snap) {
      alongY = Math.abs(alongY) < 0.15 ? 0 : Math.round(alongY * 4) / 4;
    } else {
      alongY = Math.round(alongY * 100) / 100;
    }
    const hit = Build.moveOnSurface(Editor.parts, part, alongY, part.rot);
    if (hit) {
      showPartInfo(`Can't slide further: the ${hit.def.name} is in the way.`);
    } else {
      showPartInfo(
        `${part.def.name}: ${alongY >= 0 ? '+' : ''}${alongY.toFixed(2)} m from the middle of the ${part.parent.def.name}.`,
      );
    }
    return !hit;
  };

  // Keep the selected part, with everything below it, as a subassembly in the tray.
  Editor.saveSub = (part) => {
    if (!part || !Editor.parts.includes(part)) {
      showPartInfo('Select a part to save it, with everything attached below it, as a subassembly.');
      return;
    }
    const group = FS.subtree(Editor.parts, part);
    let name = part.def.name + (group.length > 1 ? ` + ${group.length - 1}` : '');
    const taken = new Set(Editor.subs.map((subassembly) => subassembly.name));
    for (let copyNumber = 2; taken.has(name); copyNumber++) {
      name = `${part.def.name}${group.length > 1 ? ` + ${group.length - 1}` : ''} (${copyNumber})`;
    }
    const serial = FS.serialParts(group);
    for (const serialPart of serial) {
      delete serialPart.stage;
    }
    serial[0].parent = -1;
    serial[0].node = 'bottom';
    Editor.subs.push({ name, parts: serial });
    const saved = FS.store.save('flatspace.subassemblies', Editor.subs);
    Editor.tab = SUB_TAB;
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
      q: part,
      len: part.len,
      size: part.size,
      pos: { ...part.pos },
      rot: part.rot,
      flip: part.flip,
      srfOff: part.srfOff && { ...part.srfOff },
      rel: part.rel,
    }));
  function restoreSnap(snap) {
    for (const saved of snap) {
      Object.assign(saved.q, {
        len: saved.len,
        size: saved.size,
        pos: saved.pos,
        rot: saved.rot,
        flip: saved.flip,
        srfOff: saved.srfOff,
        rel: saved.rel,
      });
      FS.applySize(saved.q);
    }
    FS.relayout(Editor.parts);
  }

  // Where the selected tank's stretch handle is: its free end (away from its parent).
  function handleOf(part) {
    if (!part || !part.def.stretch || !Editor.parts.includes(part) || Editor.drag) {
      return null;
    }
    const axis = FS.partAxis(part.rot);
    const sign = part.node === 'top' && part.parent ? 1 : -1;
    const direction = Vector.scale(axis, sign);
    return {
      pos: Vector.add(part.pos, Vector.scale(direction, part.len / 2 + 10 / Editor.cam.s)),
      dir: direction,
    };
  }

  // Change a tank's length or width, keeping the end it is attached by in place; side parts
  // on it stay on its surface; its mirror twin changes too. Refused if it would make parts
  // overlap. record: add an undo step now (a handle drag records once, when let go).
  function resize(part, change, record) {
    if (!part || !part.def.stretch) {
      return false;
    }
    const twin = Build.twinOf(Editor.parts, part);
    const snap = snapshot(Editor.parts);
    const before = overlaps(Editor.parts);
    const apply = (target) => {
      const axis = FS.partAxis(target.rot);
      const freeTop = target.node === 'top' && target.parent;
      const fixed = Vector.add(target.pos, Vector.scale(axis, ((freeTop ? -1 : 1) * target.len) / 2)); // the end that stays put
      change(target);
      FS.applySize(target);
      if (!target.parent || target.node === 'srf') {
        target.pos = Vector.sub(fixed, Vector.scale(axis, ((freeTop ? -1 : 1) * target.len) / 2));
        FS.syncOffsets([target]);
      }
      FS.relayout(Editor.parts);
      // keep side parts on the (maybe wider) surface
      for (const child of Editor.parts.filter((child) => child.parent === target && child.node === 'srf')) {
        const side = child.srfOff.x < 0 ? -1 : 1;
        const spot = Build.surfaceSpot(target, child, side, child.srfOff.y, child.rot);
        child.pos = spot.pos;
        FS.syncOffsets([child]);
      }
      FS.relayout(Editor.parts);
    };
    apply(part);
    if (twin) {
      apply(twin);
      Build.syncTwin(Editor.parts, part);
    }
    if (overlaps(Editor.parts) > before) {
      restoreSnap(snap);
      showPartInfo(`The ${part.def.name} can't grow there: it would run into another part.`);
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
      `${part.def.name}: ${part.len} m long, ${part.size} m wide, ${(part.cap / 1000).toFixed(2)} t of fuel.`,
    );
    return true;
  }
  Editor.setLength = (part, newLength, record = true) =>
    resize(part, (target) => (target.len = Math.round(newLength / FS.LEN_STEP) * FS.LEN_STEP), record);
  Editor.setWidth = (part, size, record = true) => resize(part, (target) => (target.size = size), record);

  // Set one of a part's settings (and its twin's), e.g. E.setSetting(p, 'limit', 0.5).
  Editor.setSetting = (part, key, value, record = true) => {
    if (!part || !Editor.parts.includes(part)) {
      return;
    }
    for (const target of [part, Build.twinOf(Editor.parts, part)].filter(Boolean)) {
      target[key] = value;
      if (key === 'fill') {
        FS.applySize(target);
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
      Editor.pickNew(press.what.id, worldOf(press.last), press.pointerId, press.what.opts);
    } else {
      Editor.pickGroup(Editor.subs[press.what.sub].parts, worldOf(press.last), press.pointerId);
    }
    Editor.dragTo(worldOf(press.last), overTray(press.last));
  }

  const ptrs = new Map();
  let gesture = null;

  function initPointer() {
    canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      // right-click a part: its settings
      const point = canvasPt(event);
      const hit = Build.partAt(Editor.parts, Editor.toWorld(point.x, point.y), 3 / Editor.cam.s);
      if (hit && !Editor.drag) {
        Editor.sel = hit;
        FS.PartPanel.select(hit, 'editor');
        Editor.render();
      }
    });
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const point = canvasPt(event);
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
      const point = canvasPt(event);
      ptrs.set(event.pointerId, point);
      if (Editor.drag) {
        return;
      }
      if (gesture && gesture.timer) {
        clearTimeout(gesture.timer);
      }
      if (ptrs.size === 2) {
        const [firstPointer, secondPointer] = [...ptrs.values()];
        const midpoint = {
          x: (firstPointer.x + secondPointer.x) / 2,
          y: (firstPointer.y + secondPointer.y) / 2,
        };
        gesture = {
          type: 'pinch',
          d0: Math.hypot(firstPointer.x - secondPointer.x, firstPointer.y - secondPointer.y) || 1,
          s0: Editor.cam.s,
          anchor: Editor.toWorld(midpoint.x, midpoint.y),
        };
        return;
      }
      if (ptrs.size > 2) {
        return;
      }
      if (event.button === 1 || event.button === 2) {
        event.preventDefault();
        gesture = { type: 'pan', last: point };
        return;
      }
      const touch = event.pointerType !== 'mouse';
      // the stretch handle of the selected tank comes first
      const handle = handleOf(Editor.sel);
      if (handle && event.button === 0) {
        const handleScreen = Editor.toScreen(handle.pos);
        if (Math.hypot(handleScreen.x - point.x, handleScreen.y - point.y) < (touch ? 22 : 12)) {
          gesture = {
            type: 'stretch',
            part: Editor.sel,
            len0: Editor.sel.len,
            w0: Editor.toWorld(point.x, point.y),
            dir: handle.dir,
          };
          return;
        }
      }
      const hit = Build.partAt(
        Editor.parts,
        Editor.toWorld(point.x, point.y),
        (touch ? 10 : 3) / Editor.cam.s,
      );
      gesture = {
        type: 'press',
        id: event.pointerId,
        start: point,
        last: point,
        hit,
        touch,
        alt: event.altKey,
        timer: null,
        wasSel: hit && hit === Editor.sel,
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
      if (!ptrs.has(event.pointerId)) {
        return;
      }
      const point = canvasPt(event);
      ptrs.set(event.pointerId, point);
      if (Editor.drag || !gesture) {
        return;
      }
      if (gesture.type === 'pinch' && ptrs.size >= 2) {
        const [firstPointer, secondPointer] = [...ptrs.values()];
        const midpoint = {
          x: (firstPointer.x + secondPointer.x) / 2,
          y: (firstPointer.y + secondPointer.y) / 2,
        };
        Editor.cam.s = FS.clamp(
          (gesture.s0 * Math.hypot(firstPointer.x - secondPointer.x, firstPointer.y - secondPointer.y)) /
            gesture.d0,
          3,
          240,
        );
        // keep the point that was under the fingers under them
        Editor.cam.x = gesture.anchor.x - (midpoint.x - viewWidth / 2) / Editor.cam.s;
        Editor.cam.y = gesture.anchor.y + (midpoint.y - viewHeight / 2) / Editor.cam.s;
        Editor.render();
      } else if (gesture.type === 'pan') {
        Editor.cam.x -= (point.x - gesture.last.x) / Editor.cam.s;
        Editor.cam.y += (point.y - gesture.last.y) / Editor.cam.s;
        gesture.last = point;
        Editor.render();
      } else if (gesture.type === 'offset') {
        slide(point);
      } else if (gesture.type === 'stretch') {
        const world = Editor.toWorld(point.x, point.y);
        const newLength = gesture.len0 + Vector.dot(Vector.sub(world, gesture.w0), gesture.dir);
        Editor.setLength(gesture.part, newLength, false);
      } else if (gesture.type === 'press' && event.pointerId === gesture.id) {
        gesture.last = point;
        const moved = Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y);
        if (moved > (gesture.touch ? 9 : 4)) {
          clearTimeout(gesture.timer);
          const hit = gesture.hit;
          if (hit && (gesture.alt || Editor.offsetMode) && hit.node === 'srf') {
            // Alt-drag (or offset mode): slide the side part along its parent
            const startWorld = Editor.toWorld(gesture.start.x, gesture.start.y);
            const grabLy =
              Vector.dot(Vector.sub(startWorld, hit.parent.pos), FS.partAxis(hit.parent.rot)) -
              Build.surfaceHeight(hit);
            Editor.sel = hit;
            gesture = { type: 'offset', part: hit, grabLy };
            slide(point);
          } else if (hit && gesture.alt && !gesture.touch) {
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
            Editor.cam.x -= (point.x - gesture.last.x) / Editor.cam.s;
            Editor.cam.y += (point.y - gesture.last.y) / Editor.cam.s;
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
        Vector.dot(Vector.sub(world, part.parent.pos), FS.partAxis(part.parent.rot)) - gesture.grabLy;
      Editor.offsetTo(part, alongY);
      Editor.render();
      Editor.updateStats();
    }

    const end = (event) => {
      if (!ptrs.has(event.pointerId)) {
        return;
      }
      ptrs.delete(event.pointerId);
      if (!gesture) {
        return;
      }
      if (gesture.timer) {
        clearTimeout(gesture.timer);
      }
      if (gesture.type === 'press' && event.type === 'pointerup' && event.pointerId === gesture.id) {
        if (gesture.alt && gesture.hit) {
          Editor.copy(gesture.hit, Editor.toWorld(gesture.last.x, gesture.last.y));
        } // Alt-click: copy
        else {
          Editor.sel = gesture.hit;
          showPartInfo(Editor.sel ? `${Editor.sel.def.name}: ${Editor.sel.def.desc}` : hint());
          // selecting a part opens its settings pop-up (unpinned ones give way)
          FS.PartPanel.select(Editor.sel, 'editor');
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
        gesture = ptrs.size === 1 ? { type: 'pan', last: [...ptrs.values()][0] } : null;
      } else if (!ptrs.size) {
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
        if (event.target.closest && event.target.closest('.hangar-tools, .tool-rail, .ovl-chips')) {
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
    Editor.cam.s = FS.clamp(Editor.cam.s * factor, 3, 240);
    const after = Editor.toWorld(point.x, point.y);
    Editor.cam.x += before.x - after.x;
    Editor.cam.y += before.y - after.y;
    Editor.render();
  }

  // Whether a part is fully on screen (above the hangar tools).
  function inView(part) {
    return Build.quad(part).every((corner) => {
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
      Editor.cam = { x: 0, y: -2, s: FS.clamp(viewHeight / 16, 14, 48) };
      return;
    }
    const layout = FS.massLayout(Editor.parts);
    const craftHeight = Math.max(layout.height, 3);
    const craftWidth = Math.max(layout.width, 3);
    Editor.cam.s = FS.clamp(
      Math.min((viewHeight - 130) / craftHeight, (viewWidth - railW - 160) / craftWidth),
      3,
      70,
    );
    // centred in the space right of the tool rail
    Editor.cam.x = layout.com.x + (layout.minX + layout.maxX) / 2 - railW / 2 / Editor.cam.s;
    // a little extra room below, where the hangar tools sit
    Editor.cam.y = layout.com.y + (layout.minY + layout.maxY) / 2 - 22 / Editor.cam.s;
  };

  Editor.changed = () => {
    Editor.normalize();
    FS.PartPanel.rebuildAll('editor', (part) => Editor.parts.includes(part));
    const added = FS.StagingEditor.assignNew(Editor.main());
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
    railW = rail ? rail.offsetLeft + rail.offsetWidth : 0;
    if (needFit) {
      Editor.fit();
    }
    Editor.render();
  };

  // ---------- Drawing ----------
  function drawParts(list, opts) {
    const scale = Editor.cam.s;
    for (const part of list) {
      const screenCentre = Editor.toScreen(part.pos);
      context.save();
      context.translate(screenCentre.x, screenCentre.y);
      context.scale(scale, scale);
      context.rotate(-part.rot);
      if (part.flip) {
        context.scale(-1, 1);
      }
      FS.drawPart(context, part, -part.len / 2, 1 / scale, { selected: opts.sel && part === Editor.sel });
      context.restore();
    }
  }

  function quadPath(part) {
    context.beginPath();
    Build.quad(part).forEach((corner, index) => {
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
  // Exposed for tests: E.overlayData(parts).
  Editor.overlayData = (parts) => {
    if (!parts.length) {
      return null;
    }
    const layout = FS.massLayout(parts);
    const first = FS.stagesOf(parts).find((stage) => stage.ignite);
    const centreOfThrust = first ? FS.centreOfThrust(first.engines) : null;
    let miss = 0;
    if (centreOfThrust) {
      miss = Vector.cross(Vector.sub(layout.com, centreOfThrust.pos), centreOfThrust.dir);
    } // how far the thrust line passes from the centre of mass
    const centreOfPressure = parts.some((part) => part.def.engine) ? FS.centreOfPressure(parts) : null;
    return { com: layout.com, cot: centreOfThrust, miss, cop: centreOfPressure };
  };

  function drawOverlays(parts) {
    const overlay = Editor.overlayData(parts);
    if (!overlay) {
      return;
    }
    if (Editor.overlays.cot && overlay.cot) {
      const screenPoint = Editor.toScreen(overlay.cot.pos);
      const deltaX = overlay.cot.dir.x;
      const deltaY = -overlay.cot.dir.y;
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
      context.arc(screenPoint.x, screenPoint.y, 7, 0, FS.TAU);
      context.fillStyle = '#ff78c8';
      context.fill();
      context.strokeStyle = '#2a0b1f';
      context.lineWidth = 2;
      context.stroke();
    }
    if (Editor.overlays.cop && overlay.cop) {
      const screenPoint = Editor.toScreen(overlay.cop.pos);
      arrow(screenPoint.x, screenPoint.y, 1, 0, 24, '#55d6ff'); // the push of air flowing across the craft
      context.beginPath();
      context.arc(screenPoint.x, screenPoint.y, 7, 0, FS.TAU);
      context.fillStyle = '#55d6ff';
      context.fill();
      context.strokeStyle = '#04222c';
      context.lineWidth = 2;
      context.stroke();
    }
    if (Editor.overlays.com) {
      const massPoint = Editor.toScreen(overlay.com);
      context.beginPath();
      context.arc(massPoint.x, massPoint.y, 8, 0, FS.TAU);
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
    const scale = Editor.cam.s;
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
    FS.PartPanel.layout(
      'editor',
      (part) => (Editor.parts.includes(part) ? Editor.toScreen(part.pos) : null),
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
      const layout = FS.massLayout(main);
      const top = Editor.toScreen({ x: 0, y: layout.com.y + layout.maxY }).y;
      const bottomY = Editor.toScreen({ x: 0, y: layout.com.y + layout.minY }).y;
      const railX = Math.max(railW + 58, Editor.toScreen({ x: layout.com.x + layout.minX, y: 0 }).x - 46);
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
      drawParts(main, { sel: !drag });
      // floating parts: faded if they stay behind, with a dashed outline and a tag
      const floating = parts.filter((part) => !mainSet.has(part));
      for (const part of floating) {
        let root = part;
        while (root.parent) {
          root = root.parent;
        }
        const keep = root.loose === 'keep';
        context.globalAlpha = keep ? 0.95 : 0.5;
        drawParts([part], { sel: !drag });
        context.globalAlpha = 1;
        quadPath(part);
        context.setLineDash([4, 4]);
        context.strokeStyle = keep ? 'rgba(127,224,164,0.85)' : 'rgba(200,215,240,0.55)';
        context.lineWidth = 1.2;
        context.stroke();
        context.setLineDash([]);
        if (part === root) {
          const top = Math.min(...Build.quad(part).map((corner) => Editor.toScreen(corner).y));
          const screenPoint = Editor.toScreen(part.pos);
          context.font = '600 10.5px "Saira Semi Condensed", sans-serif';
          context.textAlign = 'center';
          context.fillStyle = keep ? 'rgba(127,224,164,0.95)' : 'rgba(200,215,240,0.75)';
          context.fillText(keep ? 'FLOATING · LAUNCHES' : 'FLOATING · LEFT BEHIND', screenPoint.x, top - 8);
        }
      }

      // the selected part's mirror twin, outlined
      const handle = handleOf(Editor.sel);
      if (handle) {
        const screenPoint = Editor.toScreen(handle.pos);
        const angle = Math.atan2(-handle.dir.y, handle.dir.x);
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
      const twin = !drag && Editor.sel ? Build.twinOf(parts, Editor.sel) : null;
      if (twin) {
        quadPath(twin);
        context.setLineDash([5, 4]);
        context.strokeStyle = 'rgba(255,181,71,0.7)';
        context.lineWidth = 1.5;
        context.stroke();
        context.setLineDash([]);
      }

      // root marker: a small ring at the root's centre
      const root = parts[0];
      if (root) {
        const screenPoint = Editor.toScreen(root.pos);
        context.strokeStyle = 'rgba(85,214,255,0.85)';
        context.lineWidth = 2;
        context.beginPath();
        context.arc(screenPoint.x, screenPoint.y, 5, 0, FS.TAU);
        context.stroke();
      }

      if (!drag) {
        context.font = '600 11px "Saira Semi Condensed", sans-serif';
        context.textAlign = 'left';
        const labelX = Editor.toScreen({ x: layout.com.x + layout.maxX, y: 0 }).x + 14;
        FS.stagesOf(main).forEach((stage, stageIndex) => {
          const part = stage.parts[0];
          if (!part) {
            return;
          }
          context.fillStyle = 'rgba(255,181,71,0.9)';
          context.fillText('STAGE ' + (stageIndex + 1), labelX, Editor.toScreen(part.pos).y + 4);
        });
      }
    }

    if (drag) {
      // attach points the held part could use
      const heldChildren = FS.childrenOf(drag.held);
      for (const freeNode of Build.freeNodes(parts)) {
        if (
          !Build.nodeFree(drag.held, drag.root, freeNode.node === 'bottom' ? 'top' : 'bottom', heldChildren)
        ) {
          continue;
        }
        const screenPoint = Editor.toScreen(freeNode.pos);
        const isTarget =
          drag.cand &&
          drag.cand.node &&
          drag.cand.node.part === freeNode.part &&
          drag.cand.node.node === freeNode.node;
        context.beginPath();
        context.arc(screenPoint.x, screenPoint.y, isTarget ? 8 : 5, 0, FS.TAU);
        context.fillStyle = isTarget ? 'rgba(255,181,71,0.9)' : 'rgba(85,214,255,0.55)';
        context.fill();
      }
      if (drag.cand && drag.cand.kind === 'srf') {
        // light up the side being attached to
        const corners = Build.quad(drag.cand.parent);
        const [cornerA, cornerB] = drag.cand.side > 0 ? [corners[1], corners[2]] : [corners[0], corners[3]];
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
          quadPath(part);
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
      drag && drag.valid && drag.cand && drag.joinsMain && !drag.overTray
        ? main.concat(drag.held, drag.ghostTwin || [])
        : main;
    drawOverlays(shown);
  };

  function syncButtons() {
    const selected = Editor.sel && Editor.parts.includes(Editor.sel) ? Editor.sel : null;
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
    set('btnRoot', null, !!Editor.drag || !selected || selected === Editor.parts[0]);
    set('btnDel', null, !!Editor.drag || !selected);
    set('btnUndo', null, Editor.hpos <= 0);
    set('btnRedo', null, Editor.hpos >= Editor.history.length - 1);
    set('btnMirror', Editor.mirror);
    set('btnOffset', Editor.offsetMode);
    set('btnSnap', Editor.snap);
    set('btnCopy', null, !!Editor.drag || !selected);
    set('btnSub', null, !!Editor.drag || !selected);
    set('btnSettings', null, !!Editor.drag || !selected);
    for (const overlayName of ['com', 'cot', 'cop']) {
      set('ovl_' + overlayName, Editor.overlays[overlayName]);
    }
  }

  // ---------- Stats ----------
  Editor.updateStats = (parts = Editor.main()) => {
    const stages = FS.stagesOf(parts);
    const vacuumStats = FS.stageStats(parts, stages, 0, 0, 9.81);
    const seaLevelStats = FS.stageStats(parts, stages, 0, 1, 9.81);
    FS.StagingEditor.render(parts, stages, vacuumStats, seaLevelStats, !Editor.drag);
    const layout = FS.massLayout(parts);
    const first = stages.findIndex((stage) => stage.ignite);
    const thrustToWeight = first >= 0 ? seaLevelStats.events[first].twr : 0;
    byId('edTotals').innerHTML =
      `<dt>Total Δv (vacuum)</dt><dd class="dvtot">${vacuumStats.total.toFixed(0)} m/s</dd>
      <dt>Launch TWR</dt><dd${first >= 0 && thrustToWeight < 1 ? ' class="bad"' : ''}>${first >= 0 ? thrustToWeight.toFixed(2) : '—'}</dd>
      <dt>Mass</dt><dd>${(layout.mass / 1000).toFixed(2)} t</dd>
      <dt>Height</dt><dd>${layout.height.toFixed(1)} m</dd>
      <dt>Parts</dt><dd>${parts.length}</dd>${floatNote()}`;
    const warn = [];
    if (parts.length && !parts.some((part) => part.def.command)) {
      warn.push('Add a capsule or probe core so the craft can be controlled.');
    }
    if (parts.length && !parts.some((part) => part.def.engine)) {
      warn.push('No engines yet.');
    }
    if (first >= 0 && thrustToWeight < 1) {
      warn.push('First stage thrust is lower than its weight (TWR under 1). It will not lift off.');
    }
    const kids = FS.childrenOf(parts);
    if (parts.some((part) => part.def.decoupler && !(kids.get(part) || []).length)) {
      warn.push('A decoupler has nothing attached below it.');
    }
    if (
      parts.some((part) => part.def.engine) &&
      !parts.some((part) => part.def.chute) &&
      parts.some((part) => part.def.crew)
    ) {
      warn.push('No parachute. The crew will need one to come home.');
    }
    const overlay = Editor.overlayData(parts);
    if (overlay && overlay.cop && overlay.cop.ahead > 0.05) {
      warn.push(
        `The centre of pressure is ${overlay.cop.ahead.toFixed(1)} m ahead of the centre of mass, so the air will try to turn it sideways and SAS has to hold it straight. Fins near the bottom make it fly straight on its own.`,
      );
    }
    if (overlay && overlay.cot && Math.abs(overlay.miss) > 0.1) {
      warn.push(
        `The first stage's thrust line misses the centre of mass by ${Math.abs(overlay.miss).toFixed(2)} m, so the craft will turn under power.`,
      );
    }
    byId('edWarnings').innerHTML = warn.map((warning) => `<li>${warning}</li>`).join('');
    byId('btnLaunch').disabled = !Editor.parts.length;
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
      .map((root) => ({ parts: FS.serialParts(FS.subtree(Editor.parts, root)) }));
    game.launch({ name: Editor.name, parts: FS.serialParts(Editor.main()), extras });
  };
})();
