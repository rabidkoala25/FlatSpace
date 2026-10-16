// editor.js — the Vehicle Assembly hangar: build a craft, see Δv per stage, launch.
// The craft is a part tree (partgraph.js). This editor edits its main stack: the root
// and the chain of parts hanging below it. Parts attached to the side (from a craft
// file or a sample) are kept and move with the part they hang from. Step A2 replaces
// this with drag-and-drop building.
(function () {
  const E = (FS.Editor = {});
  const $ = (id) => document.getElementById(id);
  let cv, ctx, W, H, DPR;
  let game;
  let hitBoxes = [];

  const sampleParts = (c) => (c.tree ? FS.partsFromSerial(c.tree) : FS.stackToParts(c.parts));

  E.name = 'Orbiter I';
  E.parts = [];
  E.sel = null; // the selected part

  E.init = (g) => {
    game = g;
    cv = $('edCanvas');
    ctx = cv.getContext('2d');
    const saved = FS.store.load('flatspace.current', null);
    if (saved && Array.isArray(saved.parts)) { E.name = saved.name || 'Untitled'; E.parts = FS.partsFromSerial(saved.parts); }
    else E.parts = sampleParts(FS.SAMPLE_CRAFT[1]);
    buildPalette();
    refreshLoadList();

    $('craftName').value = E.name;
    $('craftName').addEventListener('input', (e) => { E.name = e.target.value || 'Untitled'; persist(); });
    $('btnLaunch').addEventListener('click', () => E.launch());
    $('btnNew').addEventListener('click', () => {
      E.name = 'Untitled';
      E.parts = FS.stackToParts(['lark']);
      E.sel = E.parts[0];
      $('craftName').value = E.name;
      E.changed();
    });
    $('btnSave').addEventListener('click', () => {
      const all = FS.store.load('flatspace.crafts', {});
      all[E.name] = FS.serialParts(E.parts);
      const ok = FS.store.save('flatspace.crafts', all);
      refreshLoadList();
      $('partInfo').textContent = ok ? `Saved “${E.name}”.` : 'Could not save: browser storage is unavailable.';
    });
    $('craftLoad').addEventListener('change', (e) => {
      const v = e.target.value;
      if (!v) return;
      const [kind, name] = v.split('::');
      let parts = null;
      if (kind === 'sample') parts = sampleParts(FS.SAMPLE_CRAFT.find((c) => c.name === name));
      else { const s = FS.store.load('flatspace.crafts', {})[name]; if (s) parts = FS.partsFromSerial(s); }
      if (parts) {
        E.name = name;
        E.parts = parts;
        $('craftName').value = name;
        E.sel = null;
        E.changed();
      }
      e.target.value = '';
    });
    $('btnUp').addEventListener('click', () => move(-1));
    $('btnDown').addEventListener('click', () => move(1));
    $('btnDel').addEventListener('click', () => remove());
    cv.addEventListener('click', onClick);
    window.addEventListener('keydown', (e) => {
      if (game.scene !== 'editor' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === 'Delete' || e.key === 'Backspace') { remove(); e.preventDefault(); }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const d = e.key === 'ArrowUp' ? -1 : 1;
        if (e.altKey) move(d);
        else {
          const ch = chain();
          const i = ch.indexOf(E.sel);
          E.sel = ch[FS.clamp(i < 0 ? 0 : i + d, 0, ch.length - 1)] || null;
          E.render();
        }
        e.preventDefault();
      }
    });
    E.changed();
  };

  function persist() { FS.store.save('flatspace.current', { name: E.name, parts: FS.serialParts(E.parts) }); }

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

  function partStat(d) {
    if (d.engine) return `${(d.engine.vac / 1000).toFixed(0)} kN · Isp ${d.engine.ispVac} s`;
    if (d.fuel) return `${(d.fuel / 1000).toFixed(d.fuel < 1000 ? 2 : 1)} t fuel`;
    if (d.command) return d.crew ? `${d.crew} crew · ${(d.mass / 1000).toFixed(2)} t` : `probe · ${(d.mass / 1000).toFixed(2)} t`;
    return `${(d.mass / 1000).toFixed(2)} t`;
  }

  function buildPalette() {
    const host = $('palette');
    host.innerHTML = '';
    for (const cat of FS.PART_CATS) {
      const grp = document.createElement('div');
      grp.className = 'pal-group';
      grp.innerHTML = `<div class="pal-cat">${cat}</div>`;
      const list = document.createElement('div');
      list.className = 'pal-list';
      for (const d of FS.PARTS.filter((p) => p.cat === cat && !p.radial)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'part-btn';
        b.title = d.desc;
        const c = document.createElement('canvas');
        c.width = 88; c.height = 104;
        b.appendChild(c);
        const txt = document.createElement('span');
        txt.innerHTML = `<span class="pn">${d.name}</span><span class="ps">${partStat(d)}</span>`;
        b.appendChild(txt);
        b.addEventListener('click', () => add(d.id));
        list.appendChild(b);
        drawThumb(c, d);
      }
      grp.appendChild(list);
      host.appendChild(grp);
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

  // ---------- Editing the main stack ----------
  const below = (p) => E.parts.find((c) => c.parent === p && c.node === 'bottom') || null;
  function chain() {
    const out = [];
    for (let p = FS.rootOf(E.parts); p; p = below(p)) out.push(p);
    return out;
  }

  // Add a part below the selected one (or at the bottom of the stack).
  function add(id) {
    const p = FS.newPart(id);
    if (!p) return;
    const ch = chain();
    const target = ch.includes(E.sel) ? E.sel : ch[ch.length - 1];
    if (target) {
      const old = below(target);
      p.parent = target;
      p.node = 'bottom';
      if (old) old.parent = p;
    }
    E.parts.push(p);
    E.sel = p;
    FS.relayout(E.parts);
    E.changed();
  }

  function remove() {
    const sel = E.sel;
    if (!sel || !E.parts.includes(sel)) return;
    let gone;
    if (chain().includes(sel)) {
      const next = below(sel);
      if (next) next.parent = sel.parent;
      if (next && !sel.parent) next.pos = { ...sel.pos };
      // the part goes, with anything on its sides; the stack below closes up
      gone = new Set(FS.subtree(E.parts, sel).filter((p) => !next || !FS.subtree(E.parts, next).includes(p)));
      gone.add(sel);
      E.sel = next || sel.parent || null;
    } else {
      gone = new Set(FS.subtree(E.parts, sel));
      E.sel = sel.parent || null;
    }
    E.parts = E.parts.filter((p) => !gone.has(p));
    FS.relayout(E.parts);
    E.changed();
  }

  // Move the selected stack part up or down the stack.
  function move(d) {
    const ch = chain();
    const i = ch.indexOf(E.sel), j = i + d;
    if (i < 0 || j < 0 || j >= ch.length) return;
    const rootPos = { ...ch[0].pos };
    [ch[i], ch[j]] = [ch[j], ch[i]];
    ch.forEach((p, k) => { p.parent = k ? ch[k - 1] : null; p.node = 'bottom'; });
    ch[0].pos = rootPos;
    ch[0].rot = 0;
    FS.relayout(E.parts);
    E.changed();
  }

  function onClick(e) {
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    // the smallest box under the pointer wins, so side parts can be picked over the stack
    const hits = hitBoxes.filter((h) => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);
    hits.sort((a, b) => (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0));
    E.sel = hits.length ? hits[0].p : null;
    E.render();
  }

  E.changed = () => { persist(); E.render(); E.updateStats(); };

  E.resize = () => {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    E.render();
  };

  E.render = () => {
    if (!ctx || !W) return;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    // Blueprint hangar background
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0f1a33'); bg.addColorStop(1, '#0a1224');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

    const parts = E.parts;
    const lay = FS.massLayout(parts);
    const height = Math.max(lay.height, 4);
    const s = Math.min((H - 120) / height, 70, (W - 160) / Math.max(7, lay.width + 2));
    const top = Math.max(40, (H - 60 - height * s) / 2);
    const cx = W / 2 - ((lay.minX + lay.maxX) / 2) * s;
    // craft frame (relative to the centre of mass) → screen
    const sx = (x) => cx + x * s;
    const sy = (y) => top + (lay.maxY - y) * s;

    // grid (1 m)
    ctx.strokeStyle = 'rgba(120,160,230,0.07)';
    ctx.lineWidth = 1;
    const step = s < 12 ? s * 5 : s;
    for (let x = cx % step; x < W; x += step) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); ctx.stroke(); }
    for (let y = top % step; y < H; y += step) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke(); }

    // floor
    const floorY = sy(lay.minY);
    ctx.fillStyle = 'rgba(120,160,230,0.10)';
    ctx.fillRect(0, floorY, W, 3);

    // height ruler
    const rx = Math.max(24, sx(lay.minX) - 50);
    ctx.strokeStyle = 'rgba(200,215,240,0.45)';
    ctx.fillStyle = 'rgba(200,215,240,0.7)';
    ctx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.beginPath(); ctx.moveTo(rx + 0.5, top); ctx.lineTo(rx + 0.5, floorY); ctx.stroke();
    const tick = height > 30 ? 5 : height > 12 ? 2 : 1;
    for (let m = 0; m <= lay.height + 0.001; m += tick) {
      const y = floorY - m * s;
      ctx.beginPath(); ctx.moveTo(rx - 5, y + 0.5); ctx.lineTo(rx + 0.5, y + 0.5); ctx.stroke();
      ctx.fillText(m + ' m', rx - 8, y + 4);
    }

    hitBoxes = [];
    if (!parts.length) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(200,215,240,0.6)';
      ctx.font = '500 15px Barlow, system-ui, sans-serif';
      ctx.fillText('Add a command part to start your rocket.', W / 2, H / 2);
      return;
    }
    for (const p of parts) {
      ctx.save();
      ctx.translate(sx(p.c.x), sy(p.c.y));
      ctx.scale(s, s);
      ctx.rotate(-p.rot);
      if (p.flip) ctx.scale(-1, 1);
      FS.drawPart(ctx, p, -p.def.len / 2, 1 / s, { selected: p === E.sel });
      ctx.restore();
      const xs = p.hullC.map((h) => sx(h.x)), ys = p.hullC.map((h) => sy(h.y));
      hitBoxes.push({ p, x0: Math.min(...xs) - 4, x1: Math.max(...xs) + 4, y0: Math.min(...ys), y1: Math.max(...ys) });
    }

    // centre of mass marker
    const comX = sx(0), comY = sy(0);
    ctx.beginPath(); ctx.arc(comX, comY, 7, 0, FS.TAU);
    ctx.fillStyle = '#ffd34d'; ctx.fill();
    ctx.fillStyle = '#1b1405';
    ctx.beginPath(); ctx.moveTo(comX, comY); ctx.arc(comX, comY, 7, 0, Math.PI / 2); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(comX, comY); ctx.arc(comX, comY, 7, Math.PI, Math.PI * 1.5); ctx.closePath(); ctx.fill();

    // one label per stage, next to its first part
    ctx.font = '600 11px "Saira Semi Condensed", sans-serif';
    ctx.textAlign = 'left';
    FS.stagesOf(parts).forEach((ev, k) => {
      const p = ev.parts[0];
      if (!p) return;
      const x = Math.max(...p.hullC.map((h) => sx(h.x))) + 14;
      ctx.fillStyle = 'rgba(255,181,71,0.9)';
      ctx.fillText('STAGE ' + (k + 1), x, sy(p.c.y) + 4);
    });

    const info = $('partInfo');
    if (E.sel && parts.includes(E.sel)) {
      const d = E.sel.def;
      info.textContent = `${d.name}: ${d.desc}`;
    } else info.textContent = 'Click a part on the left to add it below the selected part.';
  };

  E.updateStats = () => {
    const parts = E.parts;
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
    $('edTotals').innerHTML = `<dt>Total Δv (vacuum)</dt><dd class="dvtot">${sv.total.toFixed(0)} m/s</dd>
      <dt>Mass</dt><dd>${(lay.mass / 1000).toFixed(2)} t</dd>
      <dt>Height</dt><dd>${lay.height.toFixed(1)} m</dd>
      <dt>Parts</dt><dd>${parts.length}</dd>`;
    const warn = [];
    if (!parts.some((p) => p.def.command)) warn.push('Add a capsule or probe core so the craft can be controlled.');
    if (!parts.some((p) => p.def.engine)) warn.push('No engines yet.');
    const first = stages.findIndex((e) => e.ignite);
    if (first >= 0 && sa.events[first].twr < 1) warn.push('First stage thrust is lower than its weight (TWR under 1). It will not lift off.');
    const ch = chain();
    if (ch.length && ch[ch.length - 1].def.decoupler) warn.push('There is a decoupler at the very bottom.');
    if (parts.some((p) => p.def.engine) && !parts.some((p) => p.def.chute) && parts.some((p) => p.def.crew)) warn.push('No parachute. The crew will need one to come home.');
    $('edWarnings').innerHTML = warn.map((w) => `<li>${w}</li>`).join('');
    $('btnLaunch').disabled = !parts.length;
  };

  E.launch = () => {
    if (!E.parts.length) return;
    persist();
    game.launch({ name: E.name, parts: FS.serialParts(E.parts) });
  };
})();
