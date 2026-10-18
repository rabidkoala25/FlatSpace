// staging-editor.js — the hangar's stage list, editable.
// Staging is automatic (worked out from the part tree, partgraph.js) until the player
// edits it; the first edit freezes the automatic stages into stage numbers on the parts,
// which are saved with the craft. Parts can be dragged between stages (as chips), stages
// moved up or down, added and removed, parts left out of staging, and everything reset.
(function () {
  const S = (FS.StagingEditor = {});
  const $ = (id) => document.getElementById(id);
  let E = null;
  S.emptyStages = 0; // empty stages added with "+ Stage", shown until parts are dragged in

  S.init = (editor) => {
    E = editor;
    $('btnStageAdd').addEventListener('click', () => S.add());
    $('btnStageReset').addEventListener('click', () => S.reset());
  };

  // ---------- Operations (also used by tests) ----------
  const custom = () => { if (!FS.customStaging(E.parts)) FS.freezeStaging(E.parts); };
  const maxStage = () => Math.max(-1, ...E.parts.map((p) => (typeof p.stage === 'number' ? p.stage : -1)));

  // Renumber stages 0, 1, 2… in order, without gaps.
  function compact() {
    const used = [...new Set(E.parts.filter((p) => p.stage >= 0).map((p) => p.stage))].sort((a, b) => a - b);
    const map = new Map(used.map((k, i) => [k, i]));
    for (const p of E.parts) if (p.stage >= 0) p.stage = map.get(p.stage);
  }

  // Move parts to stage k (0 = fires first), 'new' (a new last stage) or 'none' (left out).
  S.move = (parts, k) => {
    custom();
    if (k === 'none') k = -1;
    else if (k === 'new' || k > maxStage()) {
      // into a new last stage (an empty one added with "+ Stage" fills up first)
      k = maxStage() + 1;
      S.emptyStages = Math.max(0, S.emptyStages - 1);
    }
    for (const p of parts) p.stage = k;
    compact();
    E.changed();
  };

  // Swap stage k with the one before (d = -1) or after (d = +1).
  S.shift = (k, d) => {
    custom();
    const j = k + d;
    if (j < 0 || j > maxStage()) return;
    for (const p of E.parts) {
      if (p.stage === k) p.stage = j;
      else if (p.stage === j) p.stage = k;
    }
    E.changed();
  };

  // Remove stage k: its parts join the next stage (or the previous one, if it was last).
  S.remove = (k) => {
    custom();
    const last = maxStage();
    if (k > last) { S.emptyStages = Math.max(0, S.emptyStages - 1); E.render(); E.updateStats(); return; }
    const to = k < last ? k + 1 : k - 1;
    for (const p of E.parts) if (p.stage === k) p.stage = Math.max(0, to);
    compact();
    E.changed();
  };

  S.add = () => { custom(); S.emptyStages++; E.changed(); E.updateStats(); };
  S.reset = () => { FS.resetStaging(E.parts); S.emptyStages = 0; E.changed(); E.say('Staging is automatic again.'); };

  // Put a part (and its mirror twin) in or out of staging.
  S.setStaged = (p, on) => {
    const twin = FS.Build.twinOf(E.parts, p);
    custom();
    const parts = [p, twin].filter(Boolean);
    if (on) { const k = maxStage() + 1; for (const q of parts) q.stage = k; compact(); }
    else for (const q of parts) q.stage = -1;
    E.changed();
  };

  // In custom staging, new stageable parts (just added) go into a new last stage together.
  S.assignNew = (parts) => {
    if (!FS.customStaging(parts)) return 0;
    const fresh = parts.filter((p) => FS.stageable(p) && typeof p.stage !== 'number');
    if (!fresh.length) return 0;
    const k = Math.max(-1, ...parts.map((p) => (typeof p.stage === 'number' ? p.stage : -1))) + 1;
    for (const p of fresh) p.stage = k;
    return fresh.length;
  };

  // ---------- Drawing ----------
  // Chips group a part with its mirror twin when both are in the same stage.
  function units(parts) {
    const out = [], seen = new Set();
    for (const p of parts) {
      if (seen.has(p)) continue;
      const t = FS.Build.twinOf(E.parts, p);
      const group = t && parts.includes(t) ? [p, t] : [p];
      group.forEach((q) => seen.add(q));
      out.push(group);
    }
    return out;
  }
  const shortName = (d) => d.name.replace(/ Engine| Solid Booster| Capsule| Probe Core/, '').replace('Stack Decoupler', 'Decoupler').replace('Side Decoupler', 'Side decoupler');

  function chip(group, editable) {
    const p = group[0];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'stg-chip ' + (p.def.engine ? 'eng' : p.def.decoupler ? 'dec' : 'chute');
    b.textContent = (group.length > 1 ? group.length + '× ' : '') + shortName(p.def);
    b.title = editable ? 'Drag to another stage. Click to select it. [ and ] move it a stage up or down.' : p.def.name;
    b.setAttribute('aria-label', `${group.length > 1 ? group.length + ' ' : ''}${p.def.name}${editable ? ', press [ or ] to move between stages' : ''}`);
    if (group.includes(E.sel)) b.classList.add('sel');
    b.addEventListener('click', () => { if (dragged) return; E.sel = p; E.render(); });
    if (editable) {
      b.addEventListener('keydown', (e) => {
        if (e.key !== '[' && e.key !== ']') return;
        e.preventDefault();
        const from = typeof p.stage === 'number' ? p.stage : stageIndexOf(p);
        const to = from + (e.key === '[' ? -1 : 1);
        if (to < 0) return;
        S.move(group, to > maxStageNow() ? 'new' : to);
      });
      b.addEventListener('pointerdown', (e) => startChipDrag(e, group, b));
    }
    return b;
  }
  // stage index of a part in automatic staging (before the first edit)
  function stageIndexOf(p) { return FS.stagesOf(E.parts).findIndex((ev) => ev.parts.includes(p)); }
  const maxStageNow = () => (FS.customStaging(E.parts) ? maxStage() : FS.stagesOf(E.parts).length - 1);

  // ---------- Dragging chips ----------
  let drag = null, dragged = false;
  function startChipDrag(e, group, src) {
    if (e.button !== 0) return;
    dragged = false;
    drag = { group, x: e.clientX, y: e.clientY, src, ghost: null, id: e.pointerId };
    try { src.setPointerCapture(e.pointerId); } catch (err) { /* old browsers */ }
  }
  function dropTarget(e) {
    const el = document.elementFromPoint ? document.elementFromPoint(e.clientX, e.clientY) : null;
    return el && el.closest ? el.closest('[data-stage]') : null;
  }
  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.ghost && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 5) {
      drag.ghost = drag.src.cloneNode(true);
      drag.ghost.classList.add('stg-ghost');
      document.body.appendChild(drag.ghost);
      dragged = true;
    }
    if (drag.ghost) {
      drag.ghost.style.left = e.clientX + 8 + 'px';
      drag.ghost.style.top = e.clientY + 8 + 'px';
      for (const t of document.querySelectorAll('[data-stage].drop')) t.classList.remove('drop');
      const t = dropTarget(e);
      if (t) t.classList.add('drop');
    }
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (d.ghost) d.ghost.remove();
    for (const t of document.querySelectorAll('[data-stage].drop')) t.classList.remove('drop');
    if (!d.ghost || e.type === 'pointercancel') return;
    const t = dropTarget(e);
    if (t) {
      const k = t.dataset.stage;
      S.move(d.group, k === 'new' || k === 'none' ? k : +k);
    }
    setTimeout(() => (dragged = false), 0);
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  // ---------- The stage list ----------
  // stages, sv, sa: the stage events and their vacuum / sea-level stats (editor.js).
  S.render = (parts, stages, sv, sa, editable) => {
    const list = $('stageList');
    list.innerHTML = '';
    const isCustom = FS.customStaging(parts);
    const shown = isCustom ? FS.customStages(parts, true) : stages.map((ev, i) => Object.assign({ index: i }, ev));
    for (let k = 0; k < S.emptyStages && isCustom && editable; k++) shown.push({ parts: [], decouplers: [], engines: [], chuteParts: [], index: shown.length, empty: true });
    $('stageMode').textContent = isCustom ? 'Custom' : 'Automatic';
    $('btnStageReset').hidden = !isCustom || !editable;
    $('btnStageAdd').hidden = !editable;

    let real = 0;
    shown.forEach((ev, k) => {
      const li = document.createElement('li');
      li.className = 'stage-card';
      if (editable) li.dataset.stage = String(ev.index);
      const what = [];
      if (ev.decouplers.length) what.push('Decouple' + (ev.decouplers.length > 1 ? ' ×' + ev.decouplers.length : ''));
      if (ev.engines.length) {
        const names = {};
        ev.engines.forEach((p) => (names[p.def.name] = (names[p.def.name] || 0) + 1));
        what.push('Ignite ' + Object.entries(names).map(([n, c]) => (c > 1 ? c + '× ' : '') + n.replace(/ Engine| Solid Booster/, '')).join(', '));
      }
      if (ev.chuteParts.length) what.push('Deploy parachutes');
      let dv = '', nums = '';
      if (ev.parts.length) {
        const v = sv.events[real], a = sa.events[real];
        real++;
        if (v && (ev.engines.length || v.dv > 0.5)) {
          dv = `${v.dv.toFixed(0)} m/s`;
          const twrCls = real === 1 && a.twr < 1 ? ' class="bad"' : '';
          nums = `<span${twrCls}>TWR ${a.twr.toFixed(2)}</span><span>ASL ${a.dv.toFixed(0)}</span><span>${v.time.toFixed(0)} s</span>`;
        }
      }
      li.innerHTML = `<header><span class="sn">Stage ${k + 1}</span><span class="dv">${dv}</span></header><div class="what">${ev.parts.length ? what.join(' · ') : 'Empty: drag parts here'}</div>${nums ? `<div class="nums">${nums}</div>` : ''}`;
      const chips = document.createElement('div');
      chips.className = 'stg-chips';
      units(ev.parts).forEach((g) => chips.appendChild(chip(g, editable)));
      li.appendChild(chips);
      if (editable) {
        const tools = document.createElement('div');
        tools.className = 'stg-tools';
        const mk = (txt, label, fn, disabled) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'stg-tool';
          b.textContent = txt;
          b.title = label;
          b.setAttribute('aria-label', `${label} (stage ${k + 1})`);
          b.disabled = !!disabled;
          b.addEventListener('click', fn);
          tools.appendChild(b);
        };
        mk('▲', 'Fire earlier', () => { custom(); S.shift(ev.index, -1); }, k === 0 || ev.empty);
        mk('▼', 'Fire later', () => { custom(); S.shift(ev.index, +1); }, k >= shown.length - 1 - S.emptyStages || ev.empty);
        mk('×', ev.parts.length ? 'Remove stage (its parts join the next stage)' : 'Remove empty stage', () => S.remove(ev.index));
        li.querySelector('header').appendChild(tools);
      }
      list.appendChild(li);
    });

    if (editable) {
      const off = parts.filter((p) => p.stage === -1);
      const li = document.createElement('li');
      li.className = 'stage-card stg-off';
      li.dataset.stage = 'none';
      li.innerHTML = `<header><span class="sn">Not staged</span></header><div class="what">${off.length ? 'Left out of the stage list' : 'Drop parts here to leave them out of staging'}</div>`;
      const chips = document.createElement('div');
      chips.className = 'stg-chips';
      units(off).forEach((g) => chips.appendChild(chip(g, true)));
      li.appendChild(chips);
      list.appendChild(li);
    }
  };
})();
