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
//   'sphere-change' { vessel, from }         a craft moved into another body's sphere of influence
//   'message'      { text, kind, duration }       something the player should be told
(function () {
  const Vector = Flatspace.Vector;
  const STEP = 0.02; // physics step (s)

  const game = (Flatspace.game = {
    scene: 'editor',
    time: 0,
    launchTime: 0,
    vessel: null,
    debris: [],
    // view state, read by the renderer
    camera: { x: 0, y: 0, scale: 10, rotation: 0 },
    mapCamera: { x: 0, y: 0, scale: 1e-4, rotation: 0 },
    mapMode: false,
    mapFocus: 'vessel',
    mapPan: { x: 0, y: 0 },
    zoom: 1,
    // time warp (warp.js)
    warpIndex: 0,
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
    frame: { simulationStep: 0, rate: 1, physics: true, steps: 0 },
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
  game.message = (text, kind = '', duration = 3000) => game.emit('message', { text, kind, duration });

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
  game.on('sphere-change', ({ vessel }) => {
    if (vessel !== game.vessel) {
      return;
    }
    game.patchTimer = 0; // re-predict the path straight away
    if (game.warpIndex > game.allowedWarpIndex(vessel)) {
      game.warpIndex = game.allowedWarpIndex(vessel);
    }
  });

  game.addDebris = (debrisVessel) => {
    game.debris.push(debrisVessel);
    if (game.debris.length > 24) {
      game.debris.shift();
    }
    if (game.onRails && !debrisVessel.landed) {
      debrisVessel.goOnRails(game.time);
    }
  };

  // ---------- Starting a flight ----------
  game.newFlight = (craft) => {
    game.craft = craft;
    game.launchTime = game.time;
    const vessel = (game.vessel = new Flatspace.Vessel(craft.name, craft.parts, Flatspace.root, {
      throttle: 1,
    }));
    vessel.placeOnPad(game.time);
    vessel.visited = new Set();
    vessel.landings = [];
    game.debris = [];
    // floating parts set to launch with the craft appear where they were placed, relative to
    // it (as uncontrolled objects for now; D3 makes them vessels you can switch to)
    for (const extra of craft.extras || []) {
      const floatingVessel = new Flatspace.Vessel(craft.name + ' (floating)', extra.parts, vessel.body, {
        debris: true,
      });
      const offset = Vector.subtract(floatingVessel.layout.centreOfMass, vessel.layout.centreOfMass); // craft frame
      floatingVessel.position = Vector.add(vessel.position, vessel.toWorld(offset));
      floatingVessel.velocity = { ...vessel.velocity };
      floatingVessel.angle = vessel.angle;
      floatingVessel.landed = null;
      game.debris.push(floatingVessel);
    }
    game.node = null;
    game.nodePatches = null;
    game.patches = null;
    game.warpIndex = 0;
    game.warpTarget = null;
    game.onRails = false;
    game.zoom = 1;
    game.frame = { simulationStep: 0, rate: 1, physics: true, steps: 0 };
    game.emit('flight-start', { vessel });
    return vessel;
  };

  // Put the active craft in a circular orbit (used by the ?debug flag and the tests).
  game.debugOrbit = (altitude = 100000) => {
    const vessel = game.vessel;
    const body = Flatspace.root;
    const angle = Vector.angle(vessel.position);
    const orbitRadius = body.radius + altitude;
    const orbitalSpeed = Math.sqrt(body.gravityParameter / orbitRadius);
    vessel.landed = null;
    vessel.position = Vector.fromAngle(angle, orbitRadius);
    vessel.velocity = { x: Math.sin(angle) * orbitalSpeed, y: -Math.cos(angle) * orbitalSpeed }; // clockwise, like the planet's spin
    vessel.angle = Vector.angle(vessel.velocity);
    vessel.angularVelocity = 0;
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
        Vector.length(Vector.subtract(debrisVessel.position, vessel.position)) < 150000 &&
        debrisVessel.age < 900,
    );

    game.updateNode();

    // Trajectory prediction, a few times per second
    game.patchTimer -= timeStep;
    if (game.patchTimer <= 0) {
      game.patchTimer = 0.2;
      if (!vessel.dead && !vessel.landed) {
        game.patches = Flatspace.predictPatches(vessel.body, vessel.position, vessel.velocity, game.time, 3);
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
      vessel.step(substep, game.time, game);
      game.trackNodeBurn(substep);
      for (const debrisVessel of game.debris) {
        debrisVessel.step(substep, game.time, game);
      }
      game.time += substep;
      if (vessel.dead) {
        break;
      }
    }
    game.frame = { simulationStep: simTime, rate, physics: true, steps: substeps };
  }

  function stepRails(timeStep) {
    const vessel = game.vessel;
    if (!game.onRails) {
      vessel.goOnRails(game.time);
      for (const debrisVessel of game.debris) {
        if (!debrisVessel.landed) {
          debrisVessel.goOnRails(game.time);
        }
      }
      game.onRails = true;
    }
    const startTime = game.time;
    let newTime = game.time + timeStep * game.effectiveRate();
    if (game.warpTarget != null && newTime > game.warpTarget) {
      newTime = game.warpTarget;
    }
    // Sub-step so SOI changes are not skipped
    const maxSpeed = Vector.length(vessel.velocity) + 2000;
    const maxStep = Math.max(1, (0.08 * 2.2e6) / maxSpeed);
    while (game.time < newTime) {
      game.time = Math.min(newTime, game.time + maxStep);
      vessel.railsTo(game.time, game);
      for (const debrisVessel of game.debris) {
        railsDebris(debrisVessel);
      }
      // stop advancing as soon as we get too low for this warp rate
      if (!vessel.landed) {
        const body = vessel.body;
        if (
          (body.atmosphere && vessel.altitude < body.atmosphere.height) ||
          game.allowedWarpIndex(vessel) < game.warpIndex
        ) {
          break;
        }
      }
    }
    if (!vessel.landed) {
      const body = vessel.body;
      if (body.atmosphere && vessel.altitude < body.atmosphere.height) {
        game.stopWarp();
        game.message('Entering the atmosphere: time warp stopped.', '', 2500);
      } else if (game.warpIndex > game.allowedWarpIndex(vessel)) {
        game.warpIndex = game.allowedWarpIndex(vessel);
      }
    }
    game.frame = {
      simulationStep: game.time - startTime,
      rate: game.effectiveRate(),
      physics: false,
      steps: 'on rails',
    };
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
    debrisVessel.railsTo(game.time, game);
    const body = debrisVessel.body;
    if (body.atmosphere && debrisVessel.altitude < body.atmosphere.height) {
      debrisVessel.dead = true;
    } else if (
      debrisVessel.altitude <
      Flatspace.surfaceHeight(
        body,
        Flatspace.longitudeAt(body, Vector.angle(debrisVessel.position), game.time),
      )
    ) {
      debrisVessel.dead = true;
    }
  }
})();
