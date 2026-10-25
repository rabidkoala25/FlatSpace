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
  const Vector = FS.vec;
  const STEP = 0.02; // physics step (s)

  const game = (FS.game = {
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
  game.on = (type, handler) => {
    (handlers[type] = handlers[type] || []).push(handler);
  };
  game.emit = (type, data) => {
    for (const handler of handlers[type] || []) {
      handler(data);
    }
  };
  game.message = (text, kind = '', duration = 3000) => game.emit('message', { text, kind, ms: duration });

  // The simulation's own reactions come first, before any page code listens.
  game.on('staged', ({ dropped }) => dropped.forEach(game.addDebris));
  game.on('part-action', ({ dropped }) => dropped.forEach(game.addDebris));
  game.on('exploded', ({ vessel }) => {
    if (vessel === game.vessel) {
      game.stopWarp();
    }
  });
  game.on('touchdown', ({ vessel }) => {
    if (vessel !== game.vessel) {
      return;
    }
    game.stopWarp();
    vessel.throttle = 0;
  });
  game.on('soi', ({ vessel }) => {
    if (vessel !== game.vessel) {
      return;
    }
    game.patchTimer = 0; // re-predict the path straight away
    if (game.warpIdx > game.allowedWarpIdx(vessel)) {
      game.warpIdx = game.allowedWarpIdx(vessel);
    }
  });

  game.addDebris = (debrisVessel) => {
    game.debris.push(debrisVessel);
    if (game.debris.length > 24) {
      game.debris.shift();
    }
    if (game.onRails && !debrisVessel.landed) {
      debrisVessel.goOnRails(game.t);
    }
  };

  // ---------- Starting a flight ----------
  game.newFlight = (craft) => {
    game.craft = craft;
    game.launchT = game.t;
    const vessel = (game.vessel = new FS.Vessel(craft.name, craft.parts, FS.root, { throttle: 1 }));
    vessel.placeOnPad(game.t);
    vessel.visited = new Set();
    vessel.landings = [];
    game.debris = [];
    // floating parts set to launch with the craft appear where they were placed, relative to
    // it (as uncontrolled objects for now; D3 makes them vessels you can switch to)
    for (const extra of craft.extras || []) {
      const floatingVessel = new FS.Vessel(craft.name + ' (floating)', extra.parts, vessel.body, {
        debris: true,
      });
      const offset = Vector.sub(floatingVessel.layout.com, vessel.layout.com); // craft frame
      floatingVessel.r = Vector.add(vessel.r, vessel.toWorld(offset));
      floatingVessel.v = { ...vessel.v };
      floatingVessel.angle = vessel.angle;
      floatingVessel.landed = null;
      game.debris.push(floatingVessel);
    }
    game.node = null;
    game.nodePatches = null;
    game.patches = null;
    game.warpIdx = 0;
    game.warpTarget = null;
    game.onRails = false;
    game.zoom = 1;
    game.frame = { simDt: 0, rate: 1, physics: true, steps: 0 };
    game.emit('flight-start', { vessel: vessel });
    return vessel;
  };

  // Put the active craft in a circular orbit (used by the ?debug flag and the tests).
  game.debugOrbit = (altitude = 100000) => {
    const vessel = game.vessel;
    const body = FS.root;
    const angle = Vector.angle(vessel.r);
    const orbitRadius = body.R + altitude;
    const orbitalSpeed = Math.sqrt(body.mu / orbitRadius);
    vessel.landed = null;
    vessel.r = Vector.fromAngle(angle, orbitRadius);
    vessel.v = { x: Math.sin(angle) * orbitalSpeed, y: -Math.cos(angle) * orbitalSpeed }; // clockwise, like the planet's spin
    vessel.angle = Vector.angle(vessel.v);
    vessel.omega = 0;
    vessel.throttle = 0;
    vessel.stats.launched = true;
    game.patchTimer = 0;
  };

  // ---------- Stepping ----------
  // Advance the simulation by dt seconds of real time (scaled by time warp).
  game.update = (timeStep) => {
    const vessel = game.vessel;
    if (!vessel) {
      return;
    }
    game.updateWarpTarget();
    if (game.useRails()) {
      stepRails(timeStep);
    } else {
      stepPhysics(timeStep);
    }

    // Forget debris that is gone, far away, or around another body.
    game.debris = game.debris.filter(
      (debrisVessel) =>
        !debrisVessel.dead &&
        debrisVessel.body === vessel.body &&
        Vector.len(Vector.sub(debrisVessel.r, vessel.r)) < 150000 &&
        debrisVessel.age < 900,
    );

    game.updateNode();

    // Trajectory prediction, a few times per second
    game.patchTimer -= timeStep;
    if (game.patchTimer <= 0) {
      game.patchTimer = 0.2;
      if (!vessel.dead && !vessel.landed) {
        game.patches = FS.predictPatches(vessel.body, vessel.r, vessel.v, game.t, 3);
        if (game.node) {
          game.refreshNode(false);
        }
      } else {
        game.patches = null;
      }
    }
  };

  function stepPhysics(timeStep) {
    const vessel = game.vessel;
    if (game.onRails) {
      vessel.offRails();
      for (const debrisVessel of game.debris) {
        debrisVessel.offRails();
      }
      game.onRails = false;
    }
    const rate = game.effectiveRate();
    const simTime = timeStep * rate;
    const substeps = Math.max(1, Math.ceil(simTime / STEP));
    const substep = simTime / substeps;
    for (let stepNumber = 0; stepNumber < substeps; stepNumber++) {
      vessel.step(substep, game.t, game);
      game.trackNodeBurn(substep);
      for (const debrisVessel of game.debris) {
        debrisVessel.step(substep, game.t, game);
      }
      game.t += substep;
      if (vessel.dead) {
        break;
      }
    }
    game.frame = { simDt: simTime, rate, physics: true, steps: substeps };
  }

  function stepRails(timeStep) {
    const vessel = game.vessel;
    if (!game.onRails) {
      vessel.goOnRails(game.t);
      for (const debrisVessel of game.debris) {
        if (!debrisVessel.landed) {
          debrisVessel.goOnRails(game.t);
        }
      }
      game.onRails = true;
    }
    const startTime = game.t;
    let tNew = game.t + timeStep * game.effectiveRate();
    if (game.warpTarget != null && tNew > game.warpTarget) {
      tNew = game.warpTarget;
    }
    // Sub-step so SOI changes are not skipped
    const vmax = Vector.len(vessel.v) + 2000;
    const maxStep = Math.max(1, (0.08 * 2.2e6) / vmax);
    while (game.t < tNew) {
      game.t = Math.min(tNew, game.t + maxStep);
      vessel.railsTo(game.t, game);
      for (const debrisVessel of game.debris) {
        railsDebris(debrisVessel);
      }
      // stop advancing as soon as we get too low for this warp rate
      if (!vessel.landed) {
        const body = vessel.body;
        if ((body.atmo && vessel.altitude < body.atmo.height) || game.allowedWarpIdx(vessel) < game.warpIdx) {
          break;
        }
      }
    }
    if (!vessel.landed) {
      const body = vessel.body;
      if (body.atmo && vessel.altitude < body.atmo.height) {
        game.stopWarp();
        game.message('Entering the atmosphere: time warp stopped.', '', 2500);
      } else if (game.warpIdx > game.allowedWarpIdx(vessel)) {
        game.warpIdx = game.allowedWarpIdx(vessel);
      }
    }
    game.frame = { simDt: game.t - startTime, rate: game.effectiveRate(), physics: false, steps: 'on rails' };
    if (!game.useRails()) {
      vessel.offRails();
      for (const debrisVessel of game.debris) {
        debrisVessel.offRails();
      }
      game.onRails = false;
    }
  }

  // Debris keeps moving on rails. Like unwatched craft in KSP, debris that sinks into
  // the atmosphere or reaches the ground while on rails is removed rather than simulated.
  function railsDebris(debrisVessel) {
    if (debrisVessel.dead || debrisVessel.landed) {
      return;
    }
    debrisVessel.railsTo(game.t, game);
    const body = debrisVessel.body;
    if (body.atmo && debrisVessel.altitude < body.atmo.height) {
      debrisVessel.dead = true;
    } else if (
      debrisVessel.altitude < FS.surfaceHeight(body, FS.lonAt(body, Vector.angle(debrisVessel.r), game.t))
    ) {
      debrisVessel.dead = true;
    }
  }
})();
