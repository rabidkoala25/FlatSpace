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
// parachutes can be used directly. Hangar changes go through Flatspace.Editor so they reach mirror
// twins and undo.
(function () {
  const PartPanel = (Flatspace.PartPanel = {});
  const byId = (elementId) => document.getElementById(elementId);
  const SKIN_NAMES = {
    white: 'White',
    gold: 'Gold foil',
    foam: 'Orange foam',
    roll: 'Roll pattern',
    steel: 'Bare steel',
  };
  const panels = []; // { part, screen: 'editor' | 'flight', element, pinned, offset: {x, y} | null }
  let hangarEditor = null;
  const host = (screen) => (screen === 'editor' ? document.querySelector('#editor .hangar') : byId('flight'));

  PartPanel.initialise = (editor) => {
    hangarEditor = editor;
  };

  const makeElement = (tagName, className, text) => {
    const element = document.createElement(tagName);
    if (className) {
      element.className = className;
    }
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  };

  // ---------- Opening and closing ----------
  // A part was selected (null: nothing selected). Unpinned pop-ups give way to the new one.
  PartPanel.select = (part, screen = 'editor') => {
    for (const panel of panels.slice()) {
      if (panel.screen === screen && !panel.pinned && panel.part !== part) {
        PartPanel.close(panel);
      }
    }
    if (!part) {
      return;
    }
    const have = panels.find((panel) => panel.screen === screen && panel.part === part);
    if (have) {
      have.element.classList.add('flash');
      setTimeout(() => have.element.classList.remove('flash'), 300);
      return;
    }
    const panel = { part, screen, element: makeElement('div', 'part-panel'), pinned: false, offset: null };
    panel.element.setAttribute('role', 'dialog');
    panel.element.setAttribute('aria-label', `${part.type.name} settings`);
    panel.element.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        PartPanel.close(panel);
        event.stopPropagation();
      }
    });
    host(screen).appendChild(panel.element);
    panels.push(panel);
    PartPanel.build(panel);
  };
  PartPanel.open = (part, screen = 'editor') => PartPanel.select(part, screen);
  PartPanel.close = (panel) => {
    const panelIndex = panels.indexOf(panel);
    if (panelIndex >= 0) {
      panels.splice(panelIndex, 1);
    }
    panel.element.remove();
    const line = lineFor(panel.screen, false);
    if (line) {
      line.innerHTML = '';
    }
  };
  PartPanel.closeAll = (screen) => {
    for (const panel of panels.slice()) {
      if (!screen || panel.screen === screen) {
        PartPanel.close(panel);
      }
    }
  };
  PartPanel.isOpen = (screen = 'editor') => panels.some((panel) => panel.screen === screen);
  PartPanel.panels = (screen) => panels.filter((panel) => !screen || panel.screen === screen);
  // Rebuild every pop-up (after undo, load, or a change elsewhere); close those whose part is gone.
  PartPanel.rebuildAll = (screen, alive) => {
    for (const panel of panels.slice()) {
      if (panel.screen !== screen) {
        continue;
      }
      if (!alive(panel.part)) {
        PartPanel.close(panel);
      } else {
        PartPanel.build(panel);
      }
    }
  };

  // ---------- Placing pop-ups and their pointer lines ----------
  // An SVG layer in each host for the lines from pop-ups to their parts.
  function lineFor(screen, make = true) {
    const hostElement = host(screen);
    if (!hostElement) {
      return null;
    }
    let lineLayer = hostElement.querySelector(':scope > svg.part-panel-lines');
    if (!lineLayer && make) {
      lineLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      lineLayer.setAttribute('class', 'part-panel-lines');
      lineLayer.setAttribute('aria-hidden', 'true');
      hostElement.appendChild(lineLayer);
    }
    return lineLayer;
  }

  // Called every redraw: where = (part) => its point on screen, in the host's pixels, or
  // null if it can't be shown. hidden hides every pop-up of that screen (while dragging a part).
  PartPanel.layout = (screen, where, hidden = false) => {
    const hostElement = host(screen);
    if (!hostElement) {
      return;
    }
    const hostWidth = hostElement.clientWidth;
    const hostHeight = hostElement.clientHeight;
    const lineLayer = lineFor(
      screen,
      panels.some((panel) => panel.screen === screen),
    );
    let lines = '';
    for (const panel of panels) {
      if (panel.screen !== screen) {
        continue;
      }
      const anchor = hidden ? null : where(panel.part);
      panel.element.hidden = !anchor;
      if (!anchor) {
        continue;
      }
      if (panel.live) {
        panel.live();
      }
      const panelWidth = panel.element.offsetWidth || 270;
      const panelHeight = panel.element.offsetHeight || 200;
      if (!panel.offset) {
        panel.offset = {
          x: anchor.x + 60 + panelWidth < hostWidth ? 60 : -60 - panelWidth,
          y: -panelHeight / 2,
        };
      }
      const panelX = Flatspace.clamp(anchor.x + panel.offset.x, 4, Math.max(4, hostWidth - panelWidth - 4));
      const panelY = Flatspace.clamp(anchor.y + panel.offset.y, 4, Math.max(4, hostHeight - panelHeight - 4));
      panel.element.style.left = panelX + 'px';
      panel.element.style.top = panelY + 'px';
      // the line meets the pop-up's nearest edge
      const lineEndX = Flatspace.clamp(anchor.x, panelX, panelX + panelWidth);
      const lineEndY = Flatspace.clamp(anchor.y, panelY, panelY + panelHeight);
      if (Math.hypot(lineEndX - anchor.x, lineEndY - anchor.y) > 6) {
        lines += `<line x1="${anchor.x.toFixed(1)}" y1="${anchor.y.toFixed(1)}" x2="${lineEndX.toFixed(1)}" y2="${lineEndY.toFixed(1)}"/><circle cx="${anchor.x.toFixed(1)}" cy="${anchor.y.toFixed(1)}" r="3.5"/>`;
      }
    }
    if (lineLayer) {
      lineLayer.setAttribute('viewBox', `0 0 ${hostWidth} ${hostHeight}`);
      lineLayer.innerHTML = lines;
    }
  };

  // Drag a pop-up by its title bar.
  function makeDraggable(panel, handle) {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) {
        return;
      }
      event.preventDefault();
      const start = {
        x: event.clientX,
        y: event.clientY,
        startOffsetX: panel.offset.x,
        startOffsetY: panel.offset.y,
      };
      try {
        handle.setPointerCapture(event.pointerId);
      } catch (error) {
        /* old browsers */
      }
      const move = (moveEvent) => {
        if (moveEvent.pointerId !== event.pointerId) {
          return;
        }
        panel.offset = {
          x: start.startOffsetX + moveEvent.clientX - start.x,
          y: start.startOffsetY + moveEvent.clientY - start.y,
        };
        if (panel.screen === 'editor') {
          hangarEditor.render();
        }
      };
      const onUp = (upEvent) => {
        if (upEvent.pointerId !== event.pointerId) {
          return;
        }
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  }

  // ---------- Controls ----------
  // A labelled slider. onInput runs while dragging (no undo step); onChange when let go.
  function slider(container, label, min, max, step, value, format, onInput, onChange) {
    const row = makeElement('label', 'part-panel-row');
    const top = makeElement('span', 'part-panel-label');
    const out = makeElement('output', 'part-panel-value', format(value));
    top.append(makeElement('span', '', label), out);
    const range = makeElement('input');
    Object.assign(range, { type: 'range', min, max, step, value });
    range.addEventListener('input', () => {
      const value = +range.value;
      const shown = onInput(value);
      out.textContent = format(shown ?? value);
      if (shown !== undefined) {
        range.value = shown;
      }
    });
    range.addEventListener('change', () => onChange(+range.value));
    row.append(top, range);
    container.appendChild(row);
    return range;
  }
  function choices(container, label, list, current, onPick) {
    const wrap = makeElement('div', 'part-panel-row');
    wrap.appendChild(makeElement('span', 'part-panel-label', label));
    const group = makeElement('div', 'part-panel-choices');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    for (const [value, text, extra] of list) {
      const button = makeElement('button', 'part-panel-choice' + (extra ? ' ' + extra : ''), text);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(value === current));
      button.addEventListener('click', () => onPick(value));
      group.appendChild(button);
    }
    wrap.appendChild(group);
    container.appendChild(wrap);
  }
  function toggle(container, label, isOn, onSet, hint) {
    const button = makeElement('button', 'part-panel-toggle');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(!!isOn));
    button.append(makeElement('span', 'part-panel-switch'), makeElement('span', '', label));
    if (hint) {
      button.title = hint;
    }
    button.addEventListener('click', () => onSet(!isOn));
    container.appendChild(button);
  }
  function action(container, label, onClick, kind = '') {
    const button = makeElement('button', 'part-panel-action ' + kind, label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    container.appendChild(button);
    return button;
  }

  // ---------- Contents ----------
  const tonnes = (kilograms) => (kilograms / 1000).toFixed(kilograms < 1000 ? 3 : 2) + ' t';
  PartPanel.build = (panel) => {
    const part = panel.part;
    const partType = part.type;
    const container = panel.element;
    container.innerHTML = '';
    const head = makeElement('div', 'part-panel-head');
    head.appendChild(makeElement('h3', '', partType.name));
    const pinButton = makeElement('button', 'part-panel-pin', '📌');
    pinButton.type = 'button';
    pinButton.title = 'Pin: keep this open when another part is selected';
    pinButton.setAttribute('aria-label', 'Pin');
    pinButton.setAttribute('aria-pressed', String(panel.pinned));
    pinButton.addEventListener('click', () => {
      panel.pinned = !panel.pinned;
      pinButton.setAttribute('aria-pressed', String(panel.pinned));
      container.classList.toggle('pinned', panel.pinned);
    });
    const closeButton = makeElement('button', 'part-panel-close', '×');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close');
    closeButton.addEventListener('click', () => PartPanel.close(panel));
    head.append(pinButton, closeButton);
    container.appendChild(head);
    container.classList.toggle('pinned', panel.pinned);
    makeDraggable(panel, head);
    panel.live = null;
    if (panel.screen === 'flight') {
      buildFlight(panel, container);
    } else {
      buildEditor(panel, container);
    }
  };

  function buildEditor(panel, container) {
    const part = panel.part;
    const partType = part.type;
    const rebuild = () => {
      if (panels.includes(panel)) {
        PartPanel.build(panel);
      }
    };
    const info = makeElement(
      'p',
      'part-panel-subtitle',
      `${tonnes(Flatspace.partMass(part))}${part.fuelCapacity ? ` · ${tonnes(part.fuel)} of ${tonnes(part.fuelCapacity)} fuel` : ''}`,
    );
    container.appendChild(info);
    if (Flatspace.Build.twinOf(hangarEditor.parts, part)) {
      container.appendChild(makeElement('p', 'part-panel-note', 'Changes apply to its mirror twin too.'));
    }
    // a floating part: launch it with the craft, or leave it behind
    let root = part;
    while (root.parent) {
      root = root.parent;
    }
    if (root !== hangarEditor.parts[0]) {
      container.appendChild(makeElement('p', 'part-panel-note', 'Floating: not attached to the craft.'));
      choices(
        container,
        'At launch',
        [
          ['keep', 'Launch with the craft'],
          ['drop', 'Leave behind'],
        ],
        root.loose || 'drop',
        (value) => {
          root.loose = value;
          hangarEditor.changed();
          rebuild();
        },
      );
    }
    if (partType.stretch) {
      const max = Flatspace.MAX_TANK_LENGTH;
      const lengthSlider = slider(
        container,
        'Length',
        Flatspace.LENGTH_STEP,
        max,
        Flatspace.LENGTH_STEP,
        part.length,
        (value) => `${(+value).toFixed(2)} m`,
        (value) => {
          hangarEditor.setLength(part, value, false);
          return part.length;
        },
        () => {
          hangarEditor.changed();
          rebuild();
        },
      );
      const step = makeElement('div', 'part-panel-steps');
      for (const [label, change] of [
        ['−0.25', -Flatspace.LENGTH_STEP],
        ['+0.25', Flatspace.LENGTH_STEP],
        ['−1', -1],
        ['+1', 1],
      ]) {
        const button = makeElement('button', 'part-panel-choice', label);
        button.type = 'button';
        button.setAttribute('aria-label', `${change > 0 ? 'Lengthen' : 'Shorten'} by ${Math.abs(change)} m`);
        button.addEventListener('click', () => {
          hangarEditor.setLength(part, Flatspace.clamp(part.length + change, Flatspace.LENGTH_STEP, max));
          lengthSlider.value = part.length;
          rebuild();
        });
        step.appendChild(button);
      }
      container.appendChild(step);
      choices(
        container,
        'Width',
        Flatspace.TANK_WIDTHS.map((width) => [width, width + ' m']),
        part.size,
        (width) => {
          hangarEditor.setWidth(part, width);
          rebuild();
        },
      );
      choices(
        container,
        'Look',
        Flatspace.TANK_SKINS.map((skinName) => [skinName, SKIN_NAMES[skinName], 'skin skin-' + skinName]),
        part.skin,
        (skinName) => {
          hangarEditor.setSetting(part, 'skin', skinName);
          rebuild();
        },
      );
    }
    if (partType.fuel) {
      slider(
        container,
        'Fuel at launch',
        0,
        100,
        5,
        Math.round(part.fill * 100),
        (value) => `${value}%`,
        (value) => {
          hangarEditor.setSetting(part, 'fill', value / 100, false);
          info.textContent = `${tonnes(Flatspace.partMass(part))} · ${tonnes(part.fuel)} of ${tonnes(part.fuelCapacity)} fuel`;
        },
        (value) => hangarEditor.setSetting(part, 'fill', value / 100),
      );
    }
    engineSliders(container, part, (setting, value, record) =>
      hangarEditor.setSetting(part, setting, value, record),
    );
    if (partType.decoupler) {
      toggle(
        container,
        'Crossfeed: fuel flows across it',
        part.crossfeed,
        (isOn) => {
          hangarEditor.setSetting(part, 'crossfeed', isOn);
          rebuild();
        },
        'With crossfeed on, engines on one side can drink from tanks on the other until it fires.',
      );
    }
    if (partType.chute) {
      chuteSlider(container, part, (value, record) =>
        hangarEditor.setSetting(part, 'chuteAltitude', value, record),
      );
    }
    if (Flatspace.stageable(part) && root === hangarEditor.parts[0]) {
      const staged = !(typeof part.stage === 'number' && part.stage < 0);
      toggle(
        container,
        'Fires in staging',
        staged,
        (isOn) => {
          Flatspace.StagingEditor.setStaged(part, isOn);
          rebuild();
        },
        'Turn off to leave this part out of the stage list.',
      );
    }
    if (!container.querySelector('input, .part-panel-choice, .part-panel-toggle')) {
      container.appendChild(makeElement('p', 'part-panel-note', 'This part has no settings.'));
    }
  }

  function engineSliders(container, part, set) {
    const engine = part.type.engine;
    if (!engine) {
      return;
    }
    slider(
      container,
      'Thrust limit',
      0,
      100,
      5,
      Math.round(part.limit * 100),
      (value) => `${value}% · ${((engine.vacuumThrust * value) / 100000).toFixed(0)} kN`,
      (value) => {
        set('limit', value / 100, false);
      },
      (value) => set('limit', value / 100, true),
    );
    if (engine.gimbal) {
      slider(
        container,
        'Gimbal range',
        0,
        100,
        5,
        Math.round(part.gimbal * 100),
        (value) => `${value}% · ±${((engine.gimbal * value) / 100).toFixed(1)}°`,
        (value) => {
          set('gimbal', value / 100, false);
        },
        (value) => set('gimbal', value / 100, true),
      );
    }
  }
  function chuteSlider(container, part, set) {
    slider(
      container,
      'Opens fully at',
      100,
      3000,
      50,
      part.chuteAltitude,
      (value) => `${value} m above ground`,
      (value) => {
        set(value, false);
      },
      (value) => set(value, true),
    );
  }

  // In flight: live readouts, the settings that can still change, and actions.
  function buildFlight(panel, container) {
    const part = panel.part;
    const partType = part.type;
    const game = Flatspace.game;
    const vessel = () => game.vessel;
    const status = makeElement('p', 'part-panel-subtitle', '');
    container.appendChild(status);
    const set = (setting, value) => {
      part[setting] = value;
    };
    panel.live = () => {
      const bits = [tonnes(Flatspace.partMass(part))];
      if (part.fuelCapacity) {
        bits.push(`${tonnes(part.fuel)} of ${tonnes(part.fuelCapacity)} fuel`);
      }
      if (partType.engine) {
        bits.push(
          partType.engine.solid
            ? part.lit
              ? part.solid > 0
                ? 'burning'
                : 'burnt out'
              : 'not lit'
            : part.lit
              ? 'running'
              : 'off',
        );
      }
      if (partType.chute) {
        bits.push(
          { stowed: 'packed', armed: 'armed', halfOpen: 'half open', full: 'open' }[part.chute] || '',
        );
      }
      const summary = bits.join(' · ');
      if (status.textContent !== summary) {
        status.textContent = summary;
      }
    };
    panel.live();
    engineSliders(container, part, (setting, value) => set(setting, value));
    if (partType.engine) {
      if (partType.engine.solid) {
        if (!part.lit) {
          action(
            container,
            'Ignite',
            () => {
              vessel().act(part, 'ignite', game);
              PartPanel.build(panel);
            },
            'go',
          );
        }
      } else {
        action(
          container,
          part.lit ? 'Shut down' : 'Activate engine',
          () => {
            vessel().act(part, part.lit ? 'shutdown' : 'ignite', game);
            PartPanel.build(panel);
          },
          part.lit ? '' : 'go',
        );
      }
    }
    if (partType.decoupler) {
      toggle(container, 'Crossfeed: fuel flows across it', part.crossfeed, (isOn) => {
        part.crossfeed = isOn;
        PartPanel.build(panel);
      });
      action(
        container,
        'Decouple',
        () => {
          vessel().act(part, 'decouple', game);
          PartPanel.close(panel);
        },
        'warn',
      );
    }
    if (partType.chute) {
      chuteSlider(container, part, (value) => set('chuteAltitude', value));
      if (part.chute === 'stowed') {
        action(
          container,
          'Deploy (opens when it is safe)',
          () => {
            vessel().act(part, 'deploy', game);
            PartPanel.build(panel);
          },
          'go',
        );
      }
    }
  }

  // ---------- Craft files ----------
  // Export and import craft as files, or as text to paste into a chat or a forum post.
  const CraftFiles = (Flatspace.CraftFiles = {});
  const showMessage = (text, bad) => {
    const messageElement = byId('craftFilesMessage');
    messageElement.textContent = text;
    messageElement.classList.toggle('bad', !!bad);
  };

  CraftFiles.open = () => {
    const hangarEditor = Flatspace.Editor;
    byId('craftFilesText').value = '';
    showMessage(`“${hangarEditor.name}”, ${hangarEditor.parts.length} parts.`);
    byId('craftFiles').hidden = false;
    byId('craftFilesDownload').focus();
  };
  CraftFiles.close = () => {
    byId('craftFiles').hidden = true;
  };

  CraftFiles.initialise = () => {
    const hangarEditor = Flatspace.Editor;
    byId('craftFilesClose').addEventListener('click', CraftFiles.close);
    byId('craftFiles').addEventListener('click', (event) => {
      if (event.target.id === 'craftFiles') {
        CraftFiles.close();
      }
    });
    byId('craftFiles').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        CraftFiles.close();
      }
    });
    byId('craftFilesDownload').addEventListener('click', () => {
      const json = Flatspace.craftToJSON(hangarEditor.name, hangarEditor.parts);
      try {
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = (hangarEditor.name.replace(/[^\w\- ]+/g, '').trim() || 'craft') + '.craft.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showMessage(`Downloaded ${link.download}.`);
      } catch (error) {
        showMessage('Your browser could not create the file. Use "Copy as text" instead.', true);
      }
    });
    byId('craftFilesOpen').addEventListener('click', () => byId('craftFilesFile').click());
    byId('craftFilesFile').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) {
        return;
      }
      const reader = new FileReader();
      reader.onload = () => CraftFiles.importText(String(reader.result));
      reader.onerror = () => showMessage('Could not read that file.', true);
      reader.readAsText(file);
      event.target.value = '';
    });
    byId('craftFilesCopy').addEventListener('click', () => {
      const text = Flatspace.craftToText(hangarEditor.name, hangarEditor.parts);
      byId('craftFilesText').value = text;
      byId('craftFilesText').select();
      const done = () =>
        showMessage('Copied. Paste it anywhere; anyone can load it with "Load pasted text".');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(text)
          .then(done, () => showMessage('Select the text below and copy it.'));
      } else {
        showMessage('Select the text below and copy it.');
      }
    });
    byId('craftFilesPaste').addEventListener('click', () => {
      const text = byId('craftFilesText').value.trim();
      if (!text) {
        showMessage('Paste craft text into the box first.', true);
        byId('craftFilesText').focus();
        return;
      }
      CraftFiles.importText(text);
    });
  };

  // Load a craft from file or pasted text into the hangar.
  CraftFiles.importText = (text) => {
    const result = Flatspace.craftFromText(text);
    if (result.error) {
      showMessage(result.error, true);
      return false;
    }
    const parts = Flatspace.partsFromSerial(result.parts);
    if (!parts.length) {
      showMessage('That craft has no parts this version of the game knows.', true);
      return false;
    }
    Flatspace.Editor.load(result.name, parts);
    showMessage(
      `Loaded “${result.name}”${result.skipped ? `, without ${result.skipped} unknown part${result.skipped > 1 ? 's' : ''}` : ''}.`,
    );
    Flatspace.Editor.say(`Loaded “${result.name}” from a craft file.`);
    setTimeout(CraftFiles.close, 700);
    return true;
  };
})();
