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
  const E = (FS.Editor = {});
  const B = FS.Build;
  const V = FS.vec;
  const $ = (id) => document.getElementById(id);
  const SNAP_PX = 34;      // snapping distance on screen
  const LONG_PRESS = 380;  // ms to pick up with a finger
  const HISTORY = 100;     // undo steps
  const SUB_TAB = 'Subassemblies';
  const DEG = Math.PI / 180;
  let cv, ctx, W = 0, H = 0, DPR = 1;
  let game;
  let needFit = true;
  let railW = 0;          // room taken by the tool rail on the left of the build area

  const sampleParts = (c) => (c.tree ? FS.partsFromSerial(c.tree) : FS.stackToParts(c.parts));

  E.name = 'Orbiter I';
  E.parts = [];          // the craft; the first part is the root
  E.sel = null;          // the selected part
  E.cam = { x: 0, y: 0, s: 30 }; // centre of the view (craft frame, m) and pixels per metre
  E.drag = null;         // the parts being carried, if any
  E.tab = FS.PART_CATS[0];
  E.mirror = false;      // mirror symmetry (X)
  E.snap = true;         // snap offsets to 0.25 m and the middle of a side
  E.offsetMode = false;  // dragging a side part slides it (for touch; Alt does it with a mouse)
  E.overlays = { com: true, cot: true, cop: true };
  E.history = [];        // saved craft states, oldest first
  E.hpos = -1;           // the state shown now
  E.subs = [];           // saved subassemblies: [{ name, parts: [saved parts] }]

  // ---------- Coordinates ----------
  E.toScreen = (p) => ({ x: W / 2 + (p.x - E.cam.x) * E.cam.s, y: H / 2 - (p.y - E.cam.y) * E.cam.s });
  E.toWorld = (x, y) => ({ x: E.cam.x + (x - W / 2) / E.cam.s, y: E.cam.y - (y - H / 2) / E.cam.s });
  const canvasPt = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const worldOf = (e) => { const p = canvasPt(e); return E.toWorld(p.x, p.y); };
  const inside = (el, e) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };
  const overTray = (e) => inside(document.querySelector('#editor .palette'), e);

  // ---------- Set-up ----------
  E.init = (g) => {
    game = g;
    cv = $('edCanvas');
    ctx = cv.getContext('2d');
    const saved = FS.store.load('flatspace.current', null);
    if (saved && Array.isArray(saved.parts)) { E.name = saved.name || 'Untitled'; E.parts = FS.partsFromSerial(saved.parts); E.normalize(); }
    else E.parts = sampleParts(FS.SAMPLE_CRAFT[1]);
    E.subs = FS.store.load('flatspace.subassemblies', []) || [];
    const view = FS.store.get('flatspace.editorView', null);
    if (view && view.overlays) Object.assign(E.overlays, view.overlays);
    if (view && typeof view.snap === 'boolean') E.snap = view.snap;
    buildTabs();
    buildPalette();
    refreshLoadList();

    $('craftName').value = E.name;
    $('craftName').addEventListener('input', (e) => { E.name = e.target.value || 'Untitled'; persist(); });
    $('btnLaunch').addEventListener('click', () => E.launch());
    $('btnNew').addEventListener('click', () => {
      E.name = 'Untitled';
      E.parts = [];
      E.sel = null;
      $('craftName').value = E.name;
      E.fit();
      E.changed();
    });
    $('btnSave').addEventListener('click', () => {
      const all = FS.store.load('flatspace.crafts', {});
      all[E.name] = FS.serialParts(E.parts);
      const ok = FS.store.save('flatspace.crafts', all);
      refreshLoadList();
      say(ok ? `Saved “${E.name}”.` : 'Could not save: browser storage is unavailable.');
    });
    $('craftLoad').addEventListener('change', (e) => {
      const v = e.target.value;
      if (!v) return;
      const [kind, name] = v.split('::');
      let parts = null;
      if (kind === 'sample') parts = sampleParts(FS.SAMPLE_CRAFT.find((c) => c.name === name));
      else { const s = FS.store.load('flatspace.crafts', {})[name]; if (s) parts = FS.partsFromSerial(s); }
      if (parts) E.load(name, parts);
      e.target.value = '';
    });
    const on = (id, fn) => $(id).addEventListener('click', fn);
    on('btnFit', () => { E.fit(); E.render(); });
    on('btnRoot', () => E.reroot(E.sel));
    on('btnDel', () => E.remove(E.sel));
    on('btnUndo', () => E.undo());
    on('btnRedo', () => E.redo());
    on('btnMirror', () => E.toggleMirror());
    on('btnRotL', () => E.rotate(15 * DEG));
    on('btnRotR', () => E.rotate(-15 * DEG));
    on('btnFlip', () => E.flip());
    on('btnOffset', () => { E.offsetMode = !E.offsetMode; say(E.offsetMode ? 'Offset on: drag a side part to slide it along its parent.' : hint()); E.render(); });
    on('btnSnap', () => { E.snap = !E.snap; saveView(); say(E.snap ? 'Snap on: offsets move in 0.25 m steps and catch the middle of a side.' : 'Snap off: offsets move freely.'); E.render(); });
    on('btnCopy', () => E.copy(E.sel));
    on('btnSub', () => E.saveSub(E.sel));
    on('btnSettings', () => { if (E.sel) { FS.PartPanel.select(E.sel, 'editor'); E.render(); } else say('Select a part to see its settings.'); });
    on('btnFiles', () => FS.CraftFiles.open());
    FS.PartPanel.init(E);
    FS.CraftFiles.init();
    FS.StagingEditor.init(E);
    for (const k of ['com', 'cot', 'cop']) {
      on('ovl_' + k, () => { E.overlays[k] = !E.overlays[k]; saveView(); E.render(); });
    }
    initPointer();
    window.addEventListener('keydown', onKey);
    E.changed();
  };

  function onKey(e) {
    if (game.scene !== 'editor' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'z') { e.shiftKey ? E.redo() : E.undo(); e.preventDefault(); return; }
    if (mod && k === 'y') { E.redo(); e.preventDefault(); return; }
    if (mod) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && E.sel) { E.remove(E.sel); e.preventDefault(); }
    else if (e.key === 'Escape') { if (E.drag) E.cancelDrag(); else { E.sel = null; E.render(); } }
    else if (e.key === 'Home') { E.fit(); E.render(); }
    else if (k === 'x') E.toggleMirror();
    else if (k === 'q' || k === 'e') E.rotate((k === 'q' ? 1 : -1) * (e.shiftKey ? 5 : 15) * DEG);
    else if (k === 'f') E.flip();
  }

  // The craft proper is the root (the first part) and everything attached to it. Any other
  // tree is a floating part, left where it was dropped; its loose setting says whether it
  // launches with the craft at that spot ('keep') or is left behind ('drop', the default).
  E.main = () => (E.parts.length ? FS.subtree(E.parts, E.parts[0]) : []);
  E.floating = () => { const m = new Set(E.main()); return E.parts.filter((p) => !m.has(p)); };
  // Keep the part list tidy: the root first; every other tree marked as floating.
  E.normalize = () => {
    if (!E.parts.length) return;
    let r = E.parts[0];
    while (r.parent && E.parts.includes(r.parent)) r = r.parent;
    if (r !== E.parts[0]) E.parts = [r].concat(E.parts.filter((q) => q !== r));
    delete r.loose;
    for (const p of E.parts) {
      if (p === r) continue;
      if (!p.parent || !E.parts.includes(p.parent)) { p.parent = null; if (!p.loose) p.loose = 'drop'; }
      else delete p.loose;
    }
  };

  E.load = (name, parts) => {
    E.name = name;
    E.parts = parts;
    E.normalize();
    E.sel = null;
    $('craftName').value = name;
    E.fit();
    E.changed();
  };

  function persist() { FS.store.save('flatspace.current', { name: E.name, parts: FS.serialParts(E.parts) }); }
  function saveView() { FS.store.set('flatspace.editorView', { overlays: E.overlays, snap: E.snap }); }
  function say(text) { $('partInfo').textContent = text; }
  E.say = say;
  E.refreshLoadList = () => refreshLoadList();
  const hint = () => (window.matchMedia && matchMedia('(pointer: coarse)').matches
    ? 'Drag or tap a part in the tray to add it. Hold a placed part to pick it up. Pinch to zoom.'
    : 'Drag parts from the tray. Drag a placed part to move it; drop it on the tray to remove it. Alt-drag slides a side part, Alt-click copies.');

  function refreshLoadList() {
    const sel = $('craftLoad');
    const saved = FS.store.load('flatspace.crafts', {});
    let html = '<option value="">Load craft…</option><optgroup label="Sample craft">';
    for (const c of FS.SAMPLE_CRAFT) html += `<option value="sample::${c.name}">${c.name}</option>`;
    html += '</optgroup>';
    const names = Object.keys(saved);
    if (names.length) {
      html += '<optgroup label="Your craft">';
      for (const n of names) html += `<option value="saved::${n.replace(/"/g, '&quot;')}">${n.replace(/</g, '&lt;')}</option>`;
      html += '</optgroup>';
    }
    sel.innerHTML = html;
  }

  // ---------- History ----------
  // Every change to the craft is kept (up to 100 steps back), so undo reverses anything.
  function record() {
    const state = JSON.stringify(FS.serialParts(E.parts));
    if (state === E.history[E.hpos]) return;
    E.history = E.history.slice(0, E.hpos + 1);
    E.history.push(state);
    if (E.history.length > HISTORY + 1) E.history.shift();
    E.hpos = E.history.length - 1;
  }
  function restore(i) {
    if (E.drag) E.cancelDrag();
    E.hpos = i;
    E.parts = FS.partsFromSerial(JSON.parse(E.history[i]));
    E.sel = null;
    persist();
    FS.PartPanel.rebuildAll('editor', (p) => E.parts.includes(p));
    E.render();
    E.updateStats();
  }
  E.undo = () => { if (E.hpos > 0) { restore(E.hpos - 1); say('Undone.'); } else say('Nothing to undo.'); };
  E.redo = () => { if (E.hpos < E.history.length - 1) { restore(E.hpos + 1); say('Redone.'); } else say('Nothing to redo.'); };

  // ---------- Tray ----------
  function partStat(d) {
    if (d.engine) return `${(d.engine.vac / 1000).toFixed(0)} kN · Isp ${d.engine.ispVac} s`;
    if (d.fuel) return `${(d.fuel / 1000).toFixed(d.fuel < 1000 ? 2 : 1)} t fuel`;
    if (d.command) return d.crew ? `${d.crew} crew · ${(d.mass / 1000).toFixed(2)} t` : `probe · ${(d.mass / 1000).toFixed(2)} t`;
    return `${(d.mass / 1000).toFixed(2)} t`;
  }

  function buildTabs() {
    const host = $('palTabs');
    host.innerHTML = '';
    for (const cat of FS.PART_CATS.concat(SUB_TAB)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pal-tab';
      b.setAttribute('role', 'tab');
      b.textContent = cat;
      b.addEventListener('click', () => { E.tab = cat; buildPalette(); });
      host.appendChild(b);
    }
  }

  function trayButton(label, sub, thumb) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'part-btn';
    const c = document.createElement('canvas');
    c.width = 88; c.height = 104;
    b.appendChild(c);
    const txt = document.createElement('span');
    txt.innerHTML = `<span class="pn"></span><span class="ps"></span>`;
    txt.firstChild.textContent = label;
    txt.lastChild.textContent = sub;
    b.appendChild(txt);
    thumb(c);
    return b;
  }

  function hoverCard(b, show) {
    b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && !E.drag) show(); });
    b.addEventListener('pointerleave', hideCard);
    b.addEventListener('focus', () => { try { if (b.matches(':focus-visible')) show(); } catch (err) { /* no :focus-visible */ } });
    b.addEventListener('blur', hideCard);
  }

  function buildPalette() {
    for (const b of $('palTabs').children) b.setAttribute('aria-selected', String(b.textContent === E.tab));
    const host = $('palette');
    host.innerHTML = '';
    if (E.tab === SUB_TAB) {
      if (!E.subs.length) {
        const p = document.createElement('p');
        p.className = 'pal-empty';
        p.textContent = 'Select a part and press “Save sub” to keep it here, with everything attached below it, for reuse in any craft.';
        host.appendChild(p);
      }
      E.subs.forEach((sub, i) => {
        const parts = FS.partsFromSerial(sub.parts);
        const mass = parts.reduce((s, q) => s + FS.partMass(q), 0);
        const b = trayButton(sub.name, `${parts.length} part${parts.length > 1 ? 's' : ''} · ${(mass / 1000).toFixed(2)} t`, (c) => drawGroupThumb(c, parts));
        b.dataset.sub = String(i);
        b.setAttribute('aria-label', `Subassembly ${sub.name}`);
        b.addEventListener('click', () => { if (suppressClick) { suppressClick = false; return; } say('Drag a subassembly into the build area to add it.'); });
        b.addEventListener('pointerdown', (e) => trayDown(e, { sub: i }));
        hoverCard(b, () => showCard(b, sub.name, 'Saved subassembly', subRows(parts)));
        const row = document.createElement('div');
        row.className = 'sub-row';
        row.appendChild(b);
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'sub-del';
        del.textContent = '×';
        del.title = 'Delete this subassembly';
        del.setAttribute('aria-label', `Delete subassembly ${sub.name}`);
        del.addEventListener('click', () => { E.subs.splice(i, 1); FS.store.save('flatspace.subassemblies', E.subs); buildPalette(); });
        row.appendChild(del);
        host.appendChild(row);
      });
      return;
    }
    if (E.tab === 'Fuel') {
      // tank presets, grouped by width; each is a stretchable tank of its base type
      let width = null;
      FS.DATA.tankPresets.forEach((pr, i) => {
        if (pr.size !== width) {
          width = pr.size;
          const h = document.createElement('div');
          h.className = 'pal-sub';
          h.textContent = `${width} m wide`;
          host.appendChild(h);
        }
        const d = FS.PART[pr.base];
        const opts = { len: pr.len, size: pr.size };
        const sample = FS.newPart(pr.base, opts);
        FS.relayout([sample]);
        const b = trayButton(pr.name, `${(sample.cap / 1000).toFixed(sample.cap < 1000 ? 2 : 1)} t fuel · ${pr.len} × ${pr.size} m`, (c) => drawThumb(c, d, sample));
        b.dataset.preset = String(i);
        if (pr.len === d.len && pr.size === d.w) b.dataset.part = d.id;
        b.setAttribute('aria-label', `${pr.name}: ${d.desc}`);
        b.addEventListener('click', () => { if (suppressClick) { suppressClick = false; return; } E.quickAdd(pr.base, opts); });
        b.addEventListener('pointerdown', (e) => trayDown(e, { id: pr.base, opts }));
        hoverCard(b, () => showCard(b, pr.name, `${d.desc} Stretch it with the handle at its end, and change its width and look in its settings. (KSP: ${pr.ksp}.)`, cardRows(d, sample)));
        host.appendChild(b);
      });
      return;
    }
    for (const d of FS.PARTS.filter((p) => p.cat === E.tab)) {
      const b = trayButton(d.name, partStat(d), (c) => drawThumb(c, d));
      b.dataset.part = d.id;
      b.setAttribute('aria-label', `${d.name}: ${d.desc}`);
      b.addEventListener('click', () => { if (suppressClick) { suppressClick = false; return; } E.quickAdd(d.id); });
      b.addEventListener('pointerdown', (e) => trayDown(e, d.id));
      hoverCard(b, () => showCard(b, d.name, d.desc, cardRows(d)));
      host.appendChild(b);
    }
  }

  function drawThumb(c, d, sample) {
    const g = c.getContext('2d');
    const p = sample || FS.newPart(d.id);
    FS.relayout([p]);
    const s = Math.min(70 / Math.max(p.w + (d.fin && !d.radial ? 1.6 : 0), 0.6), 84 / p.len, 60);
    g.setTransform(s, 0, 0, s, 44, 52 - (p.len * s) / 2);
    FS.drawPart(g, p, 0, 1 / s, {});
  }

  function drawGroupThumb(c, parts) {
    const g = c.getContext('2d');
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of parts) for (const q of B.quad(p)) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    const s = Math.min(80 / Math.max(x1 - x0, 0.5), 96 / Math.max(y1 - y0, 0.5), 60);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    for (const p of parts) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.translate(44 + (p.pos.x - cx) * s, 52 - (p.pos.y - cy) * s);
      g.scale(s, s);
      g.rotate(-p.rot);
      if (p.flip) g.scale(-1, 1);
      FS.drawPart(g, p, -p.len / 2, 1 / s, {});
    }
  }

  // The hover card: everything the tray row has no room for.
  function cardRows(d, p) {
    const rows = [];
    const t = (kg) => (kg / 1000).toFixed(kg < 1000 ? 3 : 2) + ' t';
    const dry = p ? p.dry : d.mass, fuel = p ? p.cap : d.fuel || 0;
    const wet = dry + fuel + (d.solid || 0);
    rows.push(['Mass', wet > dry ? `${t(wet)} (${t(dry)} empty)` : t(dry)]);
    rows.push(['Size', `${p ? p.len : d.len} m long · ${d.w === 'auto' ? 'fits its neighbours' : (p ? p.size : d.w) + ' m wide'}`]);
    if (d.engine) {
      const e = d.engine;
      rows.push(['Thrust', `${(e.asl / 1000).toFixed(0)} kN sea level · ${(e.vac / 1000).toFixed(0)} kN vacuum`]);
      rows.push(['Isp', `${e.ispAsl} s sea level · ${e.ispVac} s vacuum`]);
      if (e.solid) rows.push(['Burn', `${(d.solid / (e.vac / (e.ispVac * FS.G0))).toFixed(0)} s, cannot throttle`]);
      rows.push(['Gimbal', e.gimbal ? `±${e.gimbal}°` : 'none']);
    }
    if (d.fuel) rows.push(['Fuel', t(fuel)]);
    if (d.stretch) rows.push(['Stretchable', `${FS.LEN_STEP} m steps, ${FS.TANK_WIDTHS.length} widths`]);
    if (d.torque) rows.push(['Reaction wheel', `${(d.torque / 1000).toFixed(0)} kN·m`]);
    if (d.chute) rows.push(['Parachute', 'semi-deploys in thick air, opens fully below 1 km']);
    if (d.fin) rows.push(['Fins', `${d.fin} m² of side area`]);
    rows.push(['Crash tolerance', `${d.crash} m/s`]);
    rows.push(['Attaches', d.radial ? 'to the side of a part' : B.hasNode(d, 'top') ? 'above, below or to a side' : 'on top of a part']);
    return rows;
  }
  function subRows(parts) {
    const count = {};
    parts.forEach((p) => (count[p.def.name] = (count[p.def.name] || 0) + 1));
    return Object.entries(count).map(([n, c]) => [c + '×', n]);
  }
  function showCard(btn, title, desc, rows) {
    const card = $('partCard');
    card.innerHTML = '<h3></h3><p></p><dl></dl>';
    card.querySelector('h3').textContent = title;
    card.querySelector('p').textContent = desc;
    card.querySelector('dl').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${String(v).replace(/</g, '&lt;')}</dd>`).join('');
    card.hidden = false;
    const r = btn.getBoundingClientRect();
    const cw = card.offsetWidth || 280, ch = card.offsetHeight || 220;
    let x = r.right + 10, y = r.top;
    if (x + cw > innerWidth - 8) { x = Math.max(8, r.left); y = r.bottom + 8; }
    y = Math.max(8, Math.min(y, innerHeight - ch - 8));
    card.style.left = x + 'px';
    card.style.top = y + 'px';
  }
  function hideCard() { const c = $('partCard'); if (c) c.hidden = true; }

  // ---------- Carrying parts ----------
  // All in craft-frame coordinates, so tests can drive them without a pointer.
  // held: the carried parts, root first. twin: the mirror twin the held parts were picked
  // up with (put back if the drop fails). mirror: whether the drop makes a mirror twin.
  function startDrag(held, root, grab, origin, pointerId, extra = {}) {
    hideCard();
    E.drag = Object.assign({ held, root, grab, origin, pointerId, cand: null, block: null, valid: false, overTray: false, statKey: null, twin: null, ghostTwin: null, world: V.add(root.pos, V.scale(grab, -1)) }, extra);
    E.drag.mirror = E.mirror || !!E.drag.twin;
  }

  // The angle the player has given a side part, as seen on the right-hand side.
  const spinOf = (p) => {
    if (p.node !== 'srf' || !p.parent) return 0;
    const left = p.srfOff && p.srfOff.x < 0;
    return (p.def.radial && left ? -1 : 1) * (p.rel || 0);
  };

  // Pick up a new part from the tray, centred on the pointer.
  E.pickNew = (id, world, pointerId, opts) => {
    const p = FS.newPart(id, opts);
    if (!p) return;
    p.spin = 0;
    FS.relayout([p]);
    startDrag([p], p, { x: 0, y: 0 }, null, pointerId);
    E.dragTo(world);
  };

  // Pick up a copy of a group of saved parts (a subassembly), root first.
  E.pickGroup = (serial, world, pointerId) => {
    const held = B.clone(FS.partsFromSerial(serial));
    if (!held.length) return;
    for (const p of held) delete p.stage; // the craft's own staging decides
    held[0].spin = 0;
    startDrag(held, held[0], { x: 0, y: 0 }, null, pointerId);
    E.dragTo(world);
  };

  // Pick up a placed part, with everything attached below it (and its mirror twin, if any).
  E.pickPart = (p, world, pointerId) => {
    const held = FS.subtree(E.parts, p);
    const set = new Set(held);
    const t = B.twinOf(E.parts, p);
    let twin = null;
    if (t && !set.has(t)) {
      const th = FS.subtree(E.parts, t);
      th.forEach((q) => set.add(q));
      twin = { held: th, root: t, origin: poseOf(t) };
    }
    const origin = poseOf(p);
    const isMain = p === E.parts[0];
    p.spin = spinOf(p);
    E.parts = E.parts.filter((q) => !set.has(q));
    p.parent = null;
    if (p.def.radial) p.flip = false;
    FS.relayout(E.parts);
    FS.relayout(held);
    startDrag(held, p, V.sub(p.pos, world), origin, pointerId, { twin, isMain });
    E.sel = p;
    E.dragTo(world);
  };

  const poseOf = (p) => ({ parent: p.parent, node: p.node, pos: { ...p.pos }, rot: p.rot, flip: p.flip, srfOff: p.srfOff && { ...p.srfOff }, rel: p.rel, loose: p.loose });

  // Carry a copy of a placed part and everything below it (Alt-click, or the Copy button).
  // The copy follows the pointer without a button held and drops on the next click or tap.
  E.copy = (p, world) => {
    if (E.drag) return;
    if (!p || !E.parts.includes(p)) { say('Select a part to copy it, with everything attached below it.'); return; }
    const held = B.clone(FS.subtree(E.parts, p));
    const root = held[0];
    root.spin = spinOf(p);
    if (root.def.radial) root.flip = false;
    const at = world || V.add(p.pos, { x: Math.max(p.w, p.tw) + 1, y: 0 });
    startDrag(held, root, { x: 0, y: 0 }, null, 'carry');
    E.dragTo(at);
    say(`Copy of the ${p.def.name}${held.length > 1 ? ` and ${held.length - 1} more` : ''}: click or tap where it should go. Esc cancels.`);
  };

  E.dragTo = (world, toTray = false) => {
    const d = E.drag;
    if (!d) return;
    d.world = world;
    d.overTray = toTray;
    d.mirror = E.mirror || !!d.twin;
    const free = V.add(world, d.grab);
    B.placeHeld(d.held, d.root, free);
    d.cand = toTray ? null : B.candidate(E.parts, d.held, d.root, free, SNAP_PX / E.cam.s, d.mirror);
    // the whole craft can be moved anywhere
    if (!d.cand && !toTray && d.isMain) d.cand = { kind: 'root', parent: null, pos: { ...free }, rot: d.root.spin || 0, dist: 0 };
    d.block = d.cand ? B.blocker(E.parts, d.held, d.root, d.cand, d.mirror) : null;
    // nothing to attach to: it can be left floating here, if it overlaps nothing
    d.loose = false;
    if (!d.cand && !toTray) {
      B.placeHeld(d.held, d.root, free);
      d.block = E.parts.find((q) => d.held.some((h) => B.overlap(h, q))) || null;
      d.loose = !d.block;
    }
    d.valid = (!!d.cand && !d.block) || d.loose;
    if (d.loose || (d.cand && d.cand.kind === 'root')) B.placeHeld(d.held, d.root, free);
    // the mirror twin's ghost, and live stats for the craft as it would be if dropped here
    d.ghostTwin = null;
    const key = d.loose ? 'loose' : d.valid ? `${d.cand.kind}:${d.cand.parent ? d.cand.parent.uid : 0}:${d.cand.side || 0}:${d.cand.pos.y.toFixed(2)}:${d.cand.rot.toFixed(3)}:${d.mirror}` : 'none';
    if (d.valid && d.cand) {
      const line = d.mirror ? B.mirrorFor(E.parts, d.cand.parent, d.cand.kind) : null;
      let all = B.attach(E.parts, d.held, d.root, d.cand);
      if (line) { d.ghostTwin = B.makeTwin(d.held, line, d.cand.kind); all = all.concat(d.ghostTwin); FS.relayout(all); }
      // the craft it would be part of: the main craft, unless it is dropped onto a floating part
      let r = d.isMain ? d.root : all[0];
      while (r.parent) r = r.parent;
      d.joinsMain = d.isMain || r === E.parts[0];
      if (key !== d.statKey) E.updateStats(FS.subtree(all, r));
      B.detach(E.parts, d.held, d.root);
    } else if (key !== d.statKey) E.updateStats(E.main());
    d.statKey = key;
    const tray = document.querySelector('#editor .palette');
    if (tray) tray.classList.toggle('drop-remove', toTray);
    if (toTray) say(`Release to remove ${d.held.length > 1 || d.twin ? 'these parts' : 'this part'}.`);
    else if (d.block) say(`Can't go there: it would overlap the ${d.block.def.name}.`);
    else if (d.loose) say('Release to leave it floating here. Its settings say whether it launches with the craft or stays behind.');
    else if (!d.cand) say('Bring it next to an attach point or the side of a part.');
    else say(`${d.root.def.name}: release to attach${d.cand.kind === 'srf' ? ' to the side of the ' + d.cand.parent.def.name : d.cand.parent ? ' to the ' + d.cand.parent.def.name : ''}${d.ghostTwin ? ', with a mirror twin' : ''}.`);
    E.render();
  };

  // Attach held parts as cand, with a mirror twin if asked and possible.
  function place(held, root, cand, mirror) {
    const line = mirror ? B.mirrorFor(E.parts, cand.parent, cand.kind) : null;
    E.parts = B.attach(E.parts, held, root, cand);
    const set = new Set(held);
    if (line) {
      const twin = B.makeTwin(held, line, cand.kind);
      B.linkTwins(held, twin);
      E.parts = E.parts.concat(twin);
      FS.relayout(E.parts);
    } else {
      // keep mirror links inside the group; drop links to twins left behind
      for (const h of held) if (h.sym && !held.some((q) => q !== h && q.sym === h.sym)) delete h.sym;
    }
    for (const h of held) delete h.spin;
    return set;
  }

  // Let go of the carried parts.
  E.drop = () => {
    const d = E.drag;
    if (!d) return;
    E.drag = null;
    const tray = document.querySelector('#editor .palette');
    if (tray) tray.classList.remove('drop-remove');
    if (d.overTray) {
      if (d.held.includes(E.sel)) E.sel = null;
      E.changed();
      say(d.origin ? `Removed ${d.held.length + (d.twin ? d.twin.held.length : 0)} parts.` : hint());
      return;
    }
    if (d.valid && d.loose) {
      // left floating where it was dropped
      d.root.parent = null;
      d.root.loose = d.root.loose || 'drop';
      for (const h of d.held) { delete h.spin; if (h.sym && !d.held.some((q) => q !== h && q.sym === h.sym)) delete h.sym; }
      E.parts = E.parts.concat(d.held);
      FS.relayout(E.parts);
      E.sel = d.root;
      E.changed();
      say(`Floating ${d.root.def.name}: it ${d.root.loose === 'keep' ? 'launches with the craft' : 'is left behind at launch'}. Change that in its settings.`);
      return;
    }
    if (d.valid) {
      place(d.held, d.root, d.cand, d.mirror);
      if (d.isMain) { let r = d.root; while (r.parent) r = r.parent; E.parts = [r].concat(E.parts.filter((q) => q !== r)); }
      E.sel = d.root;
      E.changed();
      say(`${d.root.def.name}: ${d.root.def.desc}`);
      return;
    }
    putBack(d);
    E.changed();
    say(d.origin ? "Can't attach there, so it went back where it was." : "Can't attach there, so it went back to the tray.");
  };

  E.cancelDrag = () => {
    const d = E.drag;
    if (!d) return;
    E.drag = null;
    const tray = document.querySelector('#editor .palette');
    if (tray) tray.classList.remove('drop-remove');
    putBack(d);
    E.changed();
    say(hint());
  };

  function putBack(d) {
    if (!d.origin) return; // a new part or a copy simply goes away
    const back = (p, o) => {
      Object.assign(p, { parent: o.parent, node: o.node, pos: o.pos, rot: o.rot, flip: o.flip });
      if (o.srfOff) { p.srfOff = o.srfOff; p.rel = o.rel; } else { delete p.srfOff; delete p.rel; }
      delete p.spin;
    };
    back(d.root, d.origin);
    let all = E.parts.concat(d.held);
    if (d.twin) { back(d.twin.root, d.twin.origin); all = all.concat(d.twin.held); }
    if (d.isMain) all = d.held.concat(all.filter((q) => !d.held.includes(q)));
    if (d.origin.loose) d.root.loose = d.origin.loose;
    E.parts = all;
    FS.relayout(E.parts);
  }

  // Click or tap on a tray part (and the keyboard): attach it somewhere sensible without dragging.
  E.quickAdd = (id, opts) => {
    if (E.drag) return;
    const p = FS.newPart(id, opts);
    if (!p) return;
    FS.relayout([p]);
    const held = [p];
    const tryCand = (cand) => cand && !B.blocker(E.parts, held, p, cand, E.mirror) ? cand : null;
    let cand = null;
    const wasEmpty = !E.parts.length;
    if (wasEmpty) cand = { kind: 'root', parent: null, pos: { x: 0, y: 0 }, rot: 0 };
    else if (p.def.radial) {
      const base = E.sel && E.parts.includes(E.sel) && B.takesSurface(E.sel.def) ? E.sel : null;
      for (const side of [1, -1]) {
        if (cand || !base) break;
        const at = V.add(base.pos, FS.rotV({ x: side * (Math.max(base.w, base.tw) / 2 + p.w / 2), y: 0 }, base.rot));
        const c = B.candidate([base], held, p, at, 0.01);
        cand = tryCand(c && c.kind === 'srf' ? c : null);
      }
      if (!cand) { say(`Select a tank or other part first, then add the ${p.def.name} to its side (or drag it there).`); return; }
    } else {
      // below the selected part if it has room, otherwise at the lowest free node (or the highest, for a parachute)
      const nodes = B.freeNodes(E.parts).filter((n) => B.hasNode(p.def, n.node === 'bottom' ? 'top' : 'bottom'));
      nodes.sort((a, b) => (a.part === E.sel) - (b.part === E.sel) || (p.def.chute ? a.pos.y - b.pos.y : b.pos.y - a.pos.y));
      while (!cand && nodes.length) {
        const n = nodes.pop();
        const ax = FS.partAxis(n.part.rot);
        const at = V.add(n.pos, V.scale(ax, (n.node === 'top' ? 1 : -1) * p.len / 2));
        const c = B.candidate([n.part], held, p, at, 0.05);
        cand = tryCand(c && c.parent === n.part ? c : null);
      }
      if (!cand) { say(`No free attach point for the ${p.def.name}. Drag it onto the side of a part instead.`); return; }
    }
    place(held, p, cand, E.mirror);
    E.sel = p;
    if (wasEmpty || !inView(p)) E.fit();
    E.changed();
    say(`${p.def.name}: ${p.def.desc}`);
  };

  // Remove a part, everything below it, and its mirror twin.
  E.remove = (p) => {
    if (!p || !E.parts.includes(p)) return;
    const gone = new Set(FS.subtree(E.parts, p));
    const t = B.twinOf(E.parts, p);
    if (t) FS.subtree(E.parts, t).forEach((q) => gone.add(q));
    E.parts = E.parts.filter((q) => !gone.has(q));
    E.sel = p.parent && E.parts.includes(p.parent) ? p.parent : null;
    FS.relayout(E.parts);
    E.changed();
    say(`Removed ${gone.size} part${gone.size > 1 ? 's' : ''}.`);
  };

  // Stretch goal of A2: make the selected part the root.
  E.reroot = (p) => {
    if (!p || !E.parts.includes(p) || !p.parent) return;
    B.reroot(E.parts, p);
    E.changed();
    say(`The ${p.def.name} is now the root part.`);
  };

  // ---------- Precision tools ----------
  E.toggleMirror = () => {
    E.mirror = !E.mirror;
    say(E.mirror ? 'Mirror on: parts on the side of a part come in mirrored pairs.' : 'Mirror off.');
    if (E.drag) E.dragTo(E.drag.world, E.drag.overTray); else E.render();
  };

  // Turn the carried part, or the selected side part, by a (radians, counter-clockwise).
  E.rotate = (a) => {
    if (E.drag) {
      E.drag.root.spin = (E.drag.root.spin || 0) + a;
      E.dragTo(E.drag.world, E.drag.overTray);
      return;
    }
    const p = E.sel && E.parts.includes(E.sel) ? E.sel : null;
    if (!p) { say('Select a side part (or carry a part) to rotate it.'); return; }
    if (p.node !== 'srf') { say('Only side parts turn: stack parts line up with the part they sit on.'); return; }
    const hit = B.moveOnSurface(E.parts, p, B.surfaceHeight(p), p.rot + a);
    if (hit) { say(`Can't turn it that far: it would hit the ${hit.def.name}.`); return; }
    E.changed();
    say(`${p.def.name} at ${Math.round(spinOf(p) / DEG)}°.`);
  };

  // Mirror the carried part, or the selected part, left to right.
  E.flip = () => {
    const p = E.drag ? E.drag.root : E.sel && E.parts.includes(E.sel) ? E.sel : null;
    if (!p) { say('Select a part (or carry one) to flip it.'); return; }
    if (p.def.radial) { say(`The ${p.def.name} always faces away from the part it is on.`); return; }
    p.flip = !p.flip;
    if (E.drag) { E.dragTo(E.drag.world, E.drag.overTray); return; }
    B.syncTwin(E.parts, p);
    E.changed();
  };

  // Slide a side part along its parent to height ly (snapped if snap is on).
  E.offsetTo = (p, ly) => {
    if (E.snap) ly = Math.abs(ly) < 0.15 ? 0 : Math.round(ly * 4) / 4;
    else ly = Math.round(ly * 100) / 100;
    const hit = B.moveOnSurface(E.parts, p, ly, p.rot);
    if (hit) say(`Can't slide further: the ${hit.def.name} is in the way.`);
    else say(`${p.def.name}: ${ly >= 0 ? '+' : ''}${ly.toFixed(2)} m from the middle of the ${p.parent.def.name}.`);
    return !hit;
  };

  // Keep the selected part, with everything below it, as a subassembly in the tray.
  E.saveSub = (p) => {
    if (!p || !E.parts.includes(p)) { say('Select a part to save it, with everything attached below it, as a subassembly.'); return; }
    const group = FS.subtree(E.parts, p);
    let name = p.def.name + (group.length > 1 ? ` + ${group.length - 1}` : '');
    const taken = new Set(E.subs.map((s) => s.name));
    for (let k = 2; taken.has(name); k++) name = `${p.def.name}${group.length > 1 ? ` + ${group.length - 1}` : ''} (${k})`;
    const serial = FS.serialParts(group);
    for (const s of serial) delete s.stage;
    serial[0].parent = -1;
    serial[0].node = 'bottom';
    E.subs.push({ name, parts: serial });
    const ok = FS.store.save('flatspace.subassemblies', E.subs);
    E.tab = SUB_TAB;
    buildPalette();
    say(ok ? `Saved “${name}” to Subassemblies in the tray.` : 'Could not save: browser storage is unavailable.');
  };

  // ---------- Tank size and part settings (A4) ----------
  // Pairs of parts that overlap (ignoring each part and its own parent).
  function overlaps(parts) {
    let n = 0;
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i], b = parts[j];
      if (a.parent === b || b.parent === a) continue;
      if (B.overlap(a, b)) n++;
    }
    return n;
  }
  const snapshot = (parts) => parts.map((q) => ({ q, len: q.len, size: q.size, pos: { ...q.pos }, rot: q.rot, flip: q.flip, srfOff: q.srfOff && { ...q.srfOff }, rel: q.rel }));
  function restoreSnap(snap) {
    for (const s of snap) { Object.assign(s.q, { len: s.len, size: s.size, pos: s.pos, rot: s.rot, flip: s.flip, srfOff: s.srfOff, rel: s.rel }); FS.applySize(s.q); }
    FS.relayout(E.parts);
  }

  // Where the selected tank's stretch handle is: its free end (away from its parent).
  function handleOf(p) {
    if (!p || !p.def.stretch || !E.parts.includes(p) || E.drag) return null;
    const ax = FS.partAxis(p.rot);
    const sgn = p.node === 'top' && p.parent ? 1 : -1;
    const dir = V.scale(ax, sgn);
    return { pos: V.add(p.pos, V.scale(dir, p.len / 2 + 10 / E.cam.s)), dir };
  }

  // Change a tank's length or width, keeping the end it is attached by in place; side parts
  // on it stay on its surface; its mirror twin changes too. Refused if it would make parts
  // overlap. record: add an undo step now (a handle drag records once, when let go).
  function resize(p, change, record) {
    if (!p || !p.def.stretch) return false;
    const twin = B.twinOf(E.parts, p);
    const snap = snapshot(E.parts);
    const before = overlaps(E.parts);
    const apply = (q) => {
      const ax = FS.partAxis(q.rot);
      const freeTop = q.node === 'top' && q.parent;
      const fixed = V.add(q.pos, V.scale(ax, (freeTop ? -1 : 1) * q.len / 2)); // the end that stays put
      change(q);
      FS.applySize(q);
      if (!q.parent || q.node === 'srf') {
        q.pos = V.sub(fixed, V.scale(ax, (freeTop ? -1 : 1) * q.len / 2));
        FS.syncOffsets([q]);
      }
      FS.relayout(E.parts);
      // keep side parts on the (maybe wider) surface
      for (const c of E.parts.filter((c) => c.parent === q && c.node === 'srf')) {
        const sd = c.srfOff.x < 0 ? -1 : 1;
        const spot = B.surfaceSpot(q, c, sd, c.srfOff.y, c.rot);
        c.pos = spot.pos;
        FS.syncOffsets([c]);
      }
      FS.relayout(E.parts);
    };
    apply(p);
    if (twin) { apply(twin); B.syncTwin(E.parts, p); }
    if (overlaps(E.parts) > before) {
      restoreSnap(snap);
      say(`The ${p.def.name} can't grow there: it would run into another part.`);
      E.render();
      return false;
    }
    if (record) E.changed(); else { E.render(); E.updateStats(); }
    say(`${p.def.name}: ${p.len} m long, ${p.size} m wide, ${(p.cap / 1000).toFixed(2)} t of fuel.`);
    return true;
  }
  E.setLength = (p, len, record = true) => resize(p, (q) => (q.len = Math.round(len / FS.LEN_STEP) * FS.LEN_STEP), record);
  E.setWidth = (p, size, record = true) => resize(p, (q) => (q.size = size), record);

  // Set one of a part's settings (and its twin's), e.g. E.setSetting(p, 'limit', 0.5).
  E.setSetting = (p, key, value, record = true) => {
    if (!p || !E.parts.includes(p)) return;
    for (const q of [p, B.twinOf(E.parts, p)].filter(Boolean)) {
      q[key] = value;
      if (key === 'fill') FS.applySize(q);
    }
    if (record) E.changed(); else { E.render(); E.updateStats(); }
  };

  // ---------- Pointer and touch ----------
  let suppressClick = false;
  let trayPress = null;

  function trayDown(e, what) {
    if (e.button !== 0 || E.drag) return;
    suppressClick = false;
    trayPress = { what, pointerId: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse', last: e, timer: null };
    if (trayPress.touch) trayPress.timer = setTimeout(() => startTrayDrag(), LONG_PRESS);
  }
  function startTrayDrag() {
    const t = trayPress;
    if (!t) return;
    clearTimeout(t.timer);
    trayPress = null;
    suppressClick = true;
    if (t.touch && navigator.vibrate) navigator.vibrate(12);
    if (typeof t.what === 'string') E.pickNew(t.what, worldOf(t.last), t.pointerId);
    else if (t.what.id) E.pickNew(t.what.id, worldOf(t.last), t.pointerId, t.what.opts);
    else E.pickGroup(E.subs[t.what.sub].parts, worldOf(t.last), t.pointerId);
    E.dragTo(worldOf(t.last), overTray(t.last));
  }

  const ptrs = new Map();
  let gesture = null;

  function initPointer() {
    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // right-click a part: its settings
      const pt = canvasPt(e);
      const hit = B.partAt(E.parts, E.toWorld(pt.x, pt.y), 3 / E.cam.s);
      if (hit && !E.drag) { E.sel = hit; FS.PartPanel.select(hit, 'editor'); E.render(); }
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const pt = canvasPt(e);
      zoomAt(pt, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
    }, { passive: false });

    cv.addEventListener('pointerdown', (e) => {
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* old browsers */ }
      const pt = canvasPt(e);
      ptrs.set(e.pointerId, pt);
      if (E.drag) return;
      if (gesture && gesture.timer) clearTimeout(gesture.timer);
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        gesture = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: E.cam.s, anchor: E.toWorld(mid.x, mid.y) };
        return;
      }
      if (ptrs.size > 2) return;
      if (e.button === 1 || e.button === 2) { e.preventDefault(); gesture = { type: 'pan', last: pt }; return; }
      const touch = e.pointerType !== 'mouse';
      // the stretch handle of the selected tank comes first
      const hd = handleOf(E.sel);
      if (hd && e.button === 0) {
        const hs = E.toScreen(hd.pos);
        if (Math.hypot(hs.x - pt.x, hs.y - pt.y) < (touch ? 22 : 12)) {
          gesture = { type: 'stretch', part: E.sel, len0: E.sel.len, w0: E.toWorld(pt.x, pt.y), dir: hd.dir };
          return;
        }
      }
      const hit = B.partAt(E.parts, E.toWorld(pt.x, pt.y), (touch ? 10 : 3) / E.cam.s);
      gesture = { type: 'press', id: e.pointerId, start: pt, last: pt, hit, touch, alt: e.altKey, timer: null, wasSel: hit && hit === E.sel };
      if (touch && hit && !E.offsetMode) {
        const g0 = gesture;
        g0.timer = setTimeout(() => {
          if (gesture !== g0 || E.drag) return;
          if (navigator.vibrate) navigator.vibrate(12);
          E.pickPart(hit, E.toWorld(g0.start.x, g0.start.y), g0.id);
          E.dragTo(E.toWorld(g0.last.x, g0.last.y));
          gesture = { type: 'drag' };
        }, LONG_PRESS);
      }
    });

    cv.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      const pt = canvasPt(e);
      ptrs.set(e.pointerId, pt);
      if (E.drag || !gesture) return;
      if (gesture.type === 'pinch' && ptrs.size >= 2) {
        const [a, b] = [...ptrs.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        E.cam.s = FS.clamp(gesture.s0 * Math.hypot(a.x - b.x, a.y - b.y) / gesture.d0, 3, 240);
        // keep the point that was under the fingers under them
        E.cam.x = gesture.anchor.x - (mid.x - W / 2) / E.cam.s;
        E.cam.y = gesture.anchor.y + (mid.y - H / 2) / E.cam.s;
        E.render();
      } else if (gesture.type === 'pan') {
        E.cam.x -= (pt.x - gesture.last.x) / E.cam.s;
        E.cam.y += (pt.y - gesture.last.y) / E.cam.s;
        gesture.last = pt;
        E.render();
      } else if (gesture.type === 'offset') {
        slide(pt);
      } else if (gesture.type === 'stretch') {
        const w = E.toWorld(pt.x, pt.y);
        const len = gesture.len0 + V.dot(V.sub(w, gesture.w0), gesture.dir);
        E.setLength(gesture.part, len, false);
      } else if (gesture.type === 'press' && e.pointerId === gesture.id) {
        gesture.last = pt;
        const moved = Math.hypot(pt.x - gesture.start.x, pt.y - gesture.start.y);
        if (moved > (gesture.touch ? 9 : 4)) {
          clearTimeout(gesture.timer);
          const hit = gesture.hit;
          if (hit && (gesture.alt || E.offsetMode) && hit.node === 'srf') {
            // Alt-drag (or offset mode): slide the side part along its parent
            const w0 = E.toWorld(gesture.start.x, gesture.start.y);
            const grabLy = V.dot(V.sub(w0, hit.parent.pos), FS.partAxis(hit.parent.rot)) - B.surfaceHeight(hit);
            E.sel = hit;
            gesture = { type: 'offset', part: hit, grabLy };
            slide(pt);
          } else if (hit && gesture.alt && !gesture.touch) {
            // Alt-drag on any other part: drag a copy
            E.copy(hit, E.toWorld(pt.x, pt.y));
            if (E.drag) E.drag.pointerId = e.pointerId;
            gesture = { type: 'drag' };
          } else if (hit && !gesture.touch && !E.offsetMode) {
            E.pickPart(hit, E.toWorld(gesture.start.x, gesture.start.y), e.pointerId);
            E.dragTo(E.toWorld(pt.x, pt.y));
            gesture = { type: 'drag' };
          } else {
            if (hit && E.offsetMode) say('Offset slides side parts along their parent. Turn Offset off to move this part.');
            gesture = { type: 'pan', last: gesture.start };
            E.cam.x -= (pt.x - gesture.last.x) / E.cam.s;
            E.cam.y += (pt.y - gesture.last.y) / E.cam.s;
            gesture.last = pt;
            E.render();
          }
        }
      }
    });

    function slide(pt) {
      const w = E.toWorld(pt.x, pt.y);
      const p = gesture.part;
      const ly = V.dot(V.sub(w, p.parent.pos), FS.partAxis(p.parent.rot)) - gesture.grabLy;
      E.offsetTo(p, ly);
      E.render();
      E.updateStats();
    }

    const end = (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (!gesture) return;
      if (gesture.timer) clearTimeout(gesture.timer);
      if (gesture.type === 'press' && e.type === 'pointerup' && e.pointerId === gesture.id) {
        if (gesture.alt && gesture.hit) E.copy(gesture.hit, E.toWorld(gesture.last.x, gesture.last.y)); // Alt-click: copy
        else {
          E.sel = gesture.hit;
          say(E.sel ? `${E.sel.def.name}: ${E.sel.def.desc}` : hint());
          // selecting a part opens its settings pop-up (unpinned ones give way)
          FS.PartPanel.select(E.sel, 'editor');
          E.render();
        }
        gesture = null;
      } else if (gesture.type === 'stretch') {
        gesture = null;
        E.changed();
      } else if (gesture.type === 'offset') {
        gesture = null;
        E.changed();
      } else if (gesture.type === 'pinch') {
        // the finger left on the glass carries on panning without a jump
        gesture = ptrs.size === 1 ? { type: 'pan', last: [...ptrs.values()][0] } : null;
      } else if (!ptrs.size) gesture = null;
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);

    // A copy being carried without a button held drops on the next click or tap.
    window.addEventListener('pointerdown', (e) => {
      if (!E.drag || E.drag.pointerId !== 'carry') return;
      if (e.target.closest && e.target.closest('.hangar-tools, .tool-rail, .ovl-chips')) return;
      if (!inside(cv, e) && !overTray(e)) return;
      e.stopPropagation();
      e.preventDefault();
      suppressClick = true;
      E.dragTo(worldOf(e), overTray(e));
      E.drop();
      setTimeout(() => (suppressClick = false), 0);
    }, true);

    // Carrying a part, from the tray or the build area, is followed on the whole window.
    window.addEventListener('pointermove', (e) => {
      if (trayPress && e.pointerId === trayPress.pointerId) {
        trayPress.last = e;
        if (Math.hypot(e.clientX - trayPress.x, e.clientY - trayPress.y) > (trayPress.touch ? 10 : 5)) startTrayDrag();
      }
      if (E.drag && (e.pointerId === E.drag.pointerId || (E.drag.pointerId === 'carry' && e.pointerType !== 'touch'))) E.dragTo(worldOf(e), overTray(e));
    });
    window.addEventListener('pointerup', (e) => {
      if (trayPress && e.pointerId === trayPress.pointerId) { clearTimeout(trayPress.timer); trayPress = null; }
      if (E.drag && e.pointerId === E.drag.pointerId) { E.dragTo(worldOf(e), overTray(e)); E.drop(); }
      // a click that follows this release belongs to the drag; later clicks count again
      if (suppressClick) setTimeout(() => (suppressClick = false), 0);
    });
    // while a finger carries a part, the page and the tray must not scroll
    window.addEventListener('touchmove', (e) => { if (E.drag) e.preventDefault(); }, { passive: false });
    window.addEventListener('pointercancel', (e) => {
      // the browser took the touch to scroll the tray
      if (trayPress && e.pointerId === trayPress.pointerId) { clearTimeout(trayPress.timer); trayPress = null; }
      if (E.drag && e.pointerId === E.drag.pointerId) E.cancelDrag();
    });
  }

  function zoomAt(pt, k) {
    const before = E.toWorld(pt.x, pt.y);
    E.cam.s = FS.clamp(E.cam.s * k, 3, 240);
    const after = E.toWorld(pt.x, pt.y);
    E.cam.x += before.x - after.x;
    E.cam.y += before.y - after.y;
    E.render();
  }

  // Whether a part is fully on screen (above the hangar tools).
  function inView(p) {
    return B.quad(p).every((q) => { const c = E.toScreen(q); return c.x >= 0 && c.x <= W && c.y >= 0 && c.y <= H - 60; });
  }

  // Frame the whole craft.
  E.fit = () => {
    if (!W || !H) { needFit = true; return; }
    needFit = false;
    if (!E.parts.length) { E.cam = { x: 0, y: -2, s: FS.clamp(H / 16, 14, 48) }; return; }
    const lay = FS.massLayout(E.parts);
    const h = Math.max(lay.height, 3), w = Math.max(lay.width, 3);
    E.cam.s = FS.clamp(Math.min((H - 130) / h, (W - railW - 160) / w), 3, 70);
    // centred in the space right of the tool rail
    E.cam.x = lay.com.x + (lay.minX + lay.maxX) / 2 - railW / 2 / E.cam.s;
    // a little extra room below, where the hangar tools sit
    E.cam.y = lay.com.y + (lay.minY + lay.maxY) / 2 - 22 / E.cam.s;
  };

  E.changed = () => {
    E.normalize();
    FS.PartPanel.rebuildAll('editor', (p) => E.parts.includes(p));
    const added = FS.StagingEditor.assignNew(E.main());
    record(); persist(); E.render(); E.updateStats();
    if (added) say(`Staging is custom, so the new part${added > 1 ? 's go' : ' goes'} into a new last stage. Drag ${added > 1 ? 'them' : 'it'} where you want in the stage list.`);
  };

  E.resize = () => {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    const rail = document.querySelector('#editor .tool-rail');
    railW = rail ? rail.offsetLeft + rail.offsetWidth : 0;
    if (needFit) E.fit();
    E.render();
  };

  // ---------- Drawing ----------
  function drawParts(list, opts) {
    const s = E.cam.s;
    for (const p of list) {
      const c = E.toScreen(p.pos);
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.scale(s, s);
      ctx.rotate(-p.rot);
      if (p.flip) ctx.scale(-1, 1);
      FS.drawPart(ctx, p, -p.len / 2, 1 / s, { selected: opts.sel && p === E.sel });
      ctx.restore();
    }
  }

  function quadPath(p) {
    ctx.beginPath();
    B.quad(p).forEach((q, i) => { const c = E.toScreen(q); if (i) ctx.lineTo(c.x, c.y); else ctx.moveTo(c.x, c.y); });
    ctx.closePath();
  }

  function arrow(x, y, dx, dy, len, color) {
    const l = Math.hypot(dx, dy) || 1;
    const ux = dx / l, uy = dy / l;
    const tx = x + ux * len, ty = y + uy * len;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(tx, ty); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tx + ux * 9, ty + uy * 9);
    ctx.lineTo(tx - uy * 6, ty + ux * 6);
    ctx.lineTo(tx + uy * 6, ty - ux * 6);
    ctx.closePath(); ctx.fill();
  }

  // Centre of mass, centre of thrust (with its thrust line) and centre of pressure.
  // Exposed for tests: E.overlayData(parts).
  E.overlayData = (parts) => {
    if (!parts.length) return null;
    const lay = FS.massLayout(parts);
    const first = FS.stagesOf(parts).find((ev) => ev.ignite);
    const cot = first ? FS.centreOfThrust(first.engines) : null;
    let miss = 0;
    if (cot) miss = V.cross(V.sub(lay.com, cot.pos), cot.dir); // how far the thrust line passes from the centre of mass
    const cop = parts.some((p) => p.def.engine) ? FS.centreOfPressure(parts) : null;
    return { com: lay.com, cot, miss, cop };
  };

  function drawOverlays(parts) {
    const o = E.overlayData(parts);
    if (!o) return;
    if (E.overlays.cot && o.cot) {
      const c = E.toScreen(o.cot.pos);
      const dx = o.cot.dir.x, dy = -o.cot.dir.y;
      // the thrust line, through the whole view
      ctx.setLineDash([7, 6]);
      ctx.strokeStyle = 'rgba(255,120,200,0.55)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(c.x - dx * 3000, c.y - dy * 3000); ctx.lineTo(c.x + dx * 3000, c.y + dy * 3000); ctx.stroke();
      ctx.setLineDash([]);
      arrow(c.x, c.y, -dx, -dy, 26, '#ff78c8'); // the exhaust direction, as in KSP
      ctx.beginPath(); ctx.arc(c.x, c.y, 7, 0, FS.TAU); ctx.fillStyle = '#ff78c8'; ctx.fill();
      ctx.strokeStyle = '#2a0b1f'; ctx.lineWidth = 2; ctx.stroke();
    }
    if (E.overlays.cop && o.cop) {
      const c = E.toScreen(o.cop.pos);
      arrow(c.x, c.y, 1, 0, 24, '#55d6ff'); // the push of air flowing across the craft
      ctx.beginPath(); ctx.arc(c.x, c.y, 7, 0, FS.TAU); ctx.fillStyle = '#55d6ff'; ctx.fill();
      ctx.strokeStyle = '#04222c'; ctx.lineWidth = 2; ctx.stroke();
    }
    if (E.overlays.com) {
      const cm = E.toScreen(o.com);
      ctx.beginPath(); ctx.arc(cm.x, cm.y, 8, 0, FS.TAU);
      ctx.fillStyle = '#ffd34d'; ctx.fill();
      ctx.fillStyle = '#1b1405';
      ctx.beginPath(); ctx.moveTo(cm.x, cm.y); ctx.arc(cm.x, cm.y, 8, 0, Math.PI / 2); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(cm.x, cm.y); ctx.arc(cm.x, cm.y, 8, Math.PI, Math.PI * 1.5); ctx.closePath(); ctx.fill();
    }
  }

  E.render = () => {
    if (!ctx || !W) return;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0f1a33'); bg.addColorStop(1, '#0a1224');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

    // grid, fixed to the craft frame so it pans and zooms with the craft: 1 m lines, brighter every 5 m
    const s = E.cam.s;
    const step = s >= 10 ? 1 : 5;
    const tl = E.toWorld(0, 0), br = E.toWorld(W, H);
    ctx.lineWidth = 1;
    for (let gx = Math.floor(tl.x / step) * step; gx <= br.x; gx += step) {
      const x = Math.round(E.toScreen({ x: gx, y: 0 }).x) + 0.5;
      ctx.strokeStyle = Math.round(gx) % 5 === 0 ? 'rgba(120,160,230,0.13)' : 'rgba(120,160,230,0.06)';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let gy = Math.floor(br.y / step) * step; gy <= tl.y; gy += step) {
      const y = Math.round(E.toScreen({ x: 0, y: gy }).y) + 0.5;
      ctx.strokeStyle = Math.round(gy) % 5 === 0 ? 'rgba(120,160,230,0.13)' : 'rgba(120,160,230,0.06)';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    syncButtons();
    FS.PartPanel.layout('editor', (p) => (E.parts.includes(p) ? E.toScreen(p.pos) : null), !!E.drag);
    const parts = E.parts;
    const d = E.drag;
    if (!parts.length && !d) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(200,215,240,0.6)';
      ctx.font = '500 15px Barlow, system-ui, sans-serif';
      ctx.fillText('Drag a part here to start your rocket.', W / 2, H / 2 - 10);
      ctx.font = '400 13px Barlow, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(200,215,240,0.45)';
      ctx.fillText('The first part you place becomes the root.', W / 2, H / 2 + 14);
      return;
    }

    const main = E.main(), mainSet = new Set(main);
    if (parts.length) {
      const lay = FS.massLayout(main);
      const top = E.toScreen({ x: 0, y: lay.com.y + lay.maxY }).y;
      const bot = E.toScreen({ x: 0, y: lay.com.y + lay.minY }).y;
      const rx = Math.max(railW + 58, E.toScreen({ x: lay.com.x + lay.minX, y: 0 }).x - 46);
      // height ruler
      ctx.strokeStyle = 'rgba(200,215,240,0.4)';
      ctx.fillStyle = 'rgba(200,215,240,0.65)';
      ctx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.beginPath(); ctx.moveTo(rx + 0.5, top); ctx.lineTo(rx + 0.5, bot); ctx.stroke();
      const tick = lay.height * s > 400 ? (s < 12 ? 10 : 5) : lay.height > 30 ? 5 : lay.height > 12 ? 2 : 1;
      for (let m = 0; m <= lay.height + 0.001; m += tick) {
        const y = bot - m * s;
        ctx.beginPath(); ctx.moveTo(rx - 5, y + 0.5); ctx.lineTo(rx + 0.5, y + 0.5); ctx.stroke();
        ctx.fillText(m + ' m', rx - 8, y + 4);
      }
      drawParts(main, { sel: !d });
      // floating parts: faded if they stay behind, with a dashed outline and a tag
      const floating = parts.filter((p) => !mainSet.has(p));
      for (const p of floating) {
        let r = p; while (r.parent) r = r.parent;
        const keep = r.loose === 'keep';
        ctx.globalAlpha = keep ? 0.95 : 0.5;
        drawParts([p], { sel: !d });
        ctx.globalAlpha = 1;
        quadPath(p);
        ctx.setLineDash([4, 4]); ctx.strokeStyle = keep ? 'rgba(127,224,164,0.85)' : 'rgba(200,215,240,0.55)'; ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]);
        if (p === r) {
          const top = Math.min(...B.quad(p).map((q) => E.toScreen(q).y));
          const c = E.toScreen(p.pos);
          ctx.font = '600 10.5px "Saira Semi Condensed", sans-serif';
          ctx.textAlign = 'center';
          ctx.fillStyle = keep ? 'rgba(127,224,164,0.95)' : 'rgba(200,215,240,0.75)';
          ctx.fillText(keep ? 'FLOATING · LAUNCHES' : 'FLOATING · LEFT BEHIND', c.x, top - 8);
        }
      }

      // the selected part's mirror twin, outlined
      const hd = handleOf(E.sel);
      if (hd) {
        const c = E.toScreen(hd.pos);
        const ang = Math.atan2(-hd.dir.y, hd.dir.x);
        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.rotate(ang);
        ctx.fillStyle = '#ffb547'; ctx.strokeStyle = '#241500'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-9, -13, 18, 26, 6) : ctx.rect(-9, -13, 18, 26); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#241500';
        ctx.beginPath(); ctx.moveTo(-5, -5); ctx.lineTo(5, -5); ctx.moveTo(-5, 0); ctx.lineTo(5, 0); ctx.moveTo(-5, 5); ctx.lineTo(5, 5);
        ctx.strokeStyle = '#241500'; ctx.lineWidth = 1.6; ctx.stroke();
        ctx.restore();
      }
      const twin = !d && E.sel ? B.twinOf(parts, E.sel) : null;
      if (twin) {
        quadPath(twin);
        ctx.setLineDash([5, 4]); ctx.strokeStyle = 'rgba(255,181,71,0.7)'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
      }

      // root marker: a small ring at the root's centre
      const root = parts[0];
      if (root) {
        const c = E.toScreen(root.pos);
        ctx.strokeStyle = 'rgba(85,214,255,0.85)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(c.x, c.y, 5, 0, FS.TAU); ctx.stroke();
      }

      if (!d) {
        ctx.font = '600 11px "Saira Semi Condensed", sans-serif';
        ctx.textAlign = 'left';
        const x = E.toScreen({ x: lay.com.x + lay.maxX, y: 0 }).x + 14;
        FS.stagesOf(main).forEach((ev, k) => {
          const p = ev.parts[0];
          if (!p) return;
          ctx.fillStyle = 'rgba(255,181,71,0.9)';
          ctx.fillText('STAGE ' + (k + 1), x, E.toScreen(p.pos).y + 4);
        });
      }
    }

    if (d) {
      // attach points the held part could use
      const hk = FS.childrenOf(d.held);
      for (const n of B.freeNodes(parts)) {
        if (!B.nodeFree(d.held, d.root, n.node === 'bottom' ? 'top' : 'bottom', hk)) continue;
        const c = E.toScreen(n.pos);
        const on = d.cand && d.cand.node && d.cand.node.part === n.part && d.cand.node.node === n.node;
        ctx.beginPath(); ctx.arc(c.x, c.y, on ? 8 : 5, 0, FS.TAU);
        ctx.fillStyle = on ? 'rgba(255,181,71,0.9)' : 'rgba(85,214,255,0.55)';
        ctx.fill();
      }
      if (d.cand && d.cand.kind === 'srf') {
        // light up the side being attached to
        const q = B.quad(d.cand.parent);
        const [a, b] = d.cand.side > 0 ? [q[1], q[2]] : [q[0], q[3]];
        const A = E.toScreen(a), Bp = E.toScreen(b);
        ctx.strokeStyle = d.valid ? 'rgba(255,181,71,0.95)' : 'rgba(255,107,90,0.9)';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(Bp.x, Bp.y); ctx.stroke();
      }
      if (!d.overTray) {
        const ghosts = d.held.concat(d.ghostTwin || []);
        ctx.globalAlpha = 0.82;
        drawParts(ghosts, {});
        ctx.globalAlpha = 1;
        const ok = d.valid;
        for (const p of ghosts) {
          quadPath(p);
          ctx.fillStyle = ok ? 'rgba(85,214,255,0.10)' : 'rgba(255,80,60,0.38)';
          ctx.fill();
          ctx.strokeStyle = ok ? 'rgba(85,214,255,0.8)' : 'rgba(255,107,90,0.95)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }

    // overlays: for the craft as it would be if the carried part were dropped here
    const shown = d && d.valid && d.cand && d.joinsMain && !d.overTray ? main.concat(d.held, d.ghostTwin || []) : main;
    drawOverlays(shown);
  };

  function syncButtons() {
    const sel = E.sel && E.parts.includes(E.sel) ? E.sel : null;
    const set = (id, pressed, disabled) => {
      const b = $(id);
      if (!b) return;
      if (pressed !== null) b.setAttribute('aria-pressed', String(pressed));
      if (disabled !== undefined) b.disabled = disabled;
    };
    set('btnRoot', null, !!E.drag || !sel || sel === E.parts[0]);
    set('btnDel', null, !!E.drag || !sel);
    set('btnUndo', null, E.hpos <= 0);
    set('btnRedo', null, E.hpos >= E.history.length - 1);
    set('btnMirror', E.mirror);
    set('btnOffset', E.offsetMode);
    set('btnSnap', E.snap);
    set('btnCopy', null, !!E.drag || !sel);
    set('btnSub', null, !!E.drag || !sel);
    set('btnSettings', null, !!E.drag || !sel);
    for (const k of ['com', 'cot', 'cop']) set('ovl_' + k, E.overlays[k]);
  }

  // ---------- Stats ----------
  E.updateStats = (parts = E.main()) => {
    const stages = FS.stagesOf(parts);
    const sv = FS.stageStats(parts, stages, 0, 0, 9.81);
    const sa = FS.stageStats(parts, stages, 0, 1, 9.81);
    FS.StagingEditor.render(parts, stages, sv, sa, !E.drag);
    const lay = FS.massLayout(parts);
    const first = stages.findIndex((e) => e.ignite);
    const twr = first >= 0 ? sa.events[first].twr : 0;
    $('edTotals').innerHTML = `<dt>Total Δv (vacuum)</dt><dd class="dvtot">${sv.total.toFixed(0)} m/s</dd>
      <dt>Launch TWR</dt><dd${first >= 0 && twr < 1 ? ' class="bad"' : ''}>${first >= 0 ? twr.toFixed(2) : '—'}</dd>
      <dt>Mass</dt><dd>${(lay.mass / 1000).toFixed(2)} t</dd>
      <dt>Height</dt><dd>${lay.height.toFixed(1)} m</dd>
      <dt>Parts</dt><dd>${parts.length}</dd>${floatNote()}`;
    const warn = [];
    if (parts.length && !parts.some((p) => p.def.command)) warn.push('Add a capsule or probe core so the craft can be controlled.');
    if (parts.length && !parts.some((p) => p.def.engine)) warn.push('No engines yet.');
    if (first >= 0 && twr < 1) warn.push('First stage thrust is lower than its weight (TWR under 1). It will not lift off.');
    const kids = FS.childrenOf(parts);
    if (parts.some((p) => p.def.decoupler && !(kids.get(p) || []).length)) warn.push('A decoupler has nothing attached below it.');
    if (parts.some((p) => p.def.engine) && !parts.some((p) => p.def.chute) && parts.some((p) => p.def.crew)) warn.push('No parachute. The crew will need one to come home.');
    const o = E.overlayData(parts);
    if (o && o.cop && o.cop.ahead > 0.05) warn.push(`The centre of pressure is ${o.cop.ahead.toFixed(1)} m ahead of the centre of mass, so the air will try to turn it sideways and SAS has to hold it straight. Fins near the bottom make it fly straight on its own.`);
    if (o && o.cot && Math.abs(o.miss) > 0.1) warn.push(`The first stage's thrust line misses the centre of mass by ${Math.abs(o.miss).toFixed(2)} m, so the craft will turn under power.`);
    $('edWarnings').innerHTML = warn.map((w) => `<li>${w}</li>`).join('');
    $('btnLaunch').disabled = !E.parts.length;
  };
  function floatNote() {
    const roots = E.floating().filter((p) => !p.parent);
    if (!roots.length) return '';
    const keep = roots.filter((p) => p.loose === 'keep').length;
    return `<dt>Floating</dt><dd>${roots.length} (${keep} launch${keep === 1 ? 'es' : ''})</dd>`;
  }

  E.launch = () => {
    if (!E.parts.length) return;
    persist();
    // floating parts set to launch come along as separate objects, where they were placed
    const extras = E.floating().filter((p) => !p.parent && p.loose === 'keep').map((r) => ({ parts: FS.serialParts(FS.subtree(E.parts, r)) }));
    game.launch({ name: E.name, parts: FS.serialParts(E.main()), extras });
  };
})();
