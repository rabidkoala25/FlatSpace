// part-panel.js — the hangar's part settings panel ("tweakables") and the craft file dialog.
// Settings: tank length, width, look and fuel level; engine thrust limit and gimbal;
// decoupler crossfeed; parachute opening height; whether the part fires in staging.
// Changes go through the editor (FS.Editor) so they reach mirror twins and undo.
(function () {
  const P = (FS.PartPanel = {});
  const $ = (id) => document.getElementById(id);
  const SKIN_NAMES = { white: 'White', gold: 'Gold foil', foam: 'Orange foam', roll: 'Roll pattern', steel: 'Bare steel' };
  let E = null, part = null;

  P.init = (editor) => {
    E = editor;
    $('partPanel').addEventListener('keydown', (e) => { if (e.key === 'Escape') { P.close(); e.stopPropagation(); } });
  };
  P.isOpen = () => !$('partPanel').hidden;
  P.close = () => { $('partPanel').hidden = true; part = null; };
  // Called after every redraw: close if the part is gone (removed, undone, picked up).
  P.refresh = () => { if (part && (!E.parts.includes(part) || E.drag)) P.close(); };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  // A labelled slider. onInput runs while dragging (no undo step); onChange when let go.
  function slider(host, label, min, max, step, value, fmt, onInput, onChange) {
    const row = el('label', 'pp-row');
    const top = el('span', 'pp-label');
    const name = el('span', '', label);
    const out = el('output', 'pp-val', fmt(value));
    top.append(name, out);
    const r = el('input');
    Object.assign(r, { type: 'range', min, max, step, value });
    r.addEventListener('input', () => { const v = +r.value; const shown = onInput(v); out.textContent = fmt(shown ?? v); if (shown !== undefined) r.value = shown; });
    r.addEventListener('change', () => onChange(+r.value));
    row.append(top, r);
    host.appendChild(row);
    return r;
  }

  function choices(host, label, list, current, onPick) {
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
    host.appendChild(wrap);
  }

  function toggle(host, label, on, onSet, hint) {
    const b = el('button', 'pp-toggle');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(!!on));
    b.append(el('span', 'pp-switch'), el('span', '', label));
    if (hint) b.title = hint;
    b.addEventListener('click', () => onSet(!on));
    host.appendChild(b);
  }

  P.open = (p) => {
    if (!p || !E.parts.includes(p)) return;
    part = p;
    P.build();
    $('partPanel').hidden = false;
  };

  // (Re)build the panel for the current part.
  P.build = () => {
    const p = part, d = p.def;
    const host = $('partPanel');
    host.innerHTML = '';
    const head = el('div', 'pp-head');
    head.appendChild(el('h3', '', d.name));
    const x = el('button', 'pp-close', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close part settings');
    x.addEventListener('click', P.close);
    head.appendChild(x);
    host.appendChild(head);
    const t = (kg) => (kg / 1000).toFixed(kg < 1000 ? 3 : 2) + ' t';
    const info = el('p', 'pp-sub', `${t(FS.partMass(p))}${p.cap ? ` · ${t(p.fuel)} of ${t(p.cap)} fuel` : ''}`);
    host.appendChild(info);
    if (B().twinOf(E.parts, p)) host.appendChild(el('p', 'pp-note', 'Changes apply to its mirror twin too.'));
    const rebuild = () => { if (part) P.build(); };

    if (d.stretch) {
      const max = FS.MAX_TANK_LEN;
      const lenRange = slider(host, 'Length', FS.LEN_STEP, max, FS.LEN_STEP, p.len, (v) => `${(+v).toFixed(2)} m`,
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
      host.appendChild(step);
      choices(host, 'Width', FS.TANK_WIDTHS.map((w) => [w, w + ' m']), p.size, (w) => { E.setWidth(p, w); rebuild(); });
      choices(host, 'Look', FS.TANK_SKINS.map((k) => [k, SKIN_NAMES[k], 'skin skin-' + k]), p.skin, (k) => { E.setSetting(p, 'skin', k); rebuild(); });
    }
    if (d.fuel) {
      slider(host, 'Fuel at launch', 0, 100, 5, Math.round(p.fill * 100), (v) => `${v}%`,
        (v) => { E.setSetting(p, 'fill', v / 100, false); info.textContent = `${t(FS.partMass(p))} · ${t(p.fuel)} of ${t(p.cap)} fuel`; },
        (v) => E.setSetting(p, 'fill', v / 100));
    }
    if (d.engine) {
      const e = d.engine;
      slider(host, 'Thrust limit', 0, 100, 5, Math.round(p.limit * 100), (v) => `${v}% · ${((e.vac * v) / 100000).toFixed(0)} kN`,
        (v) => { E.setSetting(p, 'limit', v / 100, false); },
        (v) => E.setSetting(p, 'limit', v / 100));
      if (e.gimbal) {
        slider(host, 'Gimbal range', 0, 100, 5, Math.round(p.gimbal * 100), (v) => `${v}% · ±${((e.gimbal * v) / 100).toFixed(1)}°`,
          (v) => { E.setSetting(p, 'gimbal', v / 100, false); },
          (v) => E.setSetting(p, 'gimbal', v / 100));
      }
    }
    if (d.decoupler) {
      toggle(host, 'Crossfeed: fuel flows across it', p.crossfeed, (on) => { E.setSetting(p, 'crossfeed', on); rebuild(); },
        'With crossfeed on, engines on one side can drink from tanks on the other until it fires.');
    }
    if (d.chute) {
      slider(host, 'Opens fully at', 100, 3000, 50, p.chuteAlt, (v) => `${v} m above ground`,
        (v) => { E.setSetting(p, 'chuteAlt', v, false); },
        (v) => E.setSetting(p, 'chuteAlt', v));
    }
    if (FS.stageable(p)) {
      const staged = !(typeof p.stage === 'number' && p.stage < 0);
      toggle(host, 'Fires in staging', staged, (on) => { FS.StagingEditor.setStaged(p, on); rebuild(); },
        'Turn off to leave this part out of the stage list.');
    }
    if (!host.querySelector('input, .pp-choice, .pp-toggle')) host.appendChild(el('p', 'pp-note', 'This part has no settings.'));
  };
  const B = () => FS.Build;

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
