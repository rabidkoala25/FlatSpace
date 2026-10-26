// main.js — the page around the simulation: scenes, messages and dialogs, milestones,
// the map camera, and the frame loop that ties sim, renderer and HUD together.
// The simulation itself lives in sim.js, warp.js and nodes.js; controls in input.js.
(function () {
  const Vector = Flatspace.Vector;
  const byId = (elementId) => document.getElementById(elementId);
  const game = Flatspace.game;
  const userInterface = (Flatspace.UI = {});

  game.milestones = new Set(Flatspace.store.load('flatspace.milestones', []));

  // ---------- Scenes ----------
  game.showScene = (name) => {
    game.scene = name;
    Flatspace.PartPanel.closeAll('flight');
    byId('editor').hidden = name !== 'editor';
    byId('flight').hidden = name !== 'flight';
    byId('help').hidden = true;
    userInterface.hideDialog();
    requestAnimationFrame(() => {
      Flatspace.Renderer.resize();
      Flatspace.Editor.resize();
    });
  };

  game.launch = (craft) => {
    const vessel = game.newFlight(craft);
    game.mapFocus = 'vessel';
    game.showScene('flight');
    userInterface.setMapMode(false);
    const position = Vector.add(Flatspace.bodyAbsolutePosition(vessel.body, game.time), vessel.position);
    game.camera.x = position.x;
    game.camera.y = position.y;
    game.camera.rotation = Vector.angle(vessel.position) - Math.PI / 2;
    toast('Press Space to ignite the first stage.', '', 5000);
    if (!vessel.hasCommand) {
      toast('This craft has no command part, so it cannot steer.', 'bad', 5000);
    }
  };

  game.revert = () => {
    game.time = game.launchTime;
    game.launch(game.craft);
  };

  game.toHangar = () => {
    game.vessel = null;
    game.showScene('editor');
    Flatspace.Editor.changed();
  };

  // ---------- What the player is told about simulation events ----------
  game.on('message', ({ text, kind, duration }) => toast(text, kind, duration));

  game.on('staged', ({ vessel, event }) => {
    if (vessel !== game.vessel) {
      return;
    }
    toast(
      'Stage ' +
        vessel.stageIndex +
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
    toast(`${part.type.name} ${what}.`, '', 1500);
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
      userInterface.showDialog(
        'Vessel destroyed',
        flightSummary(vessel, 'The craft hit the ground too hard.'),
        [
          ['Revert to launch', game.revert, 'primary'],
          ['Back to hangar', game.toHangar, 'ghost'],
        ],
      );
    }, 1600);
  });

  game.on('touchdown', ({ vessel, water }) => {
    if (vessel !== game.vessel || !vessel.stats.launched) {
      return;
    }
    const body = vessel.body;
    toast((water ? 'Splashdown on ' : 'Touchdown on ') + body.name + '.', '', 3500);
    vessel.landings.push(body.name);
    if (body !== Flatspace.root) {
      milestone('land-' + body.name, 'First landing on ' + body.name + '!');
    } else if (vessel.visited.size) {
      milestone('return', 'Returned home from ' + [...vessel.visited].join(' and ') + '!');
    }
  });

  game.on('sphere-change', ({ vessel, from }) => {
    if (vessel !== game.vessel) {
      return;
    }
    const body = vessel.body;
    if (body !== Flatspace.root) {
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
    Flatspace.store.save('flatspace.milestones', [...game.milestones]);
    toast('Milestone: ' + text, 'milestone', 5000);
  }

  function checkMilestones(vessel) {
    if (vessel.dead || !vessel.stats.launched) {
      return;
    }
    const body = vessel.body;
    if (!vessel.landed && body === Flatspace.root && vessel.altitude > 200) {
      milestone('launch', 'First launch!');
    }
    if (body === Flatspace.root && vessel.altitude > body.atmosphere.height) {
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

  userInterface.showDialog = (title, bodyHtml, actions) => {
    byId('dialogTitle').textContent = title;
    byId('dialogBody').innerHTML = bodyHtml;
    const host = byId('dialogActions');
    host.innerHTML = '';
    for (const [label, action, className] of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn ' + (className || 'ghost');
      button.textContent = label;
      button.addEventListener('click', () => {
        userInterface.hideDialog();
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
  userInterface.hideDialog = () => {
    byId('dialog').hidden = true;
    game.paused = false;
  };

  function flightSummary(vessel, intro) {
    const rows = [
      ['Craft', vessel.name],
      ['Flight time', Flatspace.formatTime(game.time - game.launchTime)],
      ['Highest altitude', Flatspace.formatDistance(vessel.stats.maxAltitude)],
      ['Top speed', Flatspace.formatSpeed(vessel.stats.maxSpeed)],
      ['Bodies visited', vessel.visited.size ? [...vessel.visited].join(', ') : 'Aster only'],
      ['Landings', vessel.landings.length ? vessel.landings.join(', ') : 'none'],
    ];
    return `<p>${intro}</p><dl class="flight-data">${rows.map(([label, value]) => `<dt>${label}</dt><dd>${String(value).replace(/</g, '&lt;')}</dd>`).join('')}</dl>`;
  }

  userInterface.recover = () => {
    userInterface.showDialog('Vessel recovered', flightSummary(game.vessel, 'The crew is home safe.'), [
      ['Back to hangar', game.toHangar, 'primary'],
    ]);
  };

  const PIXEL_SIZES = [
    [1.5, 'Fine'],
    [2, 'Medium'],
    [3, 'Chunky'],
  ];
  userInterface.menu = () => {
    const usingWebGL = Flatspace.Renderer === Flatspace.RenderGL;
    const pixelSizeSetting = usingWebGL
      ? `<div class="menu-row"><span>Pixel size</span><div class="part-panel-choices" role="group" aria-label="Pixel size">${PIXEL_SIZES.map(([size, label]) => `<button type="button" class="part-panel-choice" data-pixel-size="${size}" aria-pressed="${game.settings.pixelSize === size}">${label}</button>`).join('')}</div></div>`
      : '<p class="menu-note">Simple drawing mode: this browser has no WebGL2.</p>';
    userInterface.showDialog(
      'Flight menu',
      '<p>Time is paused. Flatspace Program v' + Flatspace.VERSION + '</p>' + pixelSizeSetting,
      [
        ['Resume', () => {}, 'primary'],
        ['Revert to launch', game.revert, 'ghost'],
        ['Back to hangar', game.toHangar, 'ghost'],
        ['Controls', () => (byId('help').hidden = false), 'ghost'],
      ],
    );
    for (const button of byId('dialogBody').querySelectorAll('[data-pixel-size]')) {
      button.addEventListener('click', () => {
        game.settings.pixelSize = +button.dataset.pixelSize;
        Flatspace.RenderGL.setPixelSize(game.settings.pixelSize);
        userInterface.saveSettings();
        for (const option of byId('dialogBody').querySelectorAll('[data-pixel-size]')) {
          option.setAttribute('aria-pressed', String(option === button));
        }
      });
    }
  };

  // ---------- Map ----------
  userInterface.setMapMode = (showMap) => {
    game.mapMode = showMap;
    byId('mapHint').hidden = !showMap;
    if (showMap) {
      fitMap();
    }
  };
  function focusPosition() {
    if (game.mapFocus === 'vessel') {
      return Vector.add(Flatspace.bodyAbsolutePosition(game.vessel.body, game.time), game.vessel.position);
    }
    return Flatspace.bodyAbsolutePosition(game.mapFocus, game.time);
  }
  function fitMap() {
    const { width: viewWidth, height: viewHeight } = Flatspace.Renderer.size();
    const margin = Math.min(viewWidth, viewHeight) * 0.42;
    let span;
    if (game.mapFocus === 'vessel') {
      const vessel = game.vessel;
      const body = vessel.body;
      const orbit = Flatspace.orbitFromState(
        vessel.position,
        vessel.velocity,
        body.gravityParameter,
        game.time,
      );
      span =
        orbit.eccentricity < 1 &&
        orbit.apoapsis < (isFinite(body.sphereOfInfluence) ? body.sphereOfInfluence : 1e12)
          ? orbit.apoapsis * 1.1
          : Math.max(Vector.length(vessel.position) * 2.5, body.radius * 3);
      if (body === Flatspace.root && span > 6e7) {
        span = 6e7;
      }
      span = Math.max(span, body.radius * 1.6);
    } else {
      const body = game.mapFocus;
      span = body === Flatspace.root ? body.radius * 4 : body.radius * 5;
    }
    game.mapCamera.scale = margin / span;
    game.mapPan = { x: 0, y: 0 };
  }
  userInterface.cycleFocus = () => {
    const list = ['vessel', ...Flatspace.bodies];
    const focusIndex = list.indexOf(game.mapFocus);
    game.mapFocus = list[(focusIndex + 1) % list.length];
    fitMap();
  };

  // Click near any part of the predicted path to add a maneuver node there.
  userInterface.mapClick = (screenX, screenY) => {
    if (!game.patches || game.vessel.landed) {
      return;
    }
    let best = null;
    let bestDistance = 18;
    game.patches.forEach((patch, patchIndex) => {
      const from = Math.max(patch.startTime, game.time);
      const origin = Flatspace.bodyAbsolutePosition(
        patch.body,
        patchIndex === 0 ? game.time : patch.startTime,
      );
      for (const sample of Flatspace.sampleOrbit(patch.orbit, from, patch.endTime, 500)) {
        const screenPoint = Flatspace.Renderer.worldToScreen(
          game.mapCamera,
          origin.x + sample.x,
          origin.y + sample.y,
        );
        const distance = Math.hypot(screenPoint.x - screenX, screenPoint.y - screenY);
        if (distance < bestDistance && sample.time > game.time + 2) {
          bestDistance = distance;
          best = sample;
        }
      }
    });
    if (best && game.createNode(best.time)) {
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
      Flatspace.VERSION +
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
      Flatspace.Renderer.stats().particles +
      '\n' +
      (Flatspace.Renderer === Flatspace.RenderGL
        ? 'renderer   WebGL2, ' +
          Flatspace.Renderer.stats().draws +
          ' sprite draws, atlas ' +
          Flatspace.Renderer.stats().atlas +
          '\n' +
          'pixel      ' +
          16 / Math.pow(2, Flatspace.Renderer.stats().level) +
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
        Flatspace.Input.apply(timeStep);
        game.update(timeStep);
        Flatspace.Renderer.update(game);
        checkMilestones(game.vessel);
      }
      updateCamera(timeStep);
      if (game.mapMode) {
        Flatspace.Renderer.drawMap(game);
      } else {
        Flatspace.Renderer.drawFlight(game);
      }
      // part pop-ups follow their parts; parts that left the craft close theirs
      for (const panel of Flatspace.PartPanel.panels('flight')) {
        if (!game.vessel.parts.includes(panel.part)) {
          Flatspace.PartPanel.close(panel);
        }
      }
      Flatspace.PartPanel.layout(
        'flight',
        (part) => Flatspace.Renderer.partToScreen(game.camera, game.vessel, game.time, part.centreOffset),
        game.mapMode,
      );
      Flatspace.HUD.update(game, timeStep);
      updateDevOverlay(timeStep);
    }
    requestAnimationFrame(frame);
  }

  function updateCamera(timeStep) {
    const vessel = game.vessel;
    const { height: viewHeight } = Flatspace.Renderer.size();
    const position = Vector.add(Flatspace.bodyAbsolutePosition(vessel.body, game.time), vessel.position);
    game.camera.x = position.x;
    game.camera.y = position.y;
    const want = Vector.angle(vessel.position) - Math.PI / 2;
    const diff = Flatspace.wrapAngle(want - game.camera.rotation);
    game.camera.rotation += Math.abs(diff) > 1 ? diff : diff * Math.min(1, timeStep * 6);
    const base = (viewHeight * 0.3) / Math.max(vessel.layout.height, 6);
    game.camera.scale = Flatspace.clamp(base * game.zoom, 2e-5, 120);
    if (game.mapMode) {
      const focus = focusPosition();
      game.mapCamera.x = focus.x + game.mapPan.x;
      game.mapCamera.y = focus.y + game.mapPan.y;
    }
  }

  // ---------- Start ----------
  const RENDERER_METHODS = [
    'initialise',
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

  game.settings = Object.assign({ pixelSize: 1.5 }, Flatspace.store.load('flatspace.settings', {}) || {});
  userInterface.saveSettings = () => Flatspace.store.save('flatspace.settings', game.settings);

  // WebGL2 pixel-art renderer when the browser has it (add ?canvas2d to the address to
  // force the simple one); otherwise the Canvas 2D renderer, with a notice saying so.
  function pickRenderer() {
    if (Flatspace.RenderGL && Flatspace.WebGL.supported() && !/[?&]canvas2d\b/.test(location.search)) {
      try {
        Flatspace.RenderGL.setPixelSize(game.settings.pixelSize);
        Flatspace.RenderGL.initialise(byId('view'), game);
        return Flatspace.RenderGL;
      } catch (error) {
        console.warn('WebGL renderer failed, using Canvas 2D: ' + error.message);
        // a canvas keeps the first kind of context it gave out, so start from a fresh one
        const oldView = byId('view');
        const fresh = oldView.cloneNode(false);
        oldView.replaceWith(fresh);
        document.querySelectorAll('.view-overlay').forEach((overlay) => overlay.remove());
      }
    }
    Flatspace.Render.initialise(byId('view'), game);
    if (!/[?&]canvas2d\b/.test(location.search)) {
      glNotice();
    }
    return Flatspace.Render;
  }
  function glNotice() {
    const notice = document.createElement('div');
    notice.className = 'webgl-notice';
    notice.setAttribute('role', 'status');
    notice.innerHTML =
      '<span>This browser doesn\'t support WebGL2, so the game is using its simpler drawing mode (no pixel art).</span><button type="button" aria-label="Dismiss">×</button>';
    notice.querySelector('button').addEventListener('click', () => notice.remove());
    document.body.appendChild(notice);
  }

  function initialise() {
    Flatspace.Renderer = pickRenderer();
    const missing = RENDERER_METHODS.filter(
      (methodName) => typeof Flatspace.Renderer[methodName] !== 'function',
    );
    if (missing.length) {
      console.error('Renderer is missing: ' + missing.join(', '));
    }
    Flatspace.HUD.initialise();
    Flatspace.Editor.initialise(game);
    Flatspace.Input.initialise();
    window.addEventListener('resize', () => {
      Flatspace.Renderer.resize();
      Flatspace.Editor.resize();
    });

    byId('version').textContent = 'v' + Flatspace.VERSION;
    game.showScene('editor');

    // ?debug starts a flight already in a 100 km orbit, to speed up testing.
    if (/[?&]debug\b/.test(location.search)) {
      game.launch({ name: Flatspace.SAMPLE_CRAFT[1].name, parts: Flatspace.SAMPLE_CRAFT[1].parts.slice() });
      game.debugOrbit(100000);
      toast('Debug start: 100 km orbit.', '', 3000);
    }
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialise);
  } else {
    initialise();
  }
})();
