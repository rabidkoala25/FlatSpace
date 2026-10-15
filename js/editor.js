// editor.js — the Vehicle Assembly hangar: build a stack, see Δv per stage, launch.
(function () {
  const E = (FS.Editor = {});
  const $ = (id) => document.getElementById(id);
  let cv, ctx, W, H, DPR;
  let game;
  let hitBoxes = [];

  E.craft = { name: 'Orbiter I', parts: FS.SAMPLE_CRAFT[1].parts.slice() };
  E.sel = -1;

  E.init = (g) => {
    game = g;
    cv = $('edCanvas');
    ctx = cv.getContext('2d');
    const saved = FS.store.load('flatspace.current', null);
    if (saved && Array.isArray(saved.parts)) E.craft = { name: saved.name || 'Untitled', parts: saved.parts.filter((id) => FS.PART[id]) };
    buildPalette();
    refreshLoadList();

    $('craftName').value = E.craft.name;
    $('craftName').addEventListener('input', (e) => { E.craft.name = e.target.value || 'Untitled'; persist(); });
    $('btnLaunch').addEventListener('click', () => E.launch());
    $('btnNew').addEventListener('click', () => { E.craft = { name: 'Untitled', parts: ['lark'] }; E.sel = 0; $('craftName').value = 'Untitled'; E.changed(); });
    $('btnSave').addEventListener('click', () => {
      const all = FS.store.load('flatspace.crafts', {});
      all[E.craft.name] = E.craft.parts.slice();
      const ok = FS.store.save('flatspace.crafts', all);
      refreshLoadList();
      $('partInfo').textContent = ok ? `Saved “${E.craft.name}”.` : 'Could not save: browser storage is unavailable.';
    });
    $('craftLoad').addEventListener('change', (e) => {
      const v = e.target.value;
      if (!v) return;
      const [kind, name] = v.split('::');
      let parts = null;
      if (kind === 'sample') parts = FS.SAMPLE_CRAFT.find((c) => c.name === name).parts;
      else parts = FS.store.load('flatspace.crafts', {})[name];
      if (parts) {
        E.craft = { name, parts: parts.slice() };
        $('craftName').value = name;
        E.sel = -1;
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
      if (e.key === 'ArrowUp') { if (e.altKey) move(-1); else E.sel = Math.max(0, E.sel - 1); E.render(); e.preventDefault(); }
      if (e.key === 'ArrowDown') { if (e.altKey) move(1); else E.sel = Math.min(E.craft.parts.length - 1, E.sel + 1); E.render(); e.preventDefault(); }
    });
    E.changed();
  };

  function persist() { FS.store.save('flatspace.current', E.craft); }

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
      for (const d of FS.PARTS.filter((p) => p.cat === cat)) {
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
    const parts = FS.makeParts([d.id]);
    const w = d.w === 'auto' ? 1.25 : d.w;
    const s = Math.min(70 / Math.max(w + (d.fin ? 1.6 : 0), 0.6), 84 / d.len, 60);
    g.setTransform(s, 0, 0, s, 44, 52 - (d.len * s) / 2);
    FS.drawPart(g, parts, 0, 0, 1 / s, {});
  }

  function add(id) {
    const at = E.sel >= 0 ? E.sel + 1 : E.craft.parts.length;
    E.craft.parts.splice(at, 0, id);
    E.sel = at;
    E.changed();
  }
  function remove() {
    if (E.sel < 0 || E.sel >= E.craft.parts.length) return;
    E.craft.parts.splice(E.sel, 1);
    E.sel = Math.min(E.sel, E.craft.parts.length - 1);
    E.changed();
  }
  function move(d) {
    const i = E.sel, j = i + d;
    if (i < 0 || j < 0 || j >= E.craft.parts.length) return;
    const p = E.craft.parts;
    [p[i], p[j]] = [p[j], p[i]];
    E.sel = j;
    E.changed();
  }

  function onClick(e) {
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const hit = hitBoxes.find((h) => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);
    E.sel = hit ? hit.i : -1;
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

    const parts = FS.makeParts(E.craft.parts);
    const lay = FS.stackLayout(parts);
    const height = Math.max(lay.height, 4);
    const s = Math.min((H - 120) / height, 70, (W - 160) / 7);
    const top = Math.max(40, (H - 60 - height * s) / 2);
    const cx = W / 2;

    // grid (1 m)
    ctx.strokeStyle = 'rgba(120,160,230,0.07)';
    ctx.lineWidth = 1;
    const step = s < 12 ? s * 5 : s;
    for (let x = cx % step; x < W; x += step) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); ctx.stroke(); }
    for (let y = top % step; y < H; y += step) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke(); }

    // floor
    const floorY = top + lay.height * s;
    ctx.fillStyle = 'rgba(120,160,230,0.10)';
    ctx.fillRect(0, floorY, W, 3);

    // height ruler
    const rx = Math.max(24, cx - 3.2 * s - 50);
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

    // parts
    hitBoxes = [];
    if (!parts.length) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(200,215,240,0.6)';
      ctx.font = '500 15px Barlow, system-ui, sans-serif';
      ctx.fillText('Add a command part to start your rocket.', cx, H / 2);
      return;
    }
    ctx.save();
    ctx.translate(cx, top);
    ctx.scale(s, s);
    parts.forEach((p, i) => {
      FS.drawPart(ctx, parts, i, lay.tops[i], 1 / s, { selected: i === E.sel });
    });
    // centre of mass marker
    ctx.restore();
    const comY = top + lay.com * s;
    ctx.beginPath(); ctx.arc(cx, comY, 7, 0, FS.TAU);
    ctx.fillStyle = '#ffd34d'; ctx.fill();
    ctx.fillStyle = '#1b1405';
    ctx.beginPath(); ctx.moveTo(cx, comY); ctx.arc(cx, comY, 7, 0, Math.PI / 2); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(cx, comY); ctx.arc(cx, comY, 7, Math.PI, Math.PI * 1.5); ctx.closePath(); ctx.fill();

    // labels for decouplers (stage boundaries)
    ctx.font = '600 11px "Saira Semi Condensed", sans-serif';
    ctx.textAlign = 'left';
    const stages = FS.stagesOf(parts);
    stages.forEach((ev, k) => {
      // one label per stage, next to its first part
      for (const p of ev.parts.slice(0, 1)) {
        const i = parts.indexOf(p);
        if (i < 0) continue;
        const y = top + (lay.tops[i] + p.def.len / 2) * s;
        const x = cx + Math.max(FS.partWidth(parts, i), FS.partTopWidth(parts, i)) * s / 2 + (p.def.fin ? 0.8 * s : 0) + 14;
        ctx.fillStyle = 'rgba(255,181,71,0.9)';
        ctx.fillText('STAGE ' + (k + 1), x, y + 4);
      }
    });

    parts.forEach((p, i) => {
      const w = Math.max(FS.partWidth(parts, i), FS.partTopWidth(parts, i)) * s;
      hitBoxes.push({ i, x0: cx - w / 2 - 6, x1: cx + w / 2 + 6, y0: top + lay.tops[i] * s, y1: top + (lay.tops[i] + p.def.len) * s });
    });

    const info = $('partInfo');
    if (E.sel >= 0 && parts[E.sel]) {
      const d = parts[E.sel].def;
      info.textContent = `${d.name}: ${d.desc}`;
    } else info.textContent = 'Click a part on the left to add it below the selected part.';
  };

  E.updateStats = () => {
    const parts = FS.makeParts(E.craft.parts);
    const segs = FS.segmentsOf(parts);
    const sv = FS.segmentStats(segs, 0, 9.81);
    const sa = FS.segmentStats(segs, 1, 9.81);
    const stages = FS.stagesOf(parts);
    const list = $('stageList');
    list.innerHTML = '';
    stages.forEach((ev, k) => {
      const li = document.createElement('li');
      li.className = 'stage-card';
      let what = [];
      if (ev.decouple) what.push('Decouple');
      if (ev.ignite) {
        const names = {};
        ev.parts.filter((p) => p.def.engine).forEach((p) => (names[p.def.name] = (names[p.def.name] || 0) + 1));
        what.push('Ignite ' + Object.entries(names).map(([n, c]) => (c > 1 ? c + '× ' : '') + n.replace(/ Engine| Solid Booster/, '')).join(', '));
      }
      if (ev.chutes) what.push('Deploy parachutes');
      let dv = '', nums = '';
      if (ev.ignite) {
        const v = sv[ev.seg], a = sa[ev.seg];
        dv = `${v.dv.toFixed(0)} m/s`;
        const twrCls = k === 0 && a.twr < 1 ? ' class="bad"' : '';
        nums = `<span${twrCls}>TWR ${a.twr.toFixed(2)}</span><span>ASL ${a.dv.toFixed(0)}</span><span>${v.time.toFixed(0)} s</span>`;
      }
      li.innerHTML = `<header><span class="sn">Stage ${k + 1}</span><span class="dv">${dv}</span></header><div class="what">${what.join(' · ')}</div>${nums ? `<div class="nums">${nums}</div>` : ''}`;
      list.appendChild(li);
    });
    const lay = FS.stackLayout(parts);
    const total = sv.reduce((s, x) => s + x.dv, 0);
    $('edTotals').innerHTML = `<dt>Total Δv (vacuum)</dt><dd class="dvtot">${total.toFixed(0)} m/s</dd>
      <dt>Mass</dt><dd>${(lay.mass / 1000).toFixed(2)} t</dd>
      <dt>Height</dt><dd>${lay.height.toFixed(1)} m</dd>
      <dt>Parts</dt><dd>${parts.length}</dd>`;
    const warn = [];
    if (!parts.some((p) => p.def.command)) warn.push('Add a capsule or probe core so the craft can be controlled.');
    if (!parts.some((p) => p.def.engine)) warn.push('No engines yet.');
    const first = stages.find((e) => e.ignite);
    if (first && sa[first.seg].twr < 1) warn.push('First stage thrust is lower than its weight (TWR under 1). It will not lift off.');
    if (parts.length && parts[parts.length - 1].def.decoupler) warn.push('There is a decoupler at the very bottom.');
    if (parts.some((p) => p.def.engine) && !parts.some((p) => p.def.chute) && parts.some((p) => p.def.crew)) warn.push('No parachute. The crew will need one to come home.');
    $('edWarnings').innerHTML = warn.map((w) => `<li>${w}</li>`).join('');
    $('btnLaunch').disabled = !parts.length;
  };

  E.launch = () => {
    if (!E.craft.parts.length) return;
    persist();
    game.launch({ name: E.craft.name, parts: E.craft.parts.slice() });
  };
})();
