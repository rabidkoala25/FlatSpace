// main.js — the page around the simulation: scenes, messages and dialogs, milestones,
// the map camera, and the frame loop that ties sim, renderer and HUD together.
// The simulation itself lives in sim.js, warp.js and nodes.js; controls in input.js.
(function () {
  const V = FS.vec;
  const $ = (id) => document.getElementById(id);
  const G = FS.game;
  const UI = (FS.UI = {});

  G.milestones = new Set(FS.store.load('flatspace.milestones', []));

  // ---------- Scenes ----------
  G.showScene = (name) => {
    G.scene = name;
    $('editor').hidden = name !== 'editor';
    $('flight').hidden = name !== 'flight';
    $('help').hidden = true;
    UI.hideDialog();
    requestAnimationFrame(() => {
      FS.Renderer.resize();
      FS.Editor.resize();
    });
  };

  G.launch = (craft) => {
    const v = G.newFlight(craft);
    G.mapFocus = 'vessel';
    G.showScene('flight');
    UI.setMapMode(false);
    const r = V.add(FS.bodyAbs(v.body, G.t), v.r);
    G.cam.x = r.x; G.cam.y = r.y;
    G.cam.rot = V.angle(v.r) - Math.PI / 2;
    toast('Press Space to ignite the first stage.', '', 5000);
    if (!v.hasCommand) toast('This craft has no command part, so it cannot steer.', 'bad', 5000);
  };

  G.revert = () => {
    G.t = G.launchT;
    G.launch(G.craft);
  };

  G.toHangar = () => {
    G.vessel = null;
    G.showScene('editor');
    FS.Editor.changed();
  };

  // ---------- What the player is told about simulation events ----------
  G.on('message', ({ text, kind, ms }) => toast(text, kind, ms));

  G.on('staged', ({ vessel, event }) => {
    if (vessel !== G.vessel) return;
    toast('Stage ' + vessel.stageIdx + (event.decouple ? ': separation' : event.chutes ? ': parachutes armed' : ': ignition'), '', 1500);
  });

  G.on('exploded', ({ vessel }) => {
    if (vessel !== G.vessel) return;
    toast('Vessel destroyed.', 'bad', 4000);
    setTimeout(() => {
      if (G.vessel !== vessel) return;
      UI.showDialog('Vessel destroyed', flightSummary(vessel, 'The craft hit the ground too hard.'), [
        ['Revert to launch', G.revert, 'primary'],
        ['Back to hangar', G.toHangar, 'ghost'],
      ]);
    }, 1600);
  });

  G.on('touchdown', ({ vessel, water }) => {
    if (vessel !== G.vessel || !vessel.stats.launched) return;
    const b = vessel.body;
    toast((water ? 'Splashdown on ' : 'Touchdown on ') + b.name + '.', '', 3500);
    vessel.landings.push(b.name);
    if (b !== FS.root) milestone('land-' + b.name, 'First landing on ' + b.name + '!');
    else if (vessel.visited.size) milestone('return', 'Returned home from ' + [...vessel.visited].join(' and ') + '!');
  });

  G.on('soi', ({ vessel, from }) => {
    if (vessel !== G.vessel) return;
    const b = vessel.body;
    if (b !== FS.root) {
      vessel.visited.add(b.name);
      toast('Entering the sphere of influence of ' + b.name + '.', '', 3500);
      milestone('soi-' + b.name, 'First encounter with ' + b.name + '!');
    } else toast('Leaving ' + from.name + '.', '', 3000);
  });

  function milestone(key, text) {
    if (G.milestones.has(key)) return;
    G.milestones.add(key);
    FS.store.save('flatspace.milestones', [...G.milestones]);
    toast('Milestone: ' + text, 'milestone', 5000);
  }

  function checkMilestones(v) {
    if (v.dead || !v.stats.launched) return;
    const b = v.body;
    if (!v.landed && b === FS.root && v.altitude > 200) milestone('launch', 'First launch!');
    if (b === FS.root && v.altitude > b.atmo.height) milestone('space', 'Reached space!');
    if (v.situation().startsWith('Orbiting')) milestone('orbit-' + b.name, 'First orbit of ' + b.name + '!');
  }

  // ---------- Toasts & dialogs ----------
  function toast(msg, cls = '', ms = 3000) {
    const host = $('toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + cls;
    el.textContent = msg;
    host.appendChild(el);
    while (host.children.length > 4) host.removeChild(host.firstChild);
    setTimeout(() => el.remove(), ms);
  }
  G.toast = toast;

  UI.showDialog = (title, bodyHtml, actions) => {
    $('dlgTitle').textContent = title;
    $('dlgBody').innerHTML = bodyHtml;
    const host = $('dlgActions');
    host.innerHTML = '';
    for (const [label, fn, cls] of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ' + (cls || 'ghost');
      b.textContent = label;
      b.addEventListener('click', () => { UI.hideDialog(); fn(); });
      host.appendChild(b);
    }
    $('dialog').hidden = false;
    G.paused = true;
    const first = host.querySelector('button');
    if (first) first.focus();
  };
  UI.hideDialog = () => { $('dialog').hidden = true; G.paused = false; };

  function flightSummary(v, intro) {
    const rows = [
      ['Craft', v.name],
      ['Flight time', FS.fmtTime(G.t - G.launchT)],
      ['Highest altitude', FS.fmtDist(v.stats.maxAlt)],
      ['Top speed', FS.fmtSpeed(v.stats.maxSpeed)],
      ['Bodies visited', v.visited.size ? [...v.visited].join(', ') : 'Aster only'],
      ['Landings', v.landings.length ? v.landings.join(', ') : 'none'],
    ];
    return `<p>${intro}</p><dl class="fdata">${rows.map(([k, x]) => `<dt>${k}</dt><dd>${String(x).replace(/</g, '&lt;')}</dd>`).join('')}</dl>`;
  }

  UI.recover = () => {
    UI.showDialog('Vessel recovered', flightSummary(G.vessel, 'The crew is home safe.'), [
      ['Back to hangar', G.toHangar, 'primary'],
    ]);
  };

  UI.menu = () => {
    UI.showDialog('Flight menu', '<p>Time is paused. Flatspace Program v' + FS.VERSION + '</p>', [
      ['Resume', () => {}, 'primary'],
      ['Revert to launch', G.revert, 'ghost'],
      ['Back to hangar', G.toHangar, 'ghost'],
      ['Controls', () => ($('help').hidden = false), 'ghost'],
    ]);
  };

  // ---------- Map ----------
  UI.setMapMode = (on) => {
    G.mapMode = on;
    $('mapHint').hidden = !on;
    if (on) fitMap();
  };
  function focusPos() {
    if (G.mapFocus === 'vessel') return V.add(FS.bodyAbs(G.vessel.body, G.t), G.vessel.r);
    return FS.bodyAbs(G.mapFocus, G.t);
  }
  function fitMap() {
    const { W, H } = FS.Renderer.size();
    const m = Math.min(W, H) * 0.42;
    let span;
    if (G.mapFocus === 'vessel') {
      const v = G.vessel, b = v.body;
      const o = FS.orbitFromState(v.r, v.v, b.mu, G.t);
      span = o.e < 1 && o.ap < (isFinite(b.soi) ? b.soi : 1e12) ? o.ap * 1.1 : Math.max(V.len(v.r) * 2.5, b.R * 3);
      if (b === FS.root && span > 6e7) span = 6e7;
      span = Math.max(span, b.R * 1.6);
    } else {
      const b = G.mapFocus;
      span = b === FS.root ? b.R * 4 : b.R * 5;
    }
    G.mapCam.s = m / span;
    G.mapPan = { x: 0, y: 0 };
  }
  UI.cycleFocus = () => {
    const list = ['vessel', ...FS.bodies];
    const i = list.indexOf(G.mapFocus);
    G.mapFocus = list[(i + 1) % list.length];
    fitMap();
  };

  // Click near any part of the predicted path to add a maneuver node there.
  UI.mapClick = (sx, sy) => {
    if (!G.patches || G.vessel.landed) return;
    let best = null, bd = 18;
    G.patches.forEach((p, i) => {
      const from = Math.max(p.tStart, G.t);
      const origin = FS.bodyAbs(p.body, i === 0 ? G.t : p.tStart);
      for (const q of FS.sampleOrbit(p.orbit, from, p.tEnd, 500)) {
        const s = FS.Renderer.worldToScreen(G.mapCam, origin.x + q.x, origin.y + q.y);
        const d = Math.hypot(s.x - sx, s.y - sy);
        if (d < bd && q.t > G.t + 2) { bd = d; best = q; }
      }
    });
    if (best && G.createNode(best.t)) toast('Node added. Use the panel to set the burn.', '', 2500);
  };

  // ---------- Developer overlay (F3) ----------
  // Shows frame time, physics steps per frame and particle count, to watch performance.
  let devTimer = 0, devFrames = 0, devTime = 0;
  function updateDevOverlay(dt) {
    const el = $('devOverlay');
    devFrames++; devTime += dt;
    devTimer -= dt;
    if (el.hidden || devTimer > 0) return;
    devTimer = 0.25;
    const ms = (devTime / Math.max(1, devFrames)) * 1000;
    devFrames = 0; devTime = 0;
    const steps = G.frame.steps;
    el.textContent =
      'v' + FS.VERSION + '\n' +
      'frame      ' + ms.toFixed(1) + ' ms (' + (1000 / ms).toFixed(0) + ' fps)\n' +
      'physics    ' + steps + (typeof steps === 'number' ? ' steps/frame' : '') + '\n' +
      'particles  ' + FS.Renderer.stats().particles + '\n' +
      'debris     ' + G.debris.length;
  }

  // ---------- Frame loop ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (G.scene === 'flight' && G.vessel) {
      if (!G.paused) {
        FS.Input.apply(dt);
        G.update(dt);
        FS.Renderer.update(G);
        checkMilestones(G.vessel);
      }
      updateCamera(dt);
      if (G.mapMode) FS.Renderer.drawMap(G); else FS.Renderer.drawFlight(G);
      FS.HUD.update(G, dt);
      updateDevOverlay(dt);
    }
    requestAnimationFrame(frame);
  }

  function updateCamera(dt) {
    const ves = G.vessel;
    const { H } = FS.Renderer.size();
    const p = V.add(FS.bodyAbs(ves.body, G.t), ves.r);
    G.cam.x = p.x; G.cam.y = p.y;
    const want = V.angle(ves.r) - Math.PI / 2;
    const diff = FS.wrapAngle(want - G.cam.rot);
    G.cam.rot += Math.abs(diff) > 1 ? diff : diff * Math.min(1, dt * 6);
    const base = (H * 0.3) / Math.max(ves.layout.height, 6);
    G.cam.s = FS.clamp(base * G.zoom, 2e-5, 120);
    if (G.mapMode) {
      const f = focusPos();
      G.mapCam.x = f.x + G.mapPan.x;
      G.mapCam.y = f.y + G.mapPan.y;
    }
  }

  // ---------- Start ----------
  const RENDERER_METHODS = ['init', 'resize', 'size', 'update', 'drawFlight', 'drawMap', 'worldToScreen', 'stats'];

  function init() {
    const missing = RENDERER_METHODS.filter((m) => typeof FS.Renderer[m] !== 'function');
    if (missing.length) console.error('Renderer is missing: ' + missing.join(', '));
    FS.Renderer.init($('view'), G);
    FS.HUD.init();
    FS.Editor.init(G);
    FS.Input.init();
    window.addEventListener('resize', () => { FS.Renderer.resize(); FS.Editor.resize(); });

    $('version').textContent = 'v' + FS.VERSION;
    G.showScene('editor');

    // ?debug starts a flight already in a 100 km orbit, to speed up testing.
    if (/[?&]debug\b/.test(location.search)) {
      G.launch({ name: FS.SAMPLE_CRAFT[1].name, parts: FS.SAMPLE_CRAFT[1].parts.slice() });
      G.debugOrbit(100000);
      toast('Debug start: 100 km orbit.', '', 3000);
    }
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
