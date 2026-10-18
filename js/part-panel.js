// part-panel.js — part settings pop-ups ("tweakables"), in the hangar and in flight, and the
// craft file dialog.
//
// Selecting a part opens its pop-up beside it, with a line pointing to the part. Drag the
// pop-up by its title to move it (it keeps that place relative to the part). The pin keeps
// it open after another part is selected, so several can be open at once; × closes it.
// Hangar settings: tank length, width, look and fuel level; engine thrust limit and gimbal;
// decoupler crossfeed; parachute opening height; whether the part fires in staging; and for
// floating parts, whether they launch with the craft. In flight: thrust limit, gimbal,
// crossfeed and parachute height can still be changed, and engines, decouplers and
// parachutes can be used directly. Hangar changes go through FS.Editor so they reach mirror
// twins and undo.
(function () {
  const P = (FS.PartPanel = {});
  const $ = (id) => document.getElementById(id);
  const SKIN_NAMES = { white: 'White', gold: 'Gold foil', foam: 'Orange foam', roll: 'Roll pattern', steel: 'Bare steel' };
  const panels = []; // { part, ctx: 'editor' | 'flight', el, pinned, off: {x, y} | null }
  let E = null;
  const host = (ctx) => (ctx === 'editor' ? document.querySelector('#editor .hangar') : $('flight'));

  P.init = (editor) => { E = editor; };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  // ---------- Opening and closing ----------
  // A part was selected (null: nothing selected). Unpinned pop-ups give way to the new one.
  P.select = (part, ctx = 'editor') => {
    for (const pn of panels.slice()) if (pn.ctx === ctx && !pn.pinned && pn.part !== part) P.close(pn);
    if (!part) return;
    const have = panels.find((pn) => pn.ctx === ctx && pn.part === part);
    if (have) { have.el.classList.add('flash'); setTimeout(() => have.el.classList.remove('flash'), 300); return; }
    const pn = { part, ctx, el: el('div', 'part-panel'), pinned: false, off: null };
    pn.el.setAttribute('role', 'dialog');
    pn.el.setAttribute('aria-label', `${part.def.name} settings`);
    pn.el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { P.close(pn); e.stopPropagation(); } });
    host(ctx).appendChild(pn.el);
    panels.push(pn);
    P.build(pn);
  };
  P.open = (part, ctx = 'editor') => P.select(part, ctx);
  P.close = (pn) => {
    const i = panels.indexOf(pn);
    if (i >= 0) panels.splice(i, 1);
    pn.el.remove();
    const line = lineFor(pn.ctx, false);
    if (line) line.innerHTML = '';
  };
  P.closeAll = (ctx) => { for (const pn of panels.slice()) if (!ctx || pn.ctx === ctx) P.close(pn); };
  P.isOpen = (ctx = 'editor') => panels.some((pn) => pn.ctx === ctx);
  P.panels = (ctx) => panels.filter((pn) => !ctx || pn.ctx === ctx);
  // Rebuild every pop-up (after undo, load, or a change elsewhere); close those whose part is gone.
  P.rebuildAll = (ctx, alive) => {
    for (const pn of panels.slice()) {
      if (pn.ctx !== ctx) continue;
      if (!alive(pn.part)) P.close(pn);
      else P.build(pn);
    }
  };

  // ---------- Placing pop-ups and their pointer lines ----------
  // An SVG layer in each host for the lines from pop-ups to their parts.
  function lineFor(ctx, make = true) {
    const h = host(ctx);
    if (!h) return null;
    let svg = h.querySelector(':scope > svg.pp-lines');
    if (!svg && make) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'pp-lines');
      svg.setAttribute('aria-hidden', 'true');
      h.appendChild(svg);
    }
    return svg;
  }

  // Called every redraw: where = (part) => its point on screen, in the host's pixels, or
  // null if it can't be shown. hidden hides every pop-up of ctx (while dragging a part).
  P.layout = (ctx, where, hidden = false) => {
    const h = host(ctx);
    if (!h) return;
    const W = h.clientWidth, H = h.clientHeight;
    const svg = lineFor(ctx, panels.some((pn) => pn.ctx === ctx));
    let lines = '';
    for (const pn of panels) {
      if (pn.ctx !== ctx) continue;
      const at = hidden ? null : where(pn.part);
      pn.el.hidden = !at;
      if (!at) continue;
      if (pn.live) pn.live();
      const pw = pn.el.offsetWidth || 270, ph = pn.el.offsetHeight || 200;
      if (!pn.off) pn.off = { x: at.x + 60 + pw < W ? 60 : -60 - pw, y: -ph / 2 };
      const x = FS.clamp(at.x + pn.off.x, 4, Math.max(4, W - pw - 4));
      const y = FS.clamp(at.y + pn.off.y, 4, Math.max(4, H - ph - 4));
      pn.el.style.left = x + 'px';
      pn.el.style.top = y + 'px';
      // the line meets the pop-up's nearest edge
      const ex = FS.clamp(at.x, x, x + pw), ey = FS.clamp(at.y, y, y + ph);
      if (Math.hypot(ex - at.x, ey - at.y) > 6) {
        lines += `<line x1="${at.x.toFixed(1)}" y1="${at.y.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}"/><circle cx="${at.x.toFixed(1)}" cy="${at.y.toFixed(1)}" r="3.5"/>`;
      }
    }
    if (svg) { svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.innerHTML = lines; }
  };

  // Drag a pop-up by its title bar.
  function makeDraggable(pn, handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY, ox: pn.off.x, oy: pn.off.y };
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* old browsers */ }
      const move = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        pn.off = { x: start.ox + ev.clientX - start.x, y: start.oy + ev.clientY - start.y };
        if (pn.ctx === 'editor') E.render();
      };
      const up = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  // ---------- Controls ----------
  // A labelled slider. onInput runs while dragging (no undo step); onChange when let go.
  function slider(box, label, min, max, step, value, fmt, onInput, onChange) {
    const row = el('label', 'pp-row');
    const top = el('span', 'pp-label');
    const out = el('output', 'pp-val', fmt(value));
    top.append(el('span', '', label), out);
    const r = el('input');
    Object.assign(r, { type: 'range', min, max, step, value });
    r.addEventListener('input', () => { const v = +r.value; const shown = onInput(v); out.textContent = fmt(shown ?? v); if (shown !== undefined) r.value = shown; });
    r.addEventListener('change', () => onChange(+r.value));
    row.append(top, r);
    box.appendChild(row);
    return r;
  }
  function choices(box, label, list, current, onPick) {
    const wrap = el('div', 'pp-row');
    wrap.appendChild(el('span', 'pp-label', label));
    const g = el('div', 'pp-choices');
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', label);
    for (const [value, text, extra] of list) {
      const b = el('button', 'pp-choice' + (extra ? ' ' + extra : ''), text);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(value === current));
      b.addEventListener('click', () => onPick(value));
      g.appendChild(b);
    }
    wrap.appendChild(g);
    box.appendChild(wrap);
  }
  function toggle(box, label, on, onSet, hint) {
    const b = el('button', 'pp-toggle');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(!!on));
    b.append(el('span', 'pp-switch'), el('span', '', label));
    if (hint) b.title = hint;
    b.addEventListener('click', () => onSet(!on));
    box.appendChild(b);
  }
  function action(box, label, fn, kind = '') {
    const b = el('button', 'pp-action ' + kind, label);
    b.type = 'button';
    b.addEventListener('click', fn);
    box.appendChild(b);
    return b;
  }

  // ---------- Contents ----------
  const t = (kg) => (kg / 1000).toFixed(kg < 1000 ? 3 : 2) + ' t';
  P.build = (pn) => {
    const p = pn.part, d = p.def, box = pn.el;
    box.innerHTML = '';
    const head = el('div', 'pp-head');
    head.appendChild(el('h3', '', d.name));
    const pin = el('button', 'pp-pin', '📌');
    pin.type = 'button';
    pin.title = 'Pin: keep this open when another part is selected';
    pin.setAttribute('aria-label', 'Pin');
    pin.setAttribute('aria-pressed', String(pn.pinned));
    pin.addEventListener('click', () => { pn.pinned = !pn.pinned; pin.setAttribute('aria-pressed', String(pn.pinned)); box.classList.toggle('pinned', pn.pinned); });
    const x = el('button', 'pp-close', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', () => P.close(pn));
    head.append(pin, x);
    box.appendChild(head);
    box.classList.toggle('pinned', pn.pinned);
    makeDraggable(pn, head);
    pn.live = null;
    if (pn.ctx === 'flight') buildFlight(pn, box);
    else buildEditor(pn, box);
  };

  function buildEditor(pn, box) {
    const p = pn.part, d = p.def;
    const rebuild = () => { if (panels.includes(pn)) P.build(pn); };
    const info = el('p', 'pp-sub', `${t(FS.partMass(p))}${p.cap ? ` · ${t(p.fuel)} of ${t(p.cap)} fuel` : ''}`);
    box.appendChild(info);
    if (FS.Build.twinOf(E.parts, p)) box.appendChild(el('p', 'pp-note', 'Changes apply to its mirror twin too.'));
    // a floating part: launch it with the craft, or leave it behind
    let root = p;
    while (root.parent) root = root.parent;
    if (root !== E.parts[0]) {
      box.appendChild(el('p', 'pp-note', 'Floating: not attached to the craft.'));
      choices(box, 'At launch', [['keep', 'Launch with the craft'], ['drop', 'Leave behind']], root.loose || 'drop', (v) => { root.loose = v; E.changed(); rebuild(); });
    }
    if (d.stretch) {
      const max = FS.MAX_TANK_LEN;
      const lenRange = slider(box, 'Length', FS.LEN_STEP, max, FS.LEN_STEP, p.len, (v) => `${(+v).toFixed(2)} m`,
        (v) => { E.setLength(p, v, false); return p.len; },
        () => { E.changed(); rebuild(); });
      const step = el('div', 'pp-steps');
      for (const [txt, dv] of [['−0.25', -FS.LEN_STEP], ['+0.25', FS.LEN_STEP], ['−1', -1], ['+1', 1]]) {
        const b = el('button', 'pp-choice', txt);
        b.type = 'button';
        b.setAttribute('aria-label', `${dv > 0 ? 'Lengthen' : 'Shorten'} by ${Math.abs(dv)} m`);
        b.addEventListener('click', () => { E.setLength(p, FS.clamp(p.len + dv, FS.LEN_STEP, max)); lenRange.value = p.len; rebuild(); });
        step.appendChild(b);
      }
      box.appendChild(step);
      choices(box, 'Width', FS.TANK_WIDTHS.map((w) => [w, w + ' m']), p.size, (w) => { E.setWidth(p, w); rebuild(); });
      choices(box, 'Look', FS.TANK_SKINS.map((k) => [k, SKIN_NAMES[k], 'skin skin-' + k]), p.skin, (k) => { E.setSetting(p, 'skin', k); rebuild(); });
    }
    if (d.fuel) {
      slider(box, 'Fuel at launch', 0, 100, 5, Math.round(p.fill * 100), (v) => `${v}%`,
        (v) => { E.setSetting(p, 'fill', v / 100, false); info.textContent = `${t(FS.partMass(p))} · ${t(p.fuel)} of ${t(p.cap)} fuel`; },
        (v) => E.setSetting(p, 'fill', v / 100));
    }
    engineSliders(box, p, (k, v, rec) => E.setSetting(p, k, v, rec));
    if (d.decoupler) {
      toggle(box, 'Crossfeed: fuel flows across it', p.crossfeed, (on) => { E.setSetting(p, 'crossfeed', on); rebuild(); },
        'With crossfeed on, engines on one side can drink from tanks on the other until it fires.');
    }
    if (d.chute) chuteSlider(box, p, (v, rec) => E.setSetting(p, 'chuteAlt', v, rec));
    if (FS.stageable(p) && root === E.parts[0]) {
      const staged = !(typeof p.stage === 'number' && p.stage < 0);
      toggle(box, 'Fires in staging', staged, (on) => { FS.StagingEditor.setStaged(p, on); rebuild(); },
        'Turn off to leave this part out of the stage list.');
    }
    if (!box.querySelector('input, .pp-choice, .pp-toggle')) box.appendChild(el('p', 'pp-note', 'This part has no settings.'));
  }

  function engineSliders(box, p, set) {
    const e = p.def.engine;
    if (!e) return;
    slider(box, 'Thrust limit', 0, 100, 5, Math.round(p.limit * 100), (v) => `${v}% · ${((e.vac * v) / 100000).toFixed(0)} kN`,
      (v) => { set('limit', v / 100, false); }, (v) => set('limit', v / 100, true));
    if (e.gimbal) {
      slider(box, 'Gimbal range', 0, 100, 5, Math.round(p.gimbal * 100), (v) => `${v}% · ±${((e.gimbal * v) / 100).toFixed(1)}°`,
        (v) => { set('gimbal', v / 100, false); }, (v) => set('gimbal', v / 100, true));
    }
  }
  function chuteSlider(box, p, set) {
    slider(box, 'Opens fully at', 100, 3000, 50, p.chuteAlt, (v) => `${v} m above ground`, (v) => { set(v, false); }, (v) => set(v, true));
  }

  // In flight: live readouts, the settings that can still change, and actions.
  function buildFlight(pn, box) {
    const p = pn.part, d = p.def, G = FS.game;
    const ves = () => G.vessel;
    const status = el('p', 'pp-sub', '');
    box.appendChild(status);
    const set = (k, v) => { p[k] = v; };
    pn.live = () => {
      const bits = [t(FS.partMass(p))];
      if (p.cap) bits.push(`${t(p.fuel)} of ${t(p.cap)} fuel`);
      if (d.engine) bits.push(d.engine.solid ? (p.lit ? (p.solid > 0 ? 'burning' : 'burnt out') : 'not lit') : p.lit ? 'running' : 'off');
      if (d.chute) bits.push({ stowed: 'packed', armed: 'armed', semi: 'half open', full: 'open' }[p.chute] || '');
      const txt = bits.join(' · ');
      if (status.textContent !== txt) status.textContent = txt;
    };
    pn.live();
    engineSliders(box, p, (k, v) => set(k, v));
    if (d.engine) {
      if (d.engine.solid) { if (!p.lit) action(box, 'Ignite', () => { ves().act(p, 'ignite', G); P.build(pn); }, 'go'); }
      else action(box, p.lit ? 'Shut down' : 'Activate engine', () => { ves().act(p, p.lit ? 'shutdown' : 'ignite', G); P.build(pn); }, p.lit ? '' : 'go');
    }
    if (d.decoupler) {
      toggle(box, 'Crossfeed: fuel flows across it', p.crossfeed, (on) => { p.crossfeed = on; P.build(pn); });
      action(box, 'Decouple', () => { ves().act(p, 'decouple', G); P.close(pn); }, 'warn');
    }
    if (d.chute) {
      chuteSlider(box, p, (v) => set('chuteAlt', v));
      if (p.chute === 'stowed') action(box, 'Deploy (opens when it is safe)', () => { ves().act(p, 'deploy', G); P.build(pn); }, 'go');
    }
  }

  // ---------- Craft files ----------
  // Export and import craft as files, or as text to paste into a chat or a forum post.
  const C = (FS.CraftFiles = {});
  const msg = (text, bad) => { const m = $('cfMsg'); m.textContent = text; m.classList.toggle('bad', !!bad); };

  C.open = () => {
    const E = FS.Editor;
    $('cfText').value = '';
    msg(`“${E.name}”, ${E.parts.length} parts.`);
    $('craftFiles').hidden = false;
    $('cfDownload').focus();
  };
  C.close = () => { $('craftFiles').hidden = true; };

  C.init = () => {
    const E = FS.Editor;
    $('cfClose').addEventListener('click', C.close);
    $('craftFiles').addEventListener('click', (e) => { if (e.target.id === 'craftFiles') C.close(); });
    $('craftFiles').addEventListener('keydown', (e) => { if (e.key === 'Escape') C.close(); });
    $('cfDownload').addEventListener('click', () => {
      const json = FS.craftToJSON(E.name, E.parts);
      try {
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = (E.name.replace(/[^\w\- ]+/g, '').trim() || 'craft') + '.craft.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        msg(`Downloaded ${a.download}.`);
      } catch (err) { msg('Your browser could not create the file. Use "Copy as text" instead.', true); }
    });
    $('cfOpen').addEventListener('click', () => $('cfFile').click());
    $('cfFile').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => C.importText(String(r.result));
      r.onerror = () => msg('Could not read that file.', true);
      r.readAsText(f);
      e.target.value = '';
    });
    $('cfCopy').addEventListener('click', () => {
      const text = FS.craftToText(E.name, E.parts);
      $('cfText').value = text;
      $('cfText').select();
      const done = () => msg('Copied. Paste it anywhere; anyone can load it with "Load pasted text".');
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => msg('Select the text below and copy it.'));
      else msg('Select the text below and copy it.');
    });
    $('cfPaste').addEventListener('click', () => {
      const text = $('cfText').value.trim();
      if (!text) { msg('Paste craft text into the box first.', true); $('cfText').focus(); return; }
      C.importText(text);
    });
  };

  // Load a craft from file or pasted text into the hangar.
  C.importText = (text) => {
    const res = FS.craftFromText(text);
    if (res.error) { msg(res.error, true); return false; }
    const parts = FS.partsFromSerial(res.parts);
    if (!parts.length) { msg('That craft has no parts this version of the game knows.', true); return false; }
    FS.Editor.load(res.name, parts);
    msg(`Loaded “${res.name}”${res.skipped ? `, without ${res.skipped} unknown part${res.skipped > 1 ? 's' : ''}` : ''}.`);
    FS.Editor.say(`Loaded “${res.name}” from a craft file.`);
    setTimeout(C.close, 700);
    return true;
  };
})();
