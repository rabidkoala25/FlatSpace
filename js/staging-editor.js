// staging-editor.js — the hangar's stage list, editable.
// Staging is automatic (worked out from the part tree, partgraph.js) until the player
// edits it; the first edit freezes the automatic stages into stage numbers on the parts,
// which are saved with the craft. Parts can be dragged between stages (as chips), stages
// moved up or down, added and removed, parts left out of staging, and everything reset.
(function () {
  const StagingEditor = (Flatspace.StagingEditor = {});
  const byId = (elementId) => document.getElementById(elementId);
  let hangarEditor = null;
  StagingEditor.emptyStages = 0; // empty stages added with "+ Stage", shown until parts are dragged in

  StagingEditor.initialise = (editor) => {
    hangarEditor = editor;
    byId('addStageButton').addEventListener('click', () => StagingEditor.add());
    byId('resetStagesButton').addEventListener('click', () => StagingEditor.reset());
  };

  // ---------- Operations (also used by tests) ----------
  const custom = () => {
    if (!Flatspace.customStaging(hangarEditor.main())) {
      Flatspace.freezeStaging(hangarEditor.main());
    }
  };
  const maxStage = () =>
    Math.max(-1, ...hangarEditor.main().map((part) => (typeof part.stage === 'number' ? part.stage : -1)));

  // Renumber stages 0, 1, 2… in order, without gaps.
  function compact() {
    const used = [
      ...new Set(
        hangarEditor
          .main()
          .filter((part) => part.stage >= 0)
          .map((part) => part.stage),
      ),
    ].sort((first, second) => first - second);
    const map = new Map(used.map((stageNumber, position) => [stageNumber, position]));
    for (const part of hangarEditor.main()) {
      if (part.stage >= 0) {
        part.stage = map.get(part.stage);
      }
    }
  }

  // Move parts to a stage number (0 = fires first), 'new' (a new last stage) or 'none' (left out).
  StagingEditor.move = (parts, stage) => {
    custom();
    if (stage === 'none') {
      stage = -1;
    } else if (stage === 'new' || stage > maxStage()) {
      // into a new last stage (an empty one added with "+ Stage" fills up first)
      stage = maxStage() + 1;
      StagingEditor.emptyStages = Math.max(0, StagingEditor.emptyStages - 1);
    }
    for (const part of parts) {
      part.stage = stage;
    }
    compact();
    hangarEditor.changed();
  };

  // Swap a stage with the one before (direction -1) or after (direction +1).
  StagingEditor.shift = (stage, direction) => {
    custom();
    const otherStage = stage + direction;
    if (otherStage < 0 || otherStage > maxStage()) {
      return;
    }
    for (const part of hangarEditor.main()) {
      if (part.stage === stage) {
        part.stage = otherStage;
      } else if (part.stage === otherStage) {
        part.stage = stage;
      }
    }
    hangarEditor.changed();
  };

  // Remove a stage: its parts join the next stage (or the previous one, if it was last).
  StagingEditor.remove = (stage) => {
    custom();
    const last = maxStage();
    if (stage > last) {
      StagingEditor.emptyStages = Math.max(0, StagingEditor.emptyStages - 1);
      hangarEditor.render();
      hangarEditor.updateStats();
      return;
    }
    const targetStage = stage < last ? stage + 1 : stage - 1;
    for (const part of hangarEditor.main()) {
      if (part.stage === stage) {
        part.stage = Math.max(0, targetStage);
      }
    }
    compact();
    hangarEditor.changed();
  };

  StagingEditor.add = () => {
    custom();
    StagingEditor.emptyStages++;
    hangarEditor.changed();
    hangarEditor.updateStats();
  };
  StagingEditor.reset = () => {
    Flatspace.resetStaging(hangarEditor.main());
    StagingEditor.emptyStages = 0;
    hangarEditor.changed();
    hangarEditor.say('Staging is automatic again.');
  };

  // Put a part (and its mirror twin) in or out of staging.
  StagingEditor.setStaged = (part, staged) => {
    const twin = Flatspace.Build.twinOf(hangarEditor.main(), part);
    custom();
    const parts = [part, twin].filter(Boolean);
    if (staged) {
      const newStage = maxStage() + 1;
      for (const groupPart of parts) {
        groupPart.stage = newStage;
      }
      compact();
    } else {
      for (const groupPart of parts) {
        groupPart.stage = -1;
      }
    }
    hangarEditor.changed();
  };

  // In custom staging, new stageable parts (just added) go into a new last stage together.
  StagingEditor.assignNew = (parts) => {
    if (!Flatspace.customStaging(parts)) {
      return 0;
    }
    const fresh = parts.filter((part) => Flatspace.stageable(part) && typeof part.stage !== 'number');
    if (!fresh.length) {
      return 0;
    }
    const newStage =
      Math.max(-1, ...parts.map((part) => (typeof part.stage === 'number' ? part.stage : -1))) + 1;
    for (const part of fresh) {
      part.stage = newStage;
    }
    return fresh.length;
  };

  // ---------- Drawing ----------
  // Chips group a part with its mirror twin when both are in the same stage.
  function units(parts) {
    const out = [];
    const seen = new Set();
    for (const part of parts) {
      if (seen.has(part)) {
        continue;
      }
      const twin = Flatspace.Build.twinOf(hangarEditor.main(), part);
      const group = twin && parts.includes(twin) ? [part, twin] : [part];
      group.forEach((groupPart) => seen.add(groupPart));
      out.push(group);
    }
    return out;
  }
  const shortName = (partType) =>
    partType.name
      .replace(/ Engine| Solid Booster| Capsule| Probe Core/, '')
      .replace('Stack Decoupler', 'Decoupler')
      .replace('Side Decoupler', 'Side decoupler');

  function chip(group, editable) {
    const part = group[0];
    const button = document.createElement('button');
    button.type = 'button';
    button.className =
      'stage-chip ' + (part.type.engine ? 'engine' : part.type.decoupler ? 'decoupler' : 'chute');
    button.textContent = (group.length > 1 ? group.length + '× ' : '') + shortName(part.type);
    button.title = editable
      ? 'Drag to another stage. Click to select it. [ and ] move it a stage up or down.'
      : part.type.name;
    button.setAttribute(
      'aria-label',
      `${group.length > 1 ? group.length + ' ' : ''}${part.type.name}${editable ? ', press [ or ] to move between stages' : ''}`,
    );
    if (group.includes(hangarEditor.selected)) {
      button.classList.add('selected');
    }
    button.addEventListener('click', () => {
      if (dragged) {
        return;
      }
      hangarEditor.selected = part;
      Flatspace.PartPanel.select(part, 'editor');
      hangarEditor.render();
    });
    if (editable) {
      button.addEventListener('keydown', (event) => {
        if (event.key !== '[' && event.key !== ']') {
          return;
        }
        event.preventDefault();
        const from = typeof part.stage === 'number' ? part.stage : stageIndexOf(part);
        const targetStage = from + (event.key === '[' ? -1 : 1);
        if (targetStage < 0) {
          return;
        }
        StagingEditor.move(group, targetStage > maxStageNow() ? 'new' : targetStage);
      });
      button.addEventListener('pointerdown', (event) => startChipDrag(event, group, button));
    }
    return button;
  }
  // stage index of a part in automatic staging (before the first edit)
  function stageIndexOf(part) {
    return Flatspace.stagesOf(hangarEditor.main()).findIndex((stage) => stage.parts.includes(part));
  }
  const maxStageNow = () =>
    Flatspace.customStaging(hangarEditor.main())
      ? maxStage()
      : Flatspace.stagesOf(hangarEditor.main()).length - 1;

  // ---------- Dragging chips ----------
  let drag = null;
  let dragged = false;
  function startChipDrag(event, group, sourceChip) {
    if (event.button !== 0) {
      return;
    }
    dragged = false;
    drag = { group, x: event.clientX, y: event.clientY, sourceChip, ghost: null, id: event.pointerId };
    try {
      sourceChip.setPointerCapture(event.pointerId);
    } catch (error) {
      /* old browsers */
    }
  }
  function dropTarget(event) {
    const element = document.elementFromPoint
      ? document.elementFromPoint(event.clientX, event.clientY)
      : null;
    return element && element.closest ? element.closest('[data-stage]') : null;
  }
  window.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) {
      return;
    }
    if (!drag.ghost && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 5) {
      drag.ghost = drag.sourceChip.cloneNode(true);
      drag.ghost.classList.add('stage-ghost');
      document.body.appendChild(drag.ghost);
      dragged = true;
    }
    if (drag.ghost) {
      drag.ghost.style.left = event.clientX + 8 + 'px';
      drag.ghost.style.top = event.clientY + 8 + 'px';
      for (const target of document.querySelectorAll('[data-stage].drop')) {
        target.classList.remove('drop');
      }
      const target = dropTarget(event);
      if (target) {
        target.classList.add('drop');
      }
    }
  });
  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.id) {
      return;
    }
    const dragState = drag;
    drag = null;
    if (dragState.ghost) {
      dragState.ghost.remove();
    }
    for (const target of document.querySelectorAll('[data-stage].drop')) {
      target.classList.remove('drop');
    }
    if (!dragState.ghost || event.type === 'pointercancel') {
      return;
    }
    const target = dropTarget(event);
    if (target) {
      const stage = target.dataset.stage;
      StagingEditor.move(dragState.group, stage === 'new' || stage === 'none' ? stage : +stage);
    }
    setTimeout(() => (dragged = false), 0);
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  // ---------- The stage list ----------
  // stages, sv, sa: the stage events and their vacuum / sea-level stats (editor.js).
  StagingEditor.render = (parts, stages, vacuumStats, seaLevelStats, editable) => {
    const list = byId('stageList');
    list.innerHTML = '';
    const isCustom = Flatspace.customStaging(parts);
    const shown = isCustom
      ? Flatspace.customStages(parts, true)
      : stages.map((stage, index) => Object.assign({ index }, stage));
    for (let emptyIndex = 0; emptyIndex < StagingEditor.emptyStages && isCustom && editable; emptyIndex++) {
      shown.push({
        parts: [],
        decouplers: [],
        engines: [],
        chuteParts: [],
        index: shown.length,
        empty: true,
      });
    }
    byId('stageMode').textContent = isCustom ? 'Custom' : 'Automatic';
    byId('resetStagesButton').hidden = !isCustom || !editable;
    byId('addStageButton').hidden = !editable;

    let real = 0;
    shown.forEach((stage, stageIndex) => {
      const listItem = document.createElement('li');
      listItem.className = 'stage-card';
      if (editable) {
        listItem.dataset.stage = String(stage.index);
      }
      const what = [];
      if (stage.decouplers.length) {
        what.push('Decouple' + (stage.decouplers.length > 1 ? ' ×' + stage.decouplers.length : ''));
      }
      if (stage.engines.length) {
        const names = {};
        stage.engines.forEach((part) => (names[part.type.name] = (names[part.type.name] || 0) + 1));
        what.push(
          'Ignite ' +
            Object.entries(names)
              .map(
                ([name, count]) =>
                  (count > 1 ? count + '× ' : '') + name.replace(/ Engine| Solid Booster/, ''),
              )
              .join(', '),
        );
      }
      if (stage.chuteParts.length) {
        what.push('Deploy parachutes');
      }
      let deltaVText = '';
      let statsHtml = '';
      if (stage.parts.length) {
        const vacuumStage = vacuumStats.events[real];
        const seaLevelStage = seaLevelStats.events[real];
        real++;
        if (vacuumStage && (stage.engines.length || vacuumStage.deltaV > 0.5)) {
          deltaVText = `${vacuumStage.deltaV.toFixed(0)} m/s`;
          const thrustToWeightClass = real === 1 && seaLevelStage.thrustToWeight < 1 ? ' class="bad"' : '';
          statsHtml = `<span${thrustToWeightClass}>TWR ${seaLevelStage.thrustToWeight.toFixed(2)}</span><span>ASL ${seaLevelStage.deltaV.toFixed(0)}</span><span>${vacuumStage.time.toFixed(0)} s</span>`;
        }
      }
      listItem.innerHTML = `<header><span class="stage-number">Stage ${stageIndex + 1}</span><span class="delta-v">${deltaVText}</span></header><div class="what">${stage.parts.length ? what.join(' · ') : 'Empty: drag parts here'}</div>${statsHtml ? `<div class="stage-numbers">${statsHtml}</div>` : ''}`;
      const chips = document.createElement('div');
      chips.className = 'stage-chips';
      units(stage.parts).forEach((group) => chips.appendChild(chip(group, editable)));
      listItem.appendChild(chips);
      if (editable) {
        const tools = document.createElement('div');
        tools.className = 'stage-tools';
        const makeButton = (text, label, onClick, disabled) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'stage-tool';
          button.textContent = text;
          button.title = label;
          button.setAttribute('aria-label', `${label} (stage ${stageIndex + 1})`);
          button.disabled = !!disabled;
          button.addEventListener('click', onClick);
          tools.appendChild(button);
        };
        makeButton(
          '▲',
          'Fire earlier',
          () => {
            custom();
            StagingEditor.shift(stage.index, -1);
          },
          stageIndex === 0 || stage.empty,
        );
        makeButton(
          '▼',
          'Fire later',
          () => {
            custom();
            StagingEditor.shift(stage.index, +1);
          },
          stageIndex >= shown.length - 1 - StagingEditor.emptyStages || stage.empty,
        );
        makeButton(
          '×',
          stage.parts.length ? 'Remove stage (its parts join the next stage)' : 'Remove empty stage',
          () => StagingEditor.remove(stage.index),
        );
        listItem.querySelector('header').appendChild(tools);
      }
      list.appendChild(listItem);
    });

    if (editable) {
      const unstaged = parts.filter((part) => part.stage === -1);
      const listItem = document.createElement('li');
      listItem.className = 'stage-card stage-off';
      listItem.dataset.stage = 'none';
      listItem.innerHTML = `<header><span class="stage-number">Not staged</span></header><div class="what">${unstaged.length ? 'Left out of the stage list' : 'Drop parts here to leave them out of staging'}</div>`;
      const chips = document.createElement('div');
      chips.className = 'stage-chips';
      units(unstaged).forEach((group) => chips.appendChild(chip(group, true)));
      listItem.appendChild(chips);
      list.appendChild(listItem);
    }
  };
})();
