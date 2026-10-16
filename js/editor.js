// editor.js — the Vehicle Assembly hangar: build a craft by dragging parts, see Δv per stage, launch.
// Layout: part tray (category tabs, hover cards) · build area (pan, zoom, no size limit) · stats.
// The attach geometry (snapping, overlap, re-rooting) lives in build.js.
//
// Mouse: drag a part from the tray; drag a placed part to move it with everything below it;
// drop on the tray to remove; drag empty space (or middle/right-drag) to pan; wheel to zoom.
// Touch: hold a part to pick it up; one finger pans, two fingers pan and pinch-zoom.
(function () {
  const E = (FS.Editor = {});
  const B = FS.Build;
  const V = FS.vec;
  const $ = (id) => document.getElementById(id);
  const SNAP_PX = 34;      // snapping distance on screen
  const LONG_PRESS = 380;  // ms to pick up with a finger
  let cv, ctx, W = 0, H = 0, DPR = 1;
  let game;
  let needFit = true;

  const sampleParts = (c) => (c.tree ? FS.partsFromSerial(c.tree) : FS.stackToParts(c.parts));

  E.name = 'Orbiter I';
  E.parts = [];          // the craft; the first part is the root
  E.sel = null;          // the selected part
  E.cam = { x: 0, y: 0, s: 30 }; // centre of the view (craft frame, m) and pixels per metre
  E.drag = null;         // the part being carried, if any
  E.tab = FS.PART_CATS[0];

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
    if (saved && Array.isArray(saved.parts)) { E.name = saved.name || 'Untitled'; E.parts = FS.partsFromSerial(saved.parts); }
    else E.parts = sampleParts(FS.SAMPLE_CRAFT[1]);
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
    $('btnFit').addEventListener('click', () => { E.fit(); E.render(); });
    $('btnRoot').addEventListener('click', () => E.reroot(E.sel));
    $('btnDel').addEventListener('click', () => E.remove(E.sel));
    initPointer();
    window.addEventListener('keydown', (e) => {
      if (game.scene !== 'editor' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && E.sel) { E.remove(E.sel); e.preventDefault(); }
      if (e.key === 'Escape') { if (E.drag) E.cancelDrag(); else { E.sel = null; E.render(); } }
      if (e.key === 'Home') { E.fit(); E.render(); }
    });
    E.changed();
  };

  E.load = (name, parts) => {
    E.name = name;
    E.parts = parts;
    E.sel = null;
    $('craftName').value = name;
    E.fit();
    E.changed();
  };

  function persist() { FS.store.save('flatspace.current', { name: E.name, parts: FS.serialParts(E.parts) }); }
  function say(text) { $('partInfo').textContent = text; }
  const hint = () => (window.matchMedia && matchMedia('(pointer: coarse)').matches
    ? 'Drag or tap a part in the tray to add it. Hold a placed part to pick it up. Pinch to zoom.'
    : 'Drag parts from the tray. Drag a placed part to move it; drop it on the tray to remove it. Wheel zooms, dragging empty space pans.');

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
    for (const cat of FS.PART_CATS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pal-tab';
      b.setAttribute('role', 'tab');
      b.textContent = cat;
      b.addEventListener('click', () => { E.tab = cat; buildPalette(); });
      host.appendChild(b);
    }
  }

  function buildPalette() {
    for (const b of $('palTabs').children) b.setAttribute('aria-selected', String(b.textContent === E.tab));
    const host = $('palette');
    host.innerHTML = '';
    for (const d of FS.PARTS.filter((p) => p.cat === E.tab)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'part-btn';
      b.dataset.part = d.id;
      b.setAttribute('aria-label', `${d.name}: ${d.desc}`);
      const c = document.createElement('canvas');
      c.width = 88; c.height = 104;
      b.appendChild(c);
      const txt = document.createElement('span');
      txt.innerHTML = `<span class="pn">${d.name}</span><span class="ps">${partStat(d)}</span>`;
      b.appendChild(txt);
      b.addEventListener('click', () => { if (suppressClick) { suppressClick = false; return; } E.quickAdd(d.id); });
      b.addEventListener('pointerdown', (e) => trayDown(e, d.id));
      b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && !E.drag) showCard(b, d); });
      b.addEventListener('pointerleave', hideCard);
      b.addEventListener('focus', () => { try { if (b.matches(':focus-visible')) showCard(b, d); } catch (err) { /* no :focus-visible */ } });
      b.addEventListener('blur', hideCard);
      host.appendChild(b);
      drawThumb(c, d);
    }
  }

  function drawThumb(c, d) {
    const g = c.getContext('2d');
    const p = FS.newPart(d.id);
    FS.relayout([p]);
    const s = Math.min(70 / Math.max(p.w + (d.fin ? 1.6 : 0), 0.6), 84 / d.len, 60);
    g.setTransform(s, 0, 0, s, 44, 52 - (d.len * s) / 2);
    FS.drawPart(g, p, 0, 1 / s, {});
  }

  // The hover card: everything the tray row has no room for.
  function cardRows(d) {
    const rows = [];
    const t = (kg) => (kg / 1000).toFixed(kg < 1000 ? 3 : 2) + ' t';
    const wet = d.mass + (d.fuel || 0) + (d.solid || 0);
    rows.push(['Mass', wet > d.mass ? `${t(wet)} (${t(d.mass)} empty)` : t(d.mass)]);
    rows.push(['Size', `${d.len} m long · ${d.w === 'auto' ? 'fits its neighbours' : d.w + ' m wide'}`]);
    if (d.engine) {
      const e = d.engine;
      rows.push(['Thrust', `${(e.asl / 1000).toFixed(0)} kN sea level · ${(e.vac / 1000).toFixed(0)} kN vacuum`]);
      rows.push(['Isp', `${e.ispAsl} s sea level · ${e.ispVac} s vacuum`]);
      if (e.solid) rows.push(['Burn', `${(d.solid / (e.vac / (e.ispVac * FS.G0))).toFixed(0)} s, cannot throttle`]);
      rows.push(['Gimbal', e.gimbal ? `±${e.gimbal}°` : 'none']);
    }
    if (d.fuel) rows.push(['Fuel', t(d.fuel)]);
    if (d.torque) rows.push(['Reaction wheel', `${(d.torque / 1000).toFixed(0)} kN·m`]);
    if (d.chute) rows.push(['Parachute', 'semi-deploys in thick air, opens fully below 1 km']);
    if (d.fin) rows.push(['Fins', `${d.fin} m² of side area`]);
    rows.push(['Crash tolerance', `${d.crash} m/s`]);
    rows.push(['Attaches', d.radial ? 'to the side of a part' : B.hasNode(d, 'top') ? 'above, below or to a side' : 'on top of a part']);
    return rows;
  }
  function showCard(btn, d) {
    const card = $('partCard');
    card.innerHTML = `<h3>${d.name}</h3><p>${d.desc}</p><dl>${cardRows(d).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
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
  function startDrag(held, root, grab, origin, pointerId) {
    hideCard();
    E.drag = { held, root, grab, origin, pointerId, cand: null, block: null, valid: false, overTray: false, statKey: null };
  }

  // Pick up a new part from the tray, centred on the pointer.
  E.pickNew = (id, world, pointerId) => {
    const p = FS.newPart(id);
    if (!p) return;
    FS.relayout([p]);
    startDrag([p], p, { x: 0, y: 0 }, null, pointerId);
    E.dragTo(world);
  };

  // Pick up a placed part, with everything attached below it.
  E.pickPart = (p, world, pointerId) => {
    const held = FS.subtree(E.parts, p);
    const set = new Set(held);
    const origin = { parent: p.parent, node: p.node, pos: { ...p.pos }, rot: p.rot, flip: p.flip, srfOff: p.srfOff && { ...p.srfOff } };
    E.parts = E.parts.filter((q) => !set.has(q));
    p.parent = null;
    FS.relayout(E.parts);
    FS.relayout(held);
    startDrag(held, p, V.sub(p.pos, world), origin, pointerId);
    E.sel = p;
    E.dragTo(world);
  };

  E.dragTo = (world, toTray = false) => {
    const d = E.drag;
    if (!d) return;
    d.overTray = toTray;
    const free = V.add(world, d.grab);
    B.placeHeld(d.held, d.root, free);
    d.cand = toTray ? null : B.candidate(E.parts, d.held, d.root, free, SNAP_PX / E.cam.s);
    d.block = d.cand ? B.blocker(E.parts, d.held, d.root, d.cand) : null;
    d.valid = !!d.cand && !d.block;
    if (d.cand && d.cand.kind === 'root') B.placeHeld(d.held, d.root, free);
    // live stats: the craft as it would be if dropped here
    const key = d.valid ? `${d.cand.kind}:${d.cand.parent ? d.cand.parent.uid : 0}:${d.cand.side || 0}:${d.cand.pos.y.toFixed(2)}` : 'none';
    if (key !== d.statKey) {
      d.statKey = key;
      if (d.valid) {
        const all = B.attach(E.parts, d.held, d.root, d.cand);
        E.updateStats(all);
        B.detach(E.parts, d.held, d.root);
      } else E.updateStats(E.parts);
    }
    const tray = document.querySelector('#editor .palette');
    if (tray) tray.classList.toggle('drop-remove', toTray);
    if (toTray) say(`Release to remove ${d.held.length > 1 ? 'these ' + d.held.length + ' parts' : 'this part'}.`);
    else if (d.block) say(`Can't go there: it would overlap the ${d.block.def.name}.`);
    else if (!d.cand) say('Bring it next to an attach point or the side of a part.');
    else say(`${d.root.def.name}: release to attach${d.cand.kind === 'srf' ? ' to the side of the ' + d.cand.parent.def.name : d.cand.parent ? ' to the ' + d.cand.parent.def.name : ''}.`);
    E.render();
  };

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
      say(d.origin ? `Removed ${d.held.length} part${d.held.length > 1 ? 's' : ''}.` : hint());
      return;
    }
    if (d.valid) {
      E.parts = B.attach(E.parts, d.held, d.root, d.cand);
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
  };

  function putBack(d) {
    if (!d.origin) return; // a new part simply goes back to the tray
    const o = d.origin, p = d.root;
    Object.assign(p, { parent: o.parent, node: o.node, pos: o.pos, rot: o.rot, flip: o.flip });
    if (o.srfOff) p.srfOff = o.srfOff; else delete p.srfOff;
    E.parts = E.parts.concat(d.held);
    if (!o.parent) { E.parts = d.held.concat(E.parts.filter((q) => !d.held.includes(q))); }
    FS.relayout(E.parts);
  }

  // Click or tap on a tray part (and the keyboard): attach it somewhere sensible without dragging.
  E.quickAdd = (id) => {
    const p = FS.newPart(id);
    if (!p) return;
    FS.relayout([p]);
    const held = [p];
    const tryCand = (cand) => cand && !B.blocker(E.parts, held, p, cand) ? cand : null;
    let cand = null;
    const wasEmpty = !E.parts.length;
    if (wasEmpty) cand = { kind: 'root', parent: null, pos: { x: 0, y: 0 }, rot: 0 };
    else if (p.def.radial) {
      const base = E.sel && E.parts.includes(E.sel) && B.takesSurface(E.sel.def) ? E.sel : null;
      for (const side of [1, -1]) {
        if (cand || !base) break;
        const at = V.add(base.pos, { x: side * (Math.max(base.w, base.tw) / 2 + p.w / 2), y: 0 });
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
        const at = V.add(n.pos, V.scale(ax, (n.node === 'top' ? 1 : -1) * p.def.len / 2));
        cand = tryCand(B.candidate([n.part], held, p, at, 0.05));
      }
      if (!cand) { say(`No free attach point for the ${p.def.name}. Drag it onto the side of a part instead.`); return; }
    }
    E.parts = B.attach(E.parts, held, p, cand);
    E.sel = p;
    if (wasEmpty || !inView(p)) E.fit();
    E.changed();
    say(`${p.def.name}: ${p.def.desc}`);
  };

  E.remove = (p) => {
    if (!p || !E.parts.includes(p)) return;
    const gone = new Set(FS.subtree(E.parts, p));
    E.parts = E.parts.filter((q) => !gone.has(q));
    E.sel = p.parent && E.parts.includes(p.parent) ? p.parent : null;
    FS.relayout(E.parts);
    E.changed();
    say(`Removed ${gone.size} part${gone.size > 1 ? 's' : ''}.`);
  };

  // Stretch goal: make the selected part the root.
  E.reroot = (p) => {
    if (!p || !E.parts.includes(p) || !p.parent) return;
    B.reroot(E.parts, p);
    E.changed();
    say(`The ${p.def.name} is now the root part.`);
  };

  // ---------- Pointer and touch ----------
  let suppressClick = false;
  let trayPress = null;

  function trayDown(e, id) {
    if (e.button !== 0 || E.drag) return;
    suppressClick = false;
    trayPress = { id, pointerId: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse', last: e, timer: null };
    if (trayPress.touch) trayPress.timer = setTimeout(() => startTrayDrag(), LONG_PRESS);
  }
  function startTrayDrag() {
    const t = trayPress;
    if (!t) return;
    clearTimeout(t.timer);
    trayPress = null;
    suppressClick = true;
    if (t.touch && navigator.vibrate) navigator.vibrate(12);
    E.pickNew(t.id, worldOf(t.last), t.pointerId);
    E.dragTo(worldOf(t.last), overTray(t.last));
  }

  const ptrs = new Map();
  let gesture = null;

  function initPointer() {
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
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
      const hit = B.partAt(E.parts, E.toWorld(pt.x, pt.y), (touch ? 10 : 3) / E.cam.s);
      gesture = { type: 'press', id: e.pointerId, start: pt, last: pt, hit, touch, timer: null };
      if (touch && hit) {
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
      } else if (gesture.type === 'press' && e.pointerId === gesture.id) {
        gesture.last = pt;
        const moved = Math.hypot(pt.x - gesture.start.x, pt.y - gesture.start.y);
        if (moved > (gesture.touch ? 9 : 4)) {
          clearTimeout(gesture.timer);
          if (!gesture.touch && gesture.hit) {
            E.pickPart(gesture.hit, E.toWorld(gesture.start.x, gesture.start.y), e.pointerId);
            E.dragTo(E.toWorld(pt.x, pt.y));
            gesture = { type: 'drag' };
          } else {
            gesture = { type: 'pan', last: gesture.start };
            E.cam.x -= (pt.x - gesture.last.x) / E.cam.s;
            E.cam.y += (pt.y - gesture.last.y) / E.cam.s;
            gesture.last = pt;
            E.render();
          }
        }
      }
    });

    const end = (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (!gesture) return;
      if (gesture.timer) clearTimeout(gesture.timer);
      if (gesture.type === 'press' && e.type === 'pointerup' && e.pointerId === gesture.id) {
        E.sel = gesture.hit;
        say(E.sel ? `${E.sel.def.name}: ${E.sel.def.desc}` : hint());
        E.render();
        gesture = null;
      } else if (gesture.type === 'pinch') {
        // the finger left on the glass carries on panning without a jump
        gesture = ptrs.size === 1 ? { type: 'pan', last: [...ptrs.values()][0] } : null;
      } else if (!ptrs.size) gesture = null;
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);

    // Carrying a part, from the tray or the build area, is followed on the whole window.
    window.addEventListener('pointermove', (e) => {
      if (trayPress && e.pointerId === trayPress.pointerId) {
        trayPress.last = e;
        if (Math.hypot(e.clientX - trayPress.x, e.clientY - trayPress.y) > (trayPress.touch ? 10 : 5)) startTrayDrag();
      }
      if (E.drag && e.pointerId === E.drag.pointerId) E.dragTo(worldOf(e), overTray(e));
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
    E.cam.s = FS.clamp(Math.min((H - 130) / h, (W - 150) / w), 3, 70);
    E.cam.x = lay.com.x + (lay.minX + lay.maxX) / 2;
    // a little extra room below, where the hangar tools sit
    E.cam.y = lay.com.y + (lay.minY + lay.maxY) / 2 - 22 / E.cam.s;
  };

  E.changed = () => { persist(); E.render(); E.updateStats(); };

  E.resize = () => {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
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
      FS.drawPart(ctx, p, -p.def.len / 2, 1 / s, { selected: opts.sel && p === E.sel });
      ctx.restore();
    }
  }

  function quadPath(p) {
    ctx.beginPath();
    B.quad(p).forEach((q, i) => { const c = E.toScreen(q); if (i) ctx.lineTo(c.x, c.y); else ctx.moveTo(c.x, c.y); });
    ctx.closePath();
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

    let lay = null;
    if (parts.length) {
      lay = FS.massLayout(parts);
      const top = E.toScreen({ x: 0, y: lay.com.y + lay.maxY }).y;
      const bot = E.toScreen({ x: 0, y: lay.com.y + lay.minY }).y;
      const rx = Math.max(24, E.toScreen({ x: lay.com.x + lay.minX, y: 0 }).x - 46);
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
      drawParts(parts, { sel: !d });

      // root marker: a small ring at the root's centre
      const root = parts[0];
      if (root) {
        const c = E.toScreen(root.pos);
        ctx.strokeStyle = 'rgba(85,214,255,0.85)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(c.x, c.y, 5, 0, FS.TAU); ctx.stroke();
      }

      // centre of mass
      const cm = E.toScreen(lay.com);
      ctx.beginPath(); ctx.arc(cm.x, cm.y, 7, 0, FS.TAU);
      ctx.fillStyle = '#ffd34d'; ctx.fill();
      ctx.fillStyle = '#1b1405';
      ctx.beginPath(); ctx.moveTo(cm.x, cm.y); ctx.arc(cm.x, cm.y, 7, 0, Math.PI / 2); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(cm.x, cm.y); ctx.arc(cm.x, cm.y, 7, Math.PI, Math.PI * 1.5); ctx.closePath(); ctx.fill();

      if (!d) {
        ctx.font = '600 11px "Saira Semi Condensed", sans-serif';
        ctx.textAlign = 'left';
        const x = E.toScreen({ x: lay.com.x + lay.maxX, y: 0 }).x + 14;
        FS.stagesOf(parts).forEach((ev, k) => {
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
        const p = d.cand.parent;
        const q = B.quad(p);
        const [a, b] = d.cand.side > 0 ? [q[1], q[2]] : [q[0], q[3]];
        const A = E.toScreen(a), Bp = E.toScreen(b);
        ctx.strokeStyle = d.valid ? 'rgba(255,181,71,0.95)' : 'rgba(255,107,90,0.9)';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(Bp.x, Bp.y); ctx.stroke();
      }
      if (!d.overTray) {
        ctx.globalAlpha = 0.82;
        drawParts(d.held, {});
        ctx.globalAlpha = 1;
        const ok = d.valid;
        for (const p of d.held) {
          quadPath(p);
          ctx.fillStyle = ok ? 'rgba(85,214,255,0.10)' : 'rgba(255,80,60,0.38)';
          ctx.fill();
          ctx.strokeStyle = ok ? 'rgba(85,214,255,0.8)' : 'rgba(255,107,90,0.95)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }

    if (!d) {
      const sel = E.sel && parts.includes(E.sel) ? E.sel : null;
      $('btnRoot').disabled = !sel || sel === parts[0];
      $('btnDel').disabled = !sel;
    }
  };

  // ---------- Stats ----------
  E.updateStats = (parts = E.parts) => {
    const stages = FS.stagesOf(parts);
    const sv = FS.stageStats(parts, stages, 0, 0, 9.81);
    const sa = FS.stageStats(parts, stages, 0, 1, 9.81);
    const list = $('stageList');
    list.innerHTML = '';
    stages.forEach((ev, k) => {
      const li = document.createElement('li');
      li.className = 'stage-card';
      const what = [];
      if (ev.decouple) what.push('Decouple' + (ev.decouplers.length > 1 ? ' ×' + ev.decouplers.length : ''));
      if (ev.ignite) {
        const names = {};
        ev.engines.forEach((p) => (names[p.def.name] = (names[p.def.name] || 0) + 1));
        what.push('Ignite ' + Object.entries(names).map(([n, c]) => (c > 1 ? c + '× ' : '') + n.replace(/ Engine| Solid Booster/, '')).join(', '));
      }
      if (ev.chutes) what.push('Deploy parachutes');
      let dv = '', nums = '';
      const v = sv.events[k], a = sa.events[k];
      if (ev.ignite || v.dv > 0.5) {
        dv = `${v.dv.toFixed(0)} m/s`;
        const twrCls = k === 0 && a.twr < 1 ? ' class="bad"' : '';
        nums = `<span${twrCls}>TWR ${a.twr.toFixed(2)}</span><span>ASL ${a.dv.toFixed(0)}</span><span>${v.time.toFixed(0)} s</span>`;
      }
      li.innerHTML = `<header><span class="sn">Stage ${k + 1}</span><span class="dv">${dv}</span></header><div class="what">${what.join(' · ')}</div>${nums ? `<div class="nums">${nums}</div>` : ''}`;
      list.appendChild(li);
    });
    const lay = FS.massLayout(parts);
    const first = stages.findIndex((e) => e.ignite);
    const twr = first >= 0 ? sa.events[first].twr : 0;
    $('edTotals').innerHTML = `<dt>Total Δv (vacuum)</dt><dd class="dvtot">${sv.total.toFixed(0)} m/s</dd>
      <dt>Launch TWR</dt><dd${first >= 0 && twr < 1 ? ' class="bad"' : ''}>${first >= 0 ? twr.toFixed(2) : '—'}</dd>
      <dt>Mass</dt><dd>${(lay.mass / 1000).toFixed(2)} t</dd>
      <dt>Height</dt><dd>${lay.height.toFixed(1)} m</dd>
      <dt>Parts</dt><dd>${parts.length}</dd>`;
    const warn = [];
    if (parts.length && !parts.some((p) => p.def.command)) warn.push('Add a capsule or probe core so the craft can be controlled.');
    if (parts.length && !parts.some((p) => p.def.engine)) warn.push('No engines yet.');
    if (first >= 0 && twr < 1) warn.push('First stage thrust is lower than its weight (TWR under 1). It will not lift off.');
    const kids = FS.childrenOf(parts);
    if (parts.some((p) => p.def.decoupler && !(kids.get(p) || []).length)) warn.push('A decoupler has nothing attached below it.');
    if (parts.some((p) => p.def.engine) && !parts.some((p) => p.def.chute) && parts.some((p) => p.def.crew)) warn.push('No parachute. The crew will need one to come home.');
    $('edWarnings').innerHTML = warn.map((w) => `<li>${w}</li>`).join('');
    $('btnLaunch').disabled = !E.parts.length;
  };

  E.launch = () => {
    if (!E.parts.length) return;
    persist();
    game.launch({ name: E.name, parts: FS.serialParts(E.parts) });
  };
})();
