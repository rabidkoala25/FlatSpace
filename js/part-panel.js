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
  const PartPanel = (FS.PartPanel = {});
  const byId = (elementId) => document.getElementById(elementId);
  const SKIN_NAMES = {
    white: 'White',
    gold: 'Gold foil',
    foam: 'Orange foam',
    roll: 'Roll pattern',
    steel: 'Bare steel',
  };
  const panels = []; // { part, ctx: 'editor' | 'flight', el, pinned, off: {x, y} | null }
  let hangarEditor = null;
  const host = (screen) => (screen === 'editor' ? document.querySelector('#editor .hangar') : byId('flight'));

  PartPanel.init = (editor) => {
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
      if (panel.ctx === screen && !panel.pinned && panel.part !== part) {
        PartPanel.close(panel);
      }
    }
    if (!part) {
      return;
    }
    const have = panels.find((panel) => panel.ctx === screen && panel.part === part);
    if (have) {
      have.el.classList.add('flash');
      setTimeout(() => have.el.classList.remove('flash'), 300);
      return;
    }
    const panel = { part, ctx: screen, el: makeElement('div', 'part-panel'), pinned: false, off: null };
    panel.el.setAttribute('role', 'dialog');
    panel.el.setAttribute('aria-label', `${part.def.name} settings`);
    panel.el.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        PartPanel.close(panel);
        event.stopPropagation();
      }
    });
    host(screen).appendChild(panel.el);
    panels.push(panel);
    PartPanel.build(panel);
  };
  PartPanel.open = (part, screen = 'editor') => PartPanel.select(part, screen);
  PartPanel.close = (panel) => {
    const panelIndex = panels.indexOf(panel);
    if (panelIndex >= 0) {
      panels.splice(panelIndex, 1);
    }
    panel.el.remove();
    const line = lineFor(panel.ctx, false);
    if (line) {
      line.innerHTML = '';
    }
  };
  PartPanel.closeAll = (screen) => {
    for (const panel of panels.slice()) {
      if (!screen || panel.ctx === screen) {
        PartPanel.close(panel);
      }
    }
  };
  PartPanel.isOpen = (screen = 'editor') => panels.some((panel) => panel.ctx === screen);
  PartPanel.panels = (screen) => panels.filter((panel) => !screen || panel.ctx === screen);
  // Rebuild every pop-up (after undo, load, or a change elsewhere); close those whose part is gone.
  PartPanel.rebuildAll = (screen, alive) => {
    for (const panel of panels.slice()) {
      if (panel.ctx !== screen) {
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
    let lineLayer = hostElement.querySelector(':scope > svg.pp-lines');
    if (!lineLayer && make) {
      lineLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      lineLayer.setAttribute('class', 'pp-lines');
      lineLayer.setAttribute('aria-hidden', 'true');
      hostElement.appendChild(lineLayer);
    }
    return lineLayer;
  }

  // Called every redraw: where = (part) => its point on screen, in the host's pixels, or
  // null if it can't be shown. hidden hides every pop-up of ctx (while dragging a part).
  PartPanel.layout = (screen, where, hidden = false) => {
    const hostElement = host(screen);
    if (!hostElement) {
      return;
    }
    const hostWidth = hostElement.clientWidth;
    const hostHeight = hostElement.clientHeight;
    const lineLayer = lineFor(
      screen,
      panels.some((panel) => panel.ctx === screen),
    );
    let lines = '';
    for (const panel of panels) {
      if (panel.ctx !== screen) {
        continue;
      }
      const anchor = hidden ? null : where(panel.part);
      panel.el.hidden = !anchor;
      if (!anchor) {
        continue;
      }
      if (panel.live) {
        panel.live();
      }
      const panelWidth = panel.el.offsetWidth || 270;
      const panelHeight = panel.el.offsetHeight || 200;
      if (!panel.off) {
        panel.off = {
          x: anchor.x + 60 + panelWidth < hostWidth ? 60 : -60 - panelWidth,
          y: -panelHeight / 2,
        };
      }
      const panelX = FS.clamp(anchor.x + panel.off.x, 4, Math.max(4, hostWidth - panelWidth - 4));
      const panelY = FS.clamp(anchor.y + panel.off.y, 4, Math.max(4, hostHeight - panelHeight - 4));
      panel.el.style.left = panelX + 'px';
      panel.el.style.top = panelY + 'px';
      // the line meets the pop-up's nearest edge
      const lineEndX = FS.clamp(anchor.x, panelX, panelX + panelWidth);
      const lineEndY = FS.clamp(anchor.y, panelY, panelY + panelHeight);
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
      const start = { x: event.clientX, y: event.clientY, ox: panel.off.x, oy: panel.off.y };
      try {
        handle.setPointerCapture(event.pointerId);
      } catch (error) {
        /* old browsers */
      }
      const move = (moveEvent) => {
        if (moveEvent.pointerId !== event.pointerId) {
          return;
        }
        panel.off = { x: start.ox + moveEvent.clientX - start.x, y: start.oy + moveEvent.clientY - start.y };
        if (panel.ctx === 'editor') {
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
    const row = makeElement('label', 'pp-row');
    const top = makeElement('span', 'pp-label');
    const out = makeElement('output', 'pp-val', format(value));
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
    const wrap = makeElement('div', 'pp-row');
    wrap.appendChild(makeElement('span', 'pp-label', label));
    const group = makeElement('div', 'pp-choices');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    for (const [value, text, extra] of list) {
      const button = makeElement('button', 'pp-choice' + (extra ? ' ' + extra : ''), text);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(value === current));
      button.addEventListener('click', () => onPick(value));
      group.appendChild(button);
    }
    wrap.appendChild(group);
    container.appendChild(wrap);
  }
  function toggle(container, label, isOn, onSet, hint) {
    const button = makeElement('button', 'pp-toggle');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(!!isOn));
    button.append(makeElement('span', 'pp-switch'), makeElement('span', '', label));
    if (hint) {
      button.title = hint;
    }
    button.addEventListener('click', () => onSet(!isOn));
    container.appendChild(button);
  }
  function action(container, label, onClick, kind = '') {
    const button = makeElement('button', 'pp-action ' + kind, label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    container.appendChild(button);
    return button;
  }

  // ---------- Contents ----------
  const tonnes = (kilograms) => (kilograms / 1000).toFixed(kilograms < 1000 ? 3 : 2) + ' t';
  PartPanel.build = (panel) => {
    const part = panel.part;
    const partType = part.def;
    const container = panel.el;
    container.innerHTML = '';
    const head = makeElement('div', 'pp-head');
    head.appendChild(makeElement('h3', '', partType.name));
    const pinButton = makeElement('button', 'pp-pin', '📌');
    pinButton.type = 'button';
    pinButton.title = 'Pin: keep this open when another part is selected';
    pinButton.setAttribute('aria-label', 'Pin');
    pinButton.setAttribute('aria-pressed', String(panel.pinned));
    pinButton.addEventListener('click', () => {
      panel.pinned = !panel.pinned;
      pinButton.setAttribute('aria-pressed', String(panel.pinned));
      container.classList.toggle('pinned', panel.pinned);
    });
    const closeButton = makeElement('button', 'pp-close', '×');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close');
    closeButton.addEventListener('click', () => PartPanel.close(panel));
    head.append(pinButton, closeButton);
    container.appendChild(head);
    container.classList.toggle('pinned', panel.pinned);
    makeDraggable(panel, head);
    panel.live = null;
    if (panel.ctx === 'flight') {
      buildFlight(panel, container);
    } else {
      buildEditor(panel, container);
    }
  };

  function buildEditor(panel, container) {
    const part = panel.part;
    const partType = part.def;
    const rebuild = () => {
      if (panels.includes(panel)) {
        PartPanel.build(panel);
      }
    };
    const info = makeElement(
      'p',
      'pp-sub',
      `${tonnes(FS.partMass(part))}${part.cap ? ` · ${tonnes(part.fuel)} of ${tonnes(part.cap)} fuel` : ''}`,
    );
    container.appendChild(info);
    if (FS.Build.twinOf(hangarEditor.parts, part)) {
      container.appendChild(makeElement('p', 'pp-note', 'Changes apply to its mirror twin too.'));
    }
    // a floating part: launch it with the craft, or leave it behind
    let root = part;
    while (root.parent) {
      root = root.parent;
    }
    if (root !== hangarEditor.parts[0]) {
      container.appendChild(makeElement('p', 'pp-note', 'Floating: not attached to the craft.'));
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
      const max = FS.MAX_TANK_LEN;
      const lenRange = slider(
        container,
        'Length',
        FS.LEN_STEP,
        max,
        FS.LEN_STEP,
        part.len,
        (value) => `${(+value).toFixed(2)} m`,
        (value) => {
          hangarEditor.setLength(part, value, false);
          return part.len;
        },
        () => {
          hangarEditor.changed();
          rebuild();
        },
      );
      const step = makeElement('div', 'pp-steps');
      for (const [label, change] of [
        ['−0.25', -FS.LEN_STEP],
        ['+0.25', FS.LEN_STEP],
        ['−1', -1],
        ['+1', 1],
      ]) {
        const button = makeElement('button', 'pp-choice', label);
        button.type = 'button';
        button.setAttribute('aria-label', `${change > 0 ? 'Lengthen' : 'Shorten'} by ${Math.abs(change)} m`);
        button.addEventListener('click', () => {
          hangarEditor.setLength(part, FS.clamp(part.len + change, FS.LEN_STEP, max));
          lenRange.value = part.len;
          rebuild();
        });
        step.appendChild(button);
      }
      container.appendChild(step);
      choices(
        container,
        'Width',
        FS.TANK_WIDTHS.map((width) => [width, width + ' m']),
        part.size,
        (width) => {
          hangarEditor.setWidth(part, width);
          rebuild();
        },
      );
      choices(
        container,
        'Look',
        FS.TANK_SKINS.map((skinName) => [skinName, SKIN_NAMES[skinName], 'skin skin-' + skinName]),
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
          info.textContent = `${tonnes(FS.partMass(part))} · ${tonnes(part.fuel)} of ${tonnes(part.cap)} fuel`;
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
        hangarEditor.setSetting(part, 'chuteAlt', value, record),
      );
    }
    if (FS.stageable(part) && root === hangarEditor.parts[0]) {
      const staged = !(typeof part.stage === 'number' && part.stage < 0);
      toggle(
        container,
        'Fires in staging',
        staged,
        (isOn) => {
          FS.StagingEditor.setStaged(part, isOn);
          rebuild();
        },
        'Turn off to leave this part out of the stage list.',
      );
    }
    if (!container.querySelector('input, .pp-choice, .pp-toggle')) {
      container.appendChild(makeElement('p', 'pp-note', 'This part has no settings.'));
    }
  }

  function engineSliders(container, part, set) {
    const engine = part.def.engine;
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
      (value) => `${value}% · ${((engine.vac * value) / 100000).toFixed(0)} kN`,
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
      part.chuteAlt,
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
    const partType = part.def;
    const game = FS.game;
    const vessel = () => game.vessel;
    const status = makeElement('p', 'pp-sub', '');
    container.appendChild(status);
    const set = (setting, value) => {
      part[setting] = value;
    };
    panel.live = () => {
      const bits = [tonnes(FS.partMass(part))];
      if (part.cap) {
        bits.push(`${tonnes(part.fuel)} of ${tonnes(part.cap)} fuel`);
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
        bits.push({ stowed: 'packed', armed: 'armed', semi: 'half open', full: 'open' }[part.chute] || '');
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
      chuteSlider(container, part, (value) => set('chuteAlt', value));
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
  const CraftFiles = (FS.CraftFiles = {});
  const showMessage = (text, bad) => {
    const messageElement = byId('cfMsg');
    messageElement.textContent = text;
    messageElement.classList.toggle('bad', !!bad);
  };

  CraftFiles.open = () => {
    const hangarEditor = FS.Editor;
    byId('cfText').value = '';
    showMessage(`“${hangarEditor.name}”, ${hangarEditor.parts.length} parts.`);
    byId('craftFiles').hidden = false;
    byId('cfDownload').focus();
  };
  CraftFiles.close = () => {
    byId('craftFiles').hidden = true;
  };

  CraftFiles.init = () => {
    const hangarEditor = FS.Editor;
    byId('cfClose').addEventListener('click', CraftFiles.close);
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
    byId('cfDownload').addEventListener('click', () => {
      const json = FS.craftToJSON(hangarEditor.name, hangarEditor.parts);
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
    byId('cfOpen').addEventListener('click', () => byId('cfFile').click());
    byId('cfFile').addEventListener('change', (event) => {
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
    byId('cfCopy').addEventListener('click', () => {
      const text = FS.craftToText(hangarEditor.name, hangarEditor.parts);
      byId('cfText').value = text;
      byId('cfText').select();
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
    byId('cfPaste').addEventListener('click', () => {
      const text = byId('cfText').value.trim();
      if (!text) {
        showMessage('Paste craft text into the box first.', true);
        byId('cfText').focus();
        return;
      }
      CraftFiles.importText(text);
    });
  };

  // Load a craft from file or pasted text into the hangar.
  CraftFiles.importText = (text) => {
    const result = FS.craftFromText(text);
    if (result.error) {
      showMessage(result.error, true);
      return false;
    }
    const parts = FS.partsFromSerial(result.parts);
    if (!parts.length) {
      showMessage('That craft has no parts this version of the game knows.', true);
      return false;
    }
    FS.Editor.load(result.name, parts);
    showMessage(
      `Loaded “${result.name}”${result.skipped ? `, without ${result.skipped} unknown part${result.skipped > 1 ? 's' : ''}` : ''}.`,
    );
    FS.Editor.say(`Loaded “${result.name}” from a craft file.`);
    setTimeout(CraftFiles.close, 700);
    return true;
  };
})();
