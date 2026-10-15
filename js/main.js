// main.js — game loop, scenes, input, time warp, maneuver nodes, milestones.
(function () {
  const V = FS.vec;
  const $ = (id) => document.getElementById(id);
  const WARP = [1, 5, 10, 50, 100, 1000, 10000, 100000];
  const PHYS_WARP = [1, 2, 3, 4];
  const STEP = 0.02; // physics step (s)

  const G = (FS.game = {
    scene: 'editor',
    t: 0,
    launchT: 0,
    vessel: null,
    debris: [],
    cam: { x: 0, y: 0, s: 10, rot: 0 },
    mapCam: { x: 0, y: 0, s: 1e-4, rot: 0 },
    mapMode: false,
    mapFocus: 'vessel',
    mapPan: { x: 0, y: 0 },
    zoom: 1,
    warpIdx: 0,
    warpTarget: null,
    onRails: false,
    node: null,
    patches: null,
    nodePatches: null,
    patchTimer: 0,
    keys: {},
    touch: {},
    milestones: new Set(FS.store.load('flatspace.milestones', [])),
  });

  // ---------- Scenes ----------
  G.showScene = (name) => {
    G.scene = name;
    $('editor').hidden = name !== 'editor';
    $('flight').hidden = name !== 'flight';
    $('help').hidden = true;
    hideDialog();
    requestAnimationFrame(() => {
      FS.Render.resize();
      FS.Editor.resize();
    });
  };

  G.launch = (craft) => {
    G.craft = craft;
    G.launchT = G.t;
    G.vessel = new FS.Vessel(craft.name, craft.parts, FS.root, { throttle: 1 });
    G.vessel.placeOnPad(G.t);
    G.vessel.initialSegs = FS.segmentsOf(G.vessel.parts).length;
    G.vessel.visited = new Set();
    G.vessel.landings = [];
    G.debris = [];
    G.node = null;
    G.nodePatches = null;
    G.patches = null;
    G.warpIdx = 0;
    G.warpTarget = null;
    G.zoom = 1;
    G.mapMode = false;
    G.mapFocus = 'vessel';
    FS.Render.clearParticles();
    G.showScene('flight');
    setMapMode(false);
    const r = V.add(FS.bodyAbs(G.vessel.body, G.t), G.vessel.r);
    G.cam.x = r.x; G.cam.y = r.y;
    G.cam.rot = V.angle(G.vessel.r) - Math.PI / 2;
    toast('Press Space to ignite the first stage.', '', 5000);
    if (!G.vessel.hasCommand) toast('This craft has no command part, so it cannot steer.', 'bad', 5000);
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

  // ---------- Time warp ----------
  function allowedWarpIdx(ves) {
    if (ves.landed) return 6;
    return Math.min(FS.maxWarpIndex(ves.body, ves.altitude), WARP.length - 1);
  }
  function canRails(ves) {
    if (ves.dead) return false;
    if (ves.landed) return true;
    if (ves.thrustNow > 0) return false;
    const b = ves.body;
    if (b.atmo && ves.altitude < b.atmo.height) return false;
    return allowedWarpIdx(ves) >= 1;
  }
  G.effectiveRate = () => {
    if (!G.vessel || G.warpIdx === 0) return 1;
    return G.onRails ? WARP[G.warpIdx] : PHYS_WARP[Math.min(G.warpIdx, 3)];
  };
  G.changeWarp = (d) => {
    const ves = G.vessel;
    if (!ves) return;
    G.warpTarget = null;
    let idx = G.warpIdx + d;
    if (idx < 0) idx = 0;
    const max = canRails(ves) ? allowedWarpIdx(ves) : 3;
    if (idx > max) {
      idx = max;
      if (d > 0) toast(ves.thrustNow > 0 ? 'Cannot warp faster while engines are firing.' : 'Too close to ' + ves.body.name + ' to warp faster.', '', 1800);
    }
    G.warpIdx = idx;
  };
  G.stopWarp = () => { G.warpIdx = 0; G.warpTarget = null; };

  // ---------- Maneuver nodes ----------
  G.burnTime = (dv) => {
    const ves = G.vessel;
    if (!ves) return Infinity;
    const segs = FS.segmentsOf(ves.parts);
    const seg = segs[0] || [];
    let F = 0, mdot = 0;
    for (const q of seg) {
      if (!q.def.engine) continue;
      const th = FS.engineThrust(q.def.engine, FS.pressure(ves.body, ves.altitude), 1);
      F += th.F; mdot += th.mdot;
    }
    if (F <= 0) return Infinity;
    const ve = F / mdot;
    return ((ves.mass * ve) / F) * (1 - Math.exp(-dv / ve));
  };

  function currentOrbit() {
    const ves = G.vessel;
    return FS.orbitFromState(ves.r, ves.v, ves.body.mu, G.t);
  }

  G.createNode = (tNode) => {
    const ves = G.vessel;
    const keep = G.node && V.len(G.node.applied) < 0.01 ? { pro: G.node.pro, rad: G.node.rad } : { pro: 0, rad: 0 };
    G.node = { body: ves.body, t: tNode, pro: keep.pro, rad: keep.rad, applied: { x: 0, y: 0 } };
    refreshNode(true);
  };
  G.deleteNode = () => { G.node = null; G.nodePatches = null; if (G.vessel && G.vessel.sasMode === 'maneuver') G.vessel.sasMode = 'stability'; };

  function refreshNode(full) {
    const nd = G.node;
    if (!nd) return;
    const ves = G.vessel;
    const o = currentOrbit();
    const st = FS.orbitState(o, nd.t);
    nd.r = st.r;
    const prog = V.norm(st.v);
    const rhat = V.norm(st.r);
    let radOut = V.sub(rhat, V.scale(prog, V.dot(rhat, prog)));
    radOut = V.len(radOut) > 1e-9 ? V.norm(radOut) : V.perp(prog);
    if (V.len(nd.applied) < 0.01 || full) nd.dvVec = V.add(V.scale(prog, nd.pro), V.scale(radOut, nd.rad));
    nd.remaining = V.sub(nd.dvVec, nd.applied);
    G.nodePatches = FS.predictPatches(ves.body, st.r, V.add(st.v, nd.remaining), nd.t, 3);
  }

  function editNode(k, d) {
    const nd = G.node;
    if (!nd) return;
    if (k === 't') {
      const p0 = G.patches && G.patches[0];
      const tMax = p0 && isFinite(p0.tEnd) ? p0.tEnd - 1 : Infinity;
      nd.t = FS.clamp(nd.t + d, G.t + 1, tMax);
    } else {
      nd[k] += d;
    }
    nd.applied = { x: 0, y: 0 };
    refreshNode(true);
    FS.HUD.updateNode(G);
  }

  G.warpToNode = () => {
    if (!G.node) return;
    const bt = G.burnTime(Math.hypot(G.node.pro, G.node.rad));
    G.warpTarget = G.node.t - (isFinite(bt) ? bt / 2 : 0) - 15;
    if (G.warpTarget <= G.t + 1) { G.warpTarget = null; toast('Node is too close to warp to.', '', 1800); }
  };

  // ---------- Events from the simulation ----------
  G.addDebris = (d) => {
    G.debris.push(d);
    if (G.debris.length > 24) G.debris.shift();
  };

  G.onExplode = (v) => {
    if (G.vessel && v.body === G.vessel.body) FS.Render.emitExplosion(v.body, v.r, v.v, Math.max(2, v.layout.height * 0.4));
    if (v === G.vessel) {
      G.stopWarp();
      toast('Vessel destroyed.', 'bad', 4000);
      setTimeout(() => {
        if (G.vessel !== v) return;
        showDialog('Vessel destroyed', flightSummary(v, 'The craft hit the ground too hard.'), [
          ['Revert to launch', G.revert, 'primary'],
          ['Back to hangar', G.toHangar, 'ghost'],
        ]);
      }, 1600);
    }
  };

  G.onTouchdown = (v, water) => {
    if (v !== G.vessel) return;
    G.stopWarp();
    v.throttle = 0;
    const b = v.body;
    if (!v.stats.launched) return;
    toast((water ? 'Splashdown on ' : 'Touchdown on ') + b.name + '.', '', 3500);
    v.landings.push(b.name);
    if (b !== FS.root) milestone('land-' + b.name, 'First landing on ' + b.name + '!');
    else if (v.visited.size) milestone('return', 'Returned home from ' + [...v.visited].join(' and ') + '!');
  };

  G.onSOIChange = (v, oldBody) => {
    if (v !== G.vessel) return;
    FS.Render.clearParticles();
    G.debris = [];
    if (G.node) { G.deleteNode(); toast('Maneuver node removed: you changed sphere of influence.', '', 3000); }
    const b = v.body;
    if (b !== FS.root) {
      v.visited.add(b.name);
      toast('Entering the sphere of influence of ' + b.name + '.', '', 3500);
      milestone('soi-' + b.name, 'First encounter with ' + b.name + '!');
    } else toast('Leaving ' + oldBody.name + '.', '', 3000);
    G.patchTimer = 0;
    if (G.warpIdx > allowedWarpIdx(v)) G.warpIdx = allowedWarpIdx(v);
  };

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
    const sit = v.situation();
    if (sit.startsWith('Orbiting')) milestone('orbit-' + b.name, (b === FS.root ? 'First orbit of ' : 'First orbit of ') + b.name + '!');
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

  function showDialog(title, bodyHtml, actions) {
    $('dlgTitle').textContent = title;
    $('dlgBody').innerHTML = bodyHtml;
    const host = $('dlgActions');
    host.innerHTML = '';
    for (const [label, fn, cls] of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ' + (cls || 'ghost');
      b.textContent = label;
      b.addEventListener('click', () => { hideDialog(); fn(); });
      host.appendChild(b);
    }
    $('dialog').hidden = false;
    G.paused = true;
    const first = host.querySelector('button');
    if (first) first.focus();
  }
  function hideDialog() { $('dialog').hidden = true; G.paused = false; }

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

  function recover() {
    const v = G.vessel;
    showDialog('Vessel recovered', flightSummary(v, 'The crew is home safe.'), [
      ['Back to hangar', G.toHangar, 'primary'],
    ]);
  }

  function menu() {
    showDialog('Flight menu', '<p>Time is paused. Flatspace Program v' + FS.VERSION + '</p>', [
      ['Resume', () => {}, 'primary'],
      ['Revert to launch', G.revert, 'ghost'],
      ['Back to hangar', G.toHangar, 'ghost'],
      ['Controls', () => ($('help').hidden = false), 'ghost'],
    ]);
  }

  // ---------- Map ----------
  function setMapMode(on) {
    G.mapMode = on;
    $('mapHint').hidden = !on;
    if (on) fitMap();
  }
  function focusPos() {
    if (G.mapFocus === 'vessel') return V.add(FS.bodyAbs(G.vessel.body, G.t), G.vessel.r);
    return FS.bodyAbs(G.mapFocus, G.t);
  }
  function fitMap() {
    const { W, H } = FS.Render.size();
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
  function cycleFocus() {
    const list = ['vessel', ...FS.bodies];
    const i = list.indexOf(G.mapFocus);
    G.mapFocus = list[(i + 1) % list.length];
    fitMap();
  }

  function mapClick(sx, sy) {
    const p0 = G.patches && G.patches[0];
    if (!p0 || G.vessel.landed) return;
    const pts = FS.sampleOrbit(p0.orbit, G.t, p0.tEnd, 500);
    const origin = FS.bodyAbs(p0.body, G.t);
    let best = null, bd = 18;
    for (const p of pts) {
      const s = FS.Render.w2s(G.mapCam, origin.x + p.x, origin.y + p.y);
      const d = Math.hypot(s.x - sx, s.y - sy);
      if (d < bd && p.t > G.t + 2) { bd = d; best = p; }
    }
    if (best) {
      G.createNode(best.t);
      toast('Node added. Use the panel to set the burn.', '', 2500);
    }
  }

  // ---------- Main loop ----------
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
    el.textContent =
      'v' + FS.VERSION + '\n' +
      'frame      ' + ms.toFixed(1) + ' ms (' + (1000 / ms).toFixed(0) + ' fps)\n' +
      'physics    ' + (G.devSteps ?? '-') + (typeof G.devSteps === 'number' ? ' steps/frame' : '') + '\n' +
      'particles  ' + FS.Render.particles.length + '\n' +
      'debris     ' + G.debris.length;
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (G.scene === 'flight' && G.vessel) {
      if (!G.paused) updateFlight(dt);
      updateCamera(dt);
      if (G.mapMode) FS.Render.drawMap(G); else FS.Render.drawFlight(G);
      FS.HUD.update(G, dt);
      updateDevOverlay(dt);
    }
    requestAnimationFrame(frame);
  }

  function updateFlight(dt) {
    const ves = G.vessel;
    const k = G.keys, tc = G.touch;
    // Controls
    if (k.Shift || tc.thrUp) ves.throttle = Math.min(1, ves.throttle + dt * 0.9);
    if (k.Control || tc.thrDown) ves.throttle = Math.max(0, ves.throttle - dt * 0.9);
    ves.rot = ((k.a || k.ArrowLeft || tc.left) ? 1 : 0) - ((k.d || k.ArrowRight || tc.right) ? 1 : 0);

    // Warp-to target
    if (G.warpTarget != null) {
      const rem = G.warpTarget - G.t;
      if (rem <= 0.5) { G.stopWarp(); }
      else {
        let want = 0;
        for (let i = WARP.length - 1; i >= 0; i--) if (WARP[i] * 1.2 < rem) { want = i; break; }
        G.warpIdx = Math.min(want, canRails(ves) ? allowedWarpIdx(ves) : 3);
      }
    }

    const railsOK = G.warpIdx > 0 && canRails(ves) && G.warpIdx >= 1;
    if (railsOK && G.warpIdx > allowedWarpIdx(ves)) G.warpIdx = allowedWarpIdx(ves);
    const useRails = railsOK && WARP[G.warpIdx] > 4;
    if (!railsOK && G.warpIdx > 3) G.warpIdx = 3;

    if (useRails) {
      if (!G.onRails) { ves.goOnRails(G.t); G.onRails = true; G.debris = []; FS.Render.clearParticles(); }
      let tNew = G.t + dt * WARP[G.warpIdx];
      if (G.warpTarget != null && tNew > G.warpTarget) tNew = G.warpTarget;
      // Sub-step so SOI changes are not skipped
      const vmax = V.len(ves.v) + 2000;
      const maxStep = Math.max(1, (0.08 * 2.2e6) / vmax);
      G.devSteps = 'on rails';
      while (G.t < tNew) {
        G.t = Math.min(tNew, G.t + maxStep);
        ves.railsTo(G.t, G);
        // stop advancing as soon as we get too low for this warp rate
        if (!ves.landed) {
          const b = ves.body;
          if ((b.atmo && ves.altitude < b.atmo.height) || allowedWarpIdx(ves) < G.warpIdx) break;
        }
      }
      if (!ves.landed) {
        const b = ves.body;
        if (b.atmo && ves.altitude < b.atmo.height) { G.stopWarp(); toast('Entering the atmosphere: time warp stopped.', '', 2500); }
        else if (G.warpIdx > allowedWarpIdx(ves)) G.warpIdx = allowedWarpIdx(ves);
      }
      if (G.warpIdx === 0 || WARP[G.warpIdx] <= 4) { ves.offRails(); G.onRails = false; }
    } else {
      if (G.onRails) { ves.offRails(); G.onRails = false; }
      const rate = G.warpIdx === 0 ? 1 : PHYS_WARP[Math.min(G.warpIdx, 3)];
      const sim = dt * rate;
      const n = Math.max(1, Math.ceil(sim / STEP));
      G.devSteps = n;
      const h = sim / n;
      for (let i = 0; i < n; i++) {
        ves.step(h, G.t, G);
        if (G.node && ves.thrustNow > 0) G.node.applied = V.add(G.node.applied, V.scale(ves.thrustAccel, h));
        for (const d of G.debris) d.step(h, G.t, G);
        G.t += h;
        if (ves.dead) break;
      }
      // move existing particles first, then add new ones at the current time
      FS.Render.updateParticles(sim, ves.body, G.t);
      if (!ves.dead && rate <= 4) FS.Render.emitExhaust(ves, sim, G.t);
      for (const d of G.debris) if (!d.dead && d.body === ves.body) FS.Render.emitExhaust(d, sim, G.t);
    }

    // Debris clean-up
    G.debris = G.debris.filter((d) => !d.dead && d.body === ves.body && V.len(V.sub(d.r, ves.r)) < 150000 && d.age < 900);

    // Stop time warp shortly before a planned burn
    if (G.node && G.warpIdx > 0 && !G.node.warned) {
      const bt = G.burnTime(V.len(G.node.remaining || { x: G.node.pro, y: G.node.rad }));
      const start = G.node.t - (isFinite(bt) ? bt / 2 : 0);
      if (G.t >= start - 10) { G.stopWarp(); G.node.warned = true; toast('Maneuver burn coming up.', '', 2500); }
    }

    // Node bookkeeping
    if (G.node) {
      if (G.node.body !== ves.body) G.deleteNode();
      else {
        G.node.remaining = V.sub(G.node.dvVec, G.node.applied);
        const started = V.len(G.node.applied) > 0.05;
        if (started && (V.len(G.node.remaining) < 0.15 || V.dot(G.node.remaining, G.node.dvVec) < 0)) {
          ves.throttle = 0;
          G.deleteNode();
          toast('Burn complete. Throttle cut.', '', 2500);
        }
      }
    }

    // Trajectory prediction (a few times per second)
    G.patchTimer -= dt;
    if (G.patchTimer <= 0) {
      G.patchTimer = 0.2;
      if (!ves.dead && !ves.landed) {
        G.patches = FS.predictPatches(ves.body, ves.r, ves.v, G.t, 3);
        if (G.node) refreshNode(false);
      } else G.patches = null;
    }
    checkMilestones(ves);
  }

  function updateCamera(dt) {
    const ves = G.vessel;
    const { W, H } = FS.Render.size();
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

  // ---------- Input ----------
  function onKey(e, down) {
    if (G.scene !== 'flight') return;
    if (e.target.tagName === 'INPUT') return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    G.keys[key] = down;
    if (e.key === 'Shift') G.keys.Shift = down;
    if (e.key === 'Control') G.keys.Control = down;
    if (!down || e.repeat) {
      if ([' ', 'Tab'].includes(e.key) && G.scene === 'flight') e.preventDefault();
      return;
    }
    const ves = G.vessel;
    if (!$('dialog').hidden) {
      if (e.key === 'Escape') hideDialog();
      return;
    }
    switch (key) {
      case ' ': {
        e.preventDefault();
        if (ves.dead) break;
        const ev = ves.stage(G);
        if (ev) toast('Stage ' + ves.stageIdx + (ev.decouple ? ': separation' : ev.chutes ? ': parachutes armed' : ': ignition'), '', 1500);
        break;
      }
      case 'z': ves.throttle = 1; break;
      case 'x': ves.throttle = 0; break;
      case 't': ves.sas = !ves.sas; ves.sasTarget = ves.angle; break;
      case 'm': setMapMode(!G.mapMode); break;
      case '.': G.changeWarp(1); break;
      case ',': G.changeWarp(-1); break;
      case '/': G.stopWarp(); break;
      case 'p': if (ves.deployChutes()) toast('Parachutes armed.', '', 1500); break;
      case 'h': $('help').hidden = !$('help').hidden; break;
      case 'Tab': e.preventDefault(); if (G.mapMode) cycleFocus(); break;
      case 'Escape': menu(); break;
      case 'F3': e.preventDefault(); $('devOverlay').hidden = !$('devOverlay').hidden; break;
    }
  }

  function init() {
    FS.Render.init($('view'));
    FS.HUD.init();
    FS.Editor.init(G);
    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));
    window.addEventListener('blur', () => { G.keys = {}; G.touch = {}; });
    window.addEventListener('resize', () => { FS.Render.resize(); FS.Editor.resize(); });

    const view = $('view');
    view.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = Math.pow(1.0015, -e.deltaY);
      if (G.mapMode) G.mapCam.s = FS.clamp(G.mapCam.s * f, 1e-7, 0.5);
      else G.zoom = FS.clamp(G.zoom * f, 1e-6, 30);
    }, { passive: false });

    let drag = null;
    view.addEventListener('pointerdown', (e) => {
      if (!G.mapMode) return;
      drag = { x: e.clientX, y: e.clientY, moved: false, pan: { ...G.mapPan } };
      view.setPointerCapture(e.pointerId);
    });
    view.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 4) drag.moved = true;
      if (drag.moved) G.mapPan = { x: drag.pan.x - dx / G.mapCam.s, y: drag.pan.y + dy / G.mapCam.s };
    });
    view.addEventListener('pointerup', (e) => {
      if (!drag) return;
      if (!drag.moved) {
        const r = view.getBoundingClientRect();
        mapClick(e.clientX - r.left, e.clientY - r.top);
      }
      drag = null;
    });
    // pinch zoom for touch (two pointers) is handled by wheel on trackpads; add buttons below

    $('btnMap').addEventListener('click', () => setMapMode(!G.mapMode));
    $('btnWarpUp').addEventListener('click', () => G.changeWarp(1));
    $('btnWarpDown').addEventListener('click', () => G.changeWarp(-1));
    $('btnRecover').addEventListener('click', recover);
    $('btnMenu').addEventListener('click', menu);
    $('btnNodeWarp').addEventListener('click', G.warpToNode);
    $('btnNodeDel').addEventListener('click', G.deleteNode);
    document.querySelectorAll('#nodePanel .stepper button').forEach((b) =>
      b.addEventListener('click', () => editNode(b.dataset.k, parseFloat(b.dataset.d))));
    document.querySelectorAll('.sasbtn').forEach((b) =>
      b.addEventListener('click', () => {
        const ves = G.vessel;
        if (!ves) return;
        const m = b.dataset.mode;
        if (m === 'toggle') { ves.sas = !ves.sas; ves.sasTarget = ves.angle; }
        else { ves.sas = true; ves.sasMode = m; ves.sasTarget = ves.angle; }
        b.blur();
      }));
    document.querySelectorAll('.tbtn').forEach((b) => {
      const k = b.dataset.touch;
      if (k === 'stage') {
        b.addEventListener('click', () => { if (G.vessel && !G.vessel.dead) { const ev = G.vessel.stage(G); if (ev) toast('Stage ' + G.vessel.stageIdx, '', 1200); } });
        return;
      }
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); G.touch[k] = true; });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, () => (G.touch[k] = false)));
    });

    // Buttons should not keep keyboard focus in flight, or Space would press them.
    document.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('#flight button');
      if (b) b.blur();
    });

    $('version').textContent = 'v' + FS.VERSION;
    G.showScene('editor');
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
