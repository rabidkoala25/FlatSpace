// main.js — the page around the simulation: scenes, messages and dialogs, milestones,
// the map camera, and the frame loop that ties sim, renderer and HUD together.
// The simulation itself lives in sim.js, warp.js and nodes.js; controls in input.js.
(function () {
  const Vector = FS.vec;
  const byId = (elementId) => document.getElementById(elementId);
  const game = FS.game;
  const ui = (FS.UI = {});

  game.milestones = new Set(FS.store.load('flatspace.milestones', []));

  // ---------- Scenes ----------
  game.showScene = (name) => {
    game.scene = name;
    FS.PartPanel.closeAll('flight');
    byId('editor').hidden = name !== 'editor';
    byId('flight').hidden = name !== 'flight';
    byId('help').hidden = true;
    ui.hideDialog();
    requestAnimationFrame(() => {
      FS.Renderer.resize();
      FS.Editor.resize();
    });
  };

  game.launch = (craft) => {
    const vessel = game.newFlight(craft);
    game.mapFocus = 'vessel';
    game.showScene('flight');
    ui.setMapMode(false);
    const position = Vector.add(FS.bodyAbs(vessel.body, game.t), vessel.r);
    game.cam.x = position.x;
    game.cam.y = position.y;
    game.cam.rot = Vector.angle(vessel.r) - Math.PI / 2;
    toast('Press Space to ignite the first stage.', '', 5000);
    if (!vessel.hasCommand) {
      toast('This craft has no command part, so it cannot steer.', 'bad', 5000);
    }
  };

  game.revert = () => {
    game.t = game.launchT;
    game.launch(game.craft);
  };

  game.toHangar = () => {
    game.vessel = null;
    game.showScene('editor');
    FS.Editor.changed();
  };

  // ---------- What the player is told about simulation events ----------
  game.on('message', ({ text, kind, ms: duration }) => toast(text, kind, duration));

  game.on('staged', ({ vessel, event }) => {
    if (vessel !== game.vessel) {
      return;
    }
    toast(
      'Stage ' +
        vessel.stageIdx +
        (event.decouple ? ': separation' : event.chutes ? ': parachutes armed' : ': ignition'),
      '',
      1500,
    );
  });

  game.on('part-action', ({ vessel, part, action }) => {
    if (vessel !== game.vessel) {
      return;
    }
    const what = { decouple: 'separated', ignite: 'lit', shutdown: 'shut down', deploy: 'armed' }[action];
    toast(`${part.def.name} ${what}.`, '', 1500);
  });

  game.on('exploded', ({ vessel }) => {
    if (vessel !== game.vessel) {
      return;
    }
    toast('Vessel destroyed.', 'bad', 4000);
    setTimeout(() => {
      if (game.vessel !== vessel) {
        return;
      }
      ui.showDialog('Vessel destroyed', flightSummary(vessel, 'The craft hit the ground too hard.'), [
        ['Revert to launch', game.revert, 'primary'],
        ['Back to hangar', game.toHangar, 'ghost'],
      ]);
    }, 1600);
  });

  game.on('touchdown', ({ vessel, water }) => {
    if (vessel !== game.vessel || !vessel.stats.launched) {
      return;
    }
    const body = vessel.body;
    toast((water ? 'Splashdown on ' : 'Touchdown on ') + body.name + '.', '', 3500);
    vessel.landings.push(body.name);
    if (body !== FS.root) {
      milestone('land-' + body.name, 'First landing on ' + body.name + '!');
    } else if (vessel.visited.size) {
      milestone('return', 'Returned home from ' + [...vessel.visited].join(' and ') + '!');
    }
  });

  game.on('soi', ({ vessel, from }) => {
    if (vessel !== game.vessel) {
      return;
    }
    const body = vessel.body;
    if (body !== FS.root) {
      vessel.visited.add(body.name);
      toast('Entering the sphere of influence of ' + body.name + '.', '', 3500);
      milestone('soi-' + body.name, 'First encounter with ' + body.name + '!');
    } else {
      toast('Leaving ' + from.name + '.', '', 3000);
    }
  });

  function milestone(key, text) {
    if (game.milestones.has(key)) {
      return;
    }
    game.milestones.add(key);
    FS.store.save('flatspace.milestones', [...game.milestones]);
    toast('Milestone: ' + text, 'milestone', 5000);
  }

  function checkMilestones(vessel) {
    if (vessel.dead || !vessel.stats.launched) {
      return;
    }
    const body = vessel.body;
    if (!vessel.landed && body === FS.root && vessel.altitude > 200) {
      milestone('launch', 'First launch!');
    }
    if (body === FS.root && vessel.altitude > body.atmo.height) {
      milestone('space', 'Reached space!');
    }
    if (vessel.situation().startsWith('Orbiting')) {
      milestone('orbit-' + body.name, 'First orbit of ' + body.name + '!');
    }
  }

  // ---------- Toasts & dialogs ----------
  function toast(message, className = '', duration = 3000) {
    const host = byId('toasts');
    const toastElement = document.createElement('div');
    toastElement.className = 'toast ' + className;
    toastElement.textContent = message;
    host.appendChild(toastElement);
    while (host.children.length > 4) {
      host.removeChild(host.firstChild);
    }
    setTimeout(() => toastElement.remove(), duration);
  }
  game.toast = toast;

  ui.showDialog = (title, bodyHtml, actions) => {
    byId('dlgTitle').textContent = title;
    byId('dlgBody').innerHTML = bodyHtml;
    const host = byId('dlgActions');
    host.innerHTML = '';
    for (const [label, action, className] of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn ' + (className || 'ghost');
      button.textContent = label;
      button.addEventListener('click', () => {
        ui.hideDialog();
        action();
      });
      host.appendChild(button);
    }
    byId('dialog').hidden = false;
    game.paused = true;
    const first = host.querySelector('button');
    if (first) {
      first.focus();
    }
  };
  ui.hideDialog = () => {
    byId('dialog').hidden = true;
    game.paused = false;
  };

  function flightSummary(vessel, intro) {
    const rows = [
      ['Craft', vessel.name],
      ['Flight time', FS.fmtTime(game.t - game.launchT)],
      ['Highest altitude', FS.fmtDist(vessel.stats.maxAlt)],
      ['Top speed', FS.fmtSpeed(vessel.stats.maxSpeed)],
      ['Bodies visited', vessel.visited.size ? [...vessel.visited].join(', ') : 'Aster only'],
      ['Landings', vessel.landings.length ? vessel.landings.join(', ') : 'none'],
    ];
    return `<p>${intro}</p><dl class="fdata">${rows.map(([label, value]) => `<dt>${label}</dt><dd>${String(value).replace(/</g, '&lt;')}</dd>`).join('')}</dl>`;
  }

  ui.recover = () => {
    ui.showDialog('Vessel recovered', flightSummary(game.vessel, 'The crew is home safe.'), [
      ['Back to hangar', game.toHangar, 'primary'],
    ]);
  };

  const PIXEL_SIZES = [
    [1.5, 'Fine'],
    [2, 'Medium'],
    [3, 'Chunky'],
  ];
  ui.menu = () => {
    const usingWebGL = FS.Renderer === FS.RenderGL;
    const pixelSizeSetting = usingWebGL
      ? `<div class="menu-row"><span>Pixel size</span><div class="pp-choices" role="group" aria-label="Pixel size">${PIXEL_SIZES.map(([size, label]) => `<button type="button" class="pp-choice" data-px="${size}" aria-pressed="${game.settings.pixelSize === size}">${label}</button>`).join('')}</div></div>`
      : '<p class="menu-note">Simple drawing mode: this browser has no WebGL2.</p>';
    ui.showDialog(
      'Flight menu',
      '<p>Time is paused. Flatspace Program v' + FS.VERSION + '</p>' + pixelSizeSetting,
      [
        ['Resume', () => {}, 'primary'],
        ['Revert to launch', game.revert, 'ghost'],
        ['Back to hangar', game.toHangar, 'ghost'],
        ['Controls', () => (byId('help').hidden = false), 'ghost'],
      ],
    );
    for (const button of byId('dlgBody').querySelectorAll('[data-px]')) {
      button.addEventListener('click', () => {
        game.settings.pixelSize = +button.dataset.px;
        FS.RenderGL.setPixelSize(game.settings.pixelSize);
        ui.saveSettings();
        for (const option of byId('dlgBody').querySelectorAll('[data-px]')) {
          option.setAttribute('aria-pressed', String(option === button));
        }
      });
    }
  };

  // ---------- Map ----------
  ui.setMapMode = (showMap) => {
    game.mapMode = showMap;
    byId('mapHint').hidden = !showMap;
    if (showMap) {
      fitMap();
    }
  };
  function focusPos() {
    if (game.mapFocus === 'vessel') {
      return Vector.add(FS.bodyAbs(game.vessel.body, game.t), game.vessel.r);
    }
    return FS.bodyAbs(game.mapFocus, game.t);
  }
  function fitMap() {
    const { W: viewWidth, H: viewHeight } = FS.Renderer.size();
    const margin = Math.min(viewWidth, viewHeight) * 0.42;
    let span;
    if (game.mapFocus === 'vessel') {
      const vessel = game.vessel;
      const body = vessel.body;
      const orbit = FS.orbitFromState(vessel.r, vessel.v, body.mu, game.t);
      span =
        orbit.e < 1 && orbit.ap < (isFinite(body.soi) ? body.soi : 1e12)
          ? orbit.ap * 1.1
          : Math.max(Vector.len(vessel.r) * 2.5, body.R * 3);
      if (body === FS.root && span > 6e7) {
        span = 6e7;
      }
      span = Math.max(span, body.R * 1.6);
    } else {
      const body = game.mapFocus;
      span = body === FS.root ? body.R * 4 : body.R * 5;
    }
    game.mapCam.s = margin / span;
    game.mapPan = { x: 0, y: 0 };
  }
  ui.cycleFocus = () => {
    const list = ['vessel', ...FS.bodies];
    const focusIndex = list.indexOf(game.mapFocus);
    game.mapFocus = list[(focusIndex + 1) % list.length];
    fitMap();
  };

  // Click near any part of the predicted path to add a maneuver node there.
  ui.mapClick = (screenX, screenY) => {
    if (!game.patches || game.vessel.landed) {
      return;
    }
    let best = null;
    let bestDistance = 18;
    game.patches.forEach((patch, patchIndex) => {
      const from = Math.max(patch.tStart, game.t);
      const origin = FS.bodyAbs(patch.body, patchIndex === 0 ? game.t : patch.tStart);
      for (const sample of FS.sampleOrbit(patch.orbit, from, patch.tEnd, 500)) {
        const screenPoint = FS.Renderer.worldToScreen(game.mapCam, origin.x + sample.x, origin.y + sample.y);
        const distance = Math.hypot(screenPoint.x - screenX, screenPoint.y - screenY);
        if (distance < bestDistance && sample.t > game.t + 2) {
          bestDistance = distance;
          best = sample;
        }
      }
    });
    if (best && game.createNode(best.t)) {
      toast('Node added. Use the panel to set the burn.', '', 2500);
    }
  };

  // ---------- Developer overlay (F3) ----------
  // Shows frame time, physics steps per frame and particle count, to watch performance.
  let devTimer = 0;
  let devFrames = 0;
  let devTime = 0;
  function updateDevOverlay(timeStep) {
    const overlay = byId('devOverlay');
    devFrames++;
    devTime += timeStep;
    devTimer -= timeStep;
    if (overlay.hidden || devTimer > 0) {
      return;
    }
    devTimer = 0.25;
    const frameMs = (devTime / Math.max(1, devFrames)) * 1000;
    devFrames = 0;
    devTime = 0;
    const steps = game.frame.steps;
    overlay.textContent =
      'v' +
      FS.VERSION +
      '\n' +
      'frame      ' +
      frameMs.toFixed(1) +
      ' ms (' +
      (1000 / frameMs).toFixed(0) +
      ' fps)\n' +
      'physics    ' +
      steps +
      (typeof steps === 'number' ? ' steps/frame' : '') +
      '\n' +
      'particles  ' +
      FS.Renderer.stats().particles +
      '\n' +
      (FS.Renderer === FS.RenderGL
        ? 'renderer   WebGL2, ' +
          FS.Renderer.stats().draws +
          ' sprite draws, atlas ' +
          FS.Renderer.stats().atlas +
          '\n' +
          'pixel      ' +
          16 / Math.pow(2, FS.Renderer.stats().level) +
          ' per metre\n'
        : 'renderer   Canvas 2D\n') +
      'debris     ' +
      game.debris.length;
  }

  // ---------- Frame loop ----------
  let last = performance.now();
  function frame(now) {
    const timeStep = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (game.scene === 'flight' && game.vessel) {
      if (!game.paused) {
        FS.Input.apply(timeStep);
        game.update(timeStep);
        FS.Renderer.update(game);
        checkMilestones(game.vessel);
      }
      updateCamera(timeStep);
      if (game.mapMode) {
        FS.Renderer.drawMap(game);
      } else {
        FS.Renderer.drawFlight(game);
      }
      // part pop-ups follow their parts; parts that left the craft close theirs
      for (const panel of FS.PartPanel.panels('flight')) {
        if (!game.vessel.parts.includes(panel.part)) {
          FS.PartPanel.close(panel);
        }
      }
      FS.PartPanel.layout(
        'flight',
        (part) => FS.Renderer.partToScreen(game.cam, game.vessel, game.t, part.c),
        game.mapMode,
      );
      FS.HUD.update(game, timeStep);
      updateDevOverlay(timeStep);
    }
    requestAnimationFrame(frame);
  }

  function updateCamera(timeStep) {
    const vessel = game.vessel;
    const { H: viewHeight } = FS.Renderer.size();
    const position = Vector.add(FS.bodyAbs(vessel.body, game.t), vessel.r);
    game.cam.x = position.x;
    game.cam.y = position.y;
    const want = Vector.angle(vessel.r) - Math.PI / 2;
    const diff = FS.wrapAngle(want - game.cam.rot);
    game.cam.rot += Math.abs(diff) > 1 ? diff : diff * Math.min(1, timeStep * 6);
    const base = (viewHeight * 0.3) / Math.max(vessel.layout.height, 6);
    game.cam.s = FS.clamp(base * game.zoom, 2e-5, 120);
    if (game.mapMode) {
      const focus = focusPos();
      game.mapCam.x = focus.x + game.mapPan.x;
      game.mapCam.y = focus.y + game.mapPan.y;
    }
  }

  // ---------- Start ----------
  const RENDERER_METHODS = [
    'init',
    'resize',
    'size',
    'update',
    'drawFlight',
    'drawMap',
    'worldToScreen',
    'partToScreen',
    'screenToPart',
    'stats',
  ];

  game.settings = Object.assign({ pixelSize: 1.5 }, FS.store.load('flatspace.settings', {}) || {});
  ui.saveSettings = () => FS.store.save('flatspace.settings', game.settings);

  // WebGL2 pixel-art renderer when the browser has it (add ?canvas2d to the address to
  // force the simple one); otherwise the Canvas 2D renderer, with a notice saying so.
  function pickRenderer() {
    if (FS.RenderGL && FS.GL.supported() && !/[?&]canvas2d\b/.test(location.search)) {
      try {
        FS.RenderGL.setPixelSize(game.settings.pixelSize);
        FS.RenderGL.init(byId('view'), game);
        return FS.RenderGL;
      } catch (error) {
        console.warn('WebGL renderer failed, using Canvas 2D: ' + error.message);
        // a canvas keeps the first kind of context it gave out, so start from a fresh one
        const oldView = byId('view');
        const fresh = oldView.cloneNode(false);
        oldView.replaceWith(fresh);
        document.querySelectorAll('.view-overlay').forEach((overlay) => overlay.remove());
      }
    }
    FS.Render.init(byId('view'), game);
    if (!/[?&]canvas2d\b/.test(location.search)) {
      glNotice();
    }
    return FS.Render;
  }
  function glNotice() {
    const notice = document.createElement('div');
    notice.className = 'gl-notice';
    notice.setAttribute('role', 'status');
    notice.innerHTML =
      '<span>This browser doesn\'t support WebGL2, so the game is using its simpler drawing mode (no pixel art).</span><button type="button" aria-label="Dismiss">×</button>';
    notice.querySelector('button').addEventListener('click', () => notice.remove());
    document.body.appendChild(notice);
  }

  function init() {
    FS.Renderer = pickRenderer();
    const missing = RENDERER_METHODS.filter((methodName) => typeof FS.Renderer[methodName] !== 'function');
    if (missing.length) {
      console.error('Renderer is missing: ' + missing.join(', '));
    }
    FS.HUD.init();
    FS.Editor.init(game);
    FS.Input.init();
    window.addEventListener('resize', () => {
      FS.Renderer.resize();
      FS.Editor.resize();
    });

    byId('version').textContent = 'v' + FS.VERSION;
    game.showScene('editor');

    // ?debug starts a flight already in a 100 km orbit, to speed up testing.
    if (/[?&]debug\b/.test(location.search)) {
      game.launch({ name: FS.SAMPLE_CRAFT[1].name, parts: FS.SAMPLE_CRAFT[1].parts.slice() });
      game.debugOrbit(100000);
      toast('Debug start: 100 km orbit.', '', 3000);
    }
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
