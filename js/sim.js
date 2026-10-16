// sim.js — the flight simulation: game state, events, and stepping vessels and debris.
// Nothing here draws or touches the page. The renderer, HUD and main.js read this state
// and listen to its events, which keeps the physics replaceable (step C1) and lets the
// tests run it in Node.
//
// Events (G.on(type, fn) to listen, G.emit(type, data) to send):
//   'flight-start' { vessel }               a new flight began
//   'staged'       { vessel, event, dropped } a stage fired; dropped lists the vessels that came off
//   'touchdown'    { vessel, water }        a craft came to rest on ground or water
//   'exploded'     { vessel }               a craft (or debris) was destroyed
//   'soi'          { vessel, from }         a craft moved into another body's sphere of influence
//   'message'      { text, kind, ms }       something the player should be told
(function () {
  const V = FS.vec;
  const STEP = 0.02; // physics step (s)

  const G = (FS.game = {
    scene: 'editor',
    t: 0,
    launchT: 0,
    vessel: null,
    debris: [],
    // view state, read by the renderer
    cam: { x: 0, y: 0, s: 10, rot: 0 },
    mapCam: { x: 0, y: 0, s: 1e-4, rot: 0 },
    mapMode: false,
    mapFocus: 'vessel',
    mapPan: { x: 0, y: 0 },
    zoom: 1,
    // time warp (warp.js)
    warpIdx: 0,
    warpTarget: null,
    onRails: false,
    // maneuver nodes and predicted path (nodes.js)
    node: null,
    patches: null,
    nodePatches: null,
    patchTimer: 0,
    // held keys and touch buttons (input.js)
    keys: {},
    touch: {},
    // what the last update did: simulated seconds, warp rate, physics or rails, steps
    frame: { simDt: 0, rate: 1, physics: true, steps: 0 },
  });

  // ---------- Events ----------
  const handlers = {};
  G.on = (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); };
  G.emit = (type, data) => { for (const fn of handlers[type] || []) fn(data); };
  G.message = (text, kind = '', ms = 3000) => G.emit('message', { text, kind, ms });

  // The simulation's own reactions come first, before any page code listens.
  G.on('staged', ({ dropped }) => dropped.forEach(G.addDebris));
  G.on('exploded', ({ vessel }) => { if (vessel === G.vessel) G.stopWarp(); });
  G.on('touchdown', ({ vessel }) => {
    if (vessel !== G.vessel) return;
    G.stopWarp();
    vessel.throttle = 0;
  });
  G.on('soi', ({ vessel }) => {
    if (vessel !== G.vessel) return;
    G.patchTimer = 0; // re-predict the path straight away
    if (G.warpIdx > G.allowedWarpIdx(vessel)) G.warpIdx = G.allowedWarpIdx(vessel);
  });

  G.addDebris = (d) => {
    G.debris.push(d);
    if (G.debris.length > 24) G.debris.shift();
    if (G.onRails && !d.landed) d.goOnRails(G.t);
  };

  // ---------- Starting a flight ----------
  G.newFlight = (craft) => {
    G.craft = craft;
    G.launchT = G.t;
    const v = (G.vessel = new FS.Vessel(craft.name, craft.parts, FS.root, { throttle: 1 }));
    v.placeOnPad(G.t);
    v.visited = new Set();
    v.landings = [];
    G.debris = [];
    G.node = null;
    G.nodePatches = null;
    G.patches = null;
    G.warpIdx = 0;
    G.warpTarget = null;
    G.onRails = false;
    G.zoom = 1;
    G.frame = { simDt: 0, rate: 1, physics: true, steps: 0 };
    G.emit('flight-start', { vessel: v });
    return v;
  };

  // Put the active craft in a circular orbit (used by the ?debug flag and the tests).
  G.debugOrbit = (alt = 100000) => {
    const v = G.vessel, b = FS.root;
    const ang = V.angle(v.r);
    const r = b.R + alt;
    const sp = Math.sqrt(b.mu / r);
    v.landed = null;
    v.r = V.fromAngle(ang, r);
    v.v = { x: Math.sin(ang) * sp, y: -Math.cos(ang) * sp }; // clockwise, like the planet's spin
    v.angle = V.angle(v.v);
    v.omega = 0;
    v.throttle = 0;
    v.stats.launched = true;
    G.patchTimer = 0;
  };

  // ---------- Stepping ----------
  // Advance the simulation by dt seconds of real time (scaled by time warp).
  G.update = (dt) => {
    const ves = G.vessel;
    if (!ves) return;
    G.updateWarpTarget();
    if (G.useRails()) stepRails(dt); else stepPhysics(dt);

    // Forget debris that is gone, far away, or around another body.
    G.debris = G.debris.filter((d) => !d.dead && d.body === ves.body && V.len(V.sub(d.r, ves.r)) < 150000 && d.age < 900);

    G.updateNode();

    // Trajectory prediction, a few times per second
    G.patchTimer -= dt;
    if (G.patchTimer <= 0) {
      G.patchTimer = 0.2;
      if (!ves.dead && !ves.landed) {
        G.patches = FS.predictPatches(ves.body, ves.r, ves.v, G.t, 3);
        if (G.node) G.refreshNode(false);
      } else G.patches = null;
    }
  };

  function stepPhysics(dt) {
    const ves = G.vessel;
    if (G.onRails) {
      ves.offRails();
      for (const d of G.debris) d.offRails();
      G.onRails = false;
    }
    const rate = G.effectiveRate();
    const sim = dt * rate;
    const n = Math.max(1, Math.ceil(sim / STEP));
    const h = sim / n;
    for (let i = 0; i < n; i++) {
      ves.step(h, G.t, G);
      G.trackNodeBurn(h);
      for (const d of G.debris) d.step(h, G.t, G);
      G.t += h;
      if (ves.dead) break;
    }
    G.frame = { simDt: sim, rate, physics: true, steps: n };
  }

  function stepRails(dt) {
    const ves = G.vessel;
    if (!G.onRails) {
      ves.goOnRails(G.t);
      for (const d of G.debris) if (!d.landed) d.goOnRails(G.t);
      G.onRails = true;
    }
    const t0 = G.t;
    let tNew = G.t + dt * G.effectiveRate();
    if (G.warpTarget != null && tNew > G.warpTarget) tNew = G.warpTarget;
    // Sub-step so SOI changes are not skipped
    const vmax = V.len(ves.v) + 2000;
    const maxStep = Math.max(1, (0.08 * 2.2e6) / vmax);
    while (G.t < tNew) {
      G.t = Math.min(tNew, G.t + maxStep);
      ves.railsTo(G.t, G);
      for (const d of G.debris) railsDebris(d);
      // stop advancing as soon as we get too low for this warp rate
      if (!ves.landed) {
        const b = ves.body;
        if ((b.atmo && ves.altitude < b.atmo.height) || G.allowedWarpIdx(ves) < G.warpIdx) break;
      }
    }
    if (!ves.landed) {
      const b = ves.body;
      if (b.atmo && ves.altitude < b.atmo.height) { G.stopWarp(); G.message('Entering the atmosphere: time warp stopped.', '', 2500); }
      else if (G.warpIdx > G.allowedWarpIdx(ves)) G.warpIdx = G.allowedWarpIdx(ves);
    }
    G.frame = { simDt: G.t - t0, rate: G.effectiveRate(), physics: false, steps: 'on rails' };
    if (!G.useRails()) {
      ves.offRails();
      for (const d of G.debris) d.offRails();
      G.onRails = false;
    }
  }

  // Debris keeps moving on rails. Like unwatched craft in KSP, debris that sinks into
  // the atmosphere or reaches the ground while on rails is removed rather than simulated.
  function railsDebris(d) {
    if (d.dead || d.landed) return;
    d.railsTo(G.t, G);
    const b = d.body;
    if (b.atmo && d.altitude < b.atmo.height) d.dead = true;
    else if (d.altitude < FS.surfaceHeight(b, FS.lonAt(b, V.angle(d.r), G.t))) d.dead = true;
  }
})();
