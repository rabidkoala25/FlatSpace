// bodies.js — planets and moons: orbits on rails, rotation, terrain, atmosphere.
(function () {
  const FULL_TURN = FS.TAU;

  // Body definitions live in data/bodies.js.
  const defs = FS.DATA.bodies;

  const bodies = defs.map((bodyData) => Object.assign({}, bodyData));
  const byName = {};
  bodies.forEach((body) => (byName[body.name] = body));
  bodies.forEach((body) => {
    body.parent = body.parent ? byName[body.parent] : null;
    body.children = [];
  });
  bodies.forEach((body) => {
    if (body.parent) {
      body.parent.children.push(body);
      // Everything in this system turns clockwise (negative angular rates), so
      // prograde/east points to the right of the screen when you launch.
      body.n = -Math.sqrt(body.parent.mu / (body.a * body.a * body.a)); // mean motion (rad/s)
      body.period = FULL_TURN / Math.abs(body.n);
      body.soi = body.a * Math.pow(body.mu / body.parent.mu, 0.4);
      if (!body.rotPeriod) {
        body.rotPeriod = -body.period;
      } // tidally locked
    } else {
      body.soi = Infinity;
    }
    body.omega = FULL_TURN / body.rotPeriod;
    // Craters: precomputed random bowls (angular centre, angular radius, depth)
    if (body.terrain.craters) {
      const random = FS.rng(body.terrain.seed * 977);
      body.craterList = [];
      for (let craterNumber = 0; craterNumber < body.terrain.craters; craterNumber++) {
        const craterRadius = 0.004 + Math.pow(random(), 2.2) * 0.07;
        body.craterList.push({
          lon: random() * FULL_TURN,
          rad: craterRadius,
          depth: craterRadius * body.R * (0.05 + random() * 0.06),
        });
      }
    }
  });

  FS.bodies = bodies;
  FS.bodyByName = byName;
  FS.root = bodies.find((body) => !body.parent);

  // Position of a body relative to its parent at time t (circular orbit, CCW).
  FS.bodyPos = (body, time) => {
    if (!body.parent) {
      return { x: 0, y: 0 };
    }
    const angle = body.phase0 + body.n * time;
    return { x: Math.cos(angle) * body.a, y: Math.sin(angle) * body.a };
  };
  FS.bodyVel = (body, time) => {
    if (!body.parent) {
      return { x: 0, y: 0 };
    }
    const angle = body.phase0 + body.n * time;
    const speed = body.a * body.n;
    return { x: -Math.sin(angle) * speed, y: Math.cos(angle) * speed };
  };
  // Absolute position (root frame).
  FS.bodyAbs = (body, time) => {
    let position = { x: 0, y: 0 };
    for (let current = body; current && current.parent; current = current.parent) {
      position = FS.vec.add(position, FS.bodyPos(current, time));
    }
    return position;
  };
  FS.bodyAbsVel = (body, time) => {
    let velocity = { x: 0, y: 0 };
    for (let current = body; current && current.parent; current = current.parent) {
      velocity = FS.vec.add(velocity, FS.bodyVel(current, time));
    }
    return velocity;
  };
  // Rotation angle of the body's surface at time t.
  FS.bodyRot = (body, time) => body.rot0 + body.omega * time;

  // ---- Terrain ----
  // Periodic 1D value noise: x in [0, period), wraps around the planet seamlessly.
  function noise1(x, period, seed) {
    const cell = Math.floor(x);
    const fraction = x - cell;
    const leftValue = FS.hash(((cell % period) + period) % period, seed);
    const rightValue = FS.hash((((cell + 1) % period) + period) % period, seed);
    const smooth = fraction * fraction * (3 - 2 * fraction);
    return leftValue + (rightValue - leftValue) * smooth;
  }

  // Height above datum (sea level) in metres for body-fixed longitude lon (radians).
  FS.terrainHeight = (body, longitude) => {
    const terrain = body.terrain;
    let around = (longitude / FULL_TURN) % 1;
    if (around < 0) {
      around += 1;
    }
    let height = 0;
    let amplitude = terrain.amp;
    let freq = terrain.base;
    for (let octave = 0; octave < terrain.octaves; octave++) {
      // Ridged on the first octaves for mountain shapes, smooth for the rest
      let noise = noise1(around * freq, freq, terrain.seed + octave * 101) * 2 - 1;
      if (octave === 1 || octave === 2) {
        noise = (1 - Math.abs(noise)) * 1.6 - 0.8;
      }
      height += noise * amplitude;
      amplitude *= terrain.persist;
      freq *= 2;
    }
    height += terrain.bias;
    if (terrain.flats && height < 0) {
      height *= 0.12;
    }
    if (body.craterList) {
      for (const crater of body.craterList) {
        let distance = Math.abs(FS.wrapAngle(longitude - crater.lon));
        if (distance > crater.rad * 1.6) {
          continue;
        }
        const craterFraction = distance / crater.rad;
        if (craterFraction < 1) {
          height += crater.depth * (craterFraction * craterFraction - 1);
        }
        height += crater.depth * 0.3 * Math.exp(-Math.pow((craterFraction - 1) / 0.22, 2));
      }
    }
    if (body.pad) {
      const distance = Math.abs(FS.wrapAngle(longitude - body.pad.lon));
      const padWeight = FS.smoothstep(0.022, 0.006, distance); // 1 near the pad, 0 far away
      height = FS.lerp(height, body.pad.height, padWeight);
    }
    return height;
  };

  // Height of whatever you'd land on: ocean surface or ground.
  FS.surfaceHeight = (body, longitude) => {
    const height = FS.terrainHeight(body, longitude);
    return body.ocean ? Math.max(height, 0) : height;
  };

  // Longitude (body-fixed) under an inertial direction angle at time t.
  FS.lonAt = (body, inertialAngle, time) => FS.wrapAngle(inertialAngle - FS.bodyRot(body, time));

  // ---- Atmosphere ----
  // Pressure in atmospheres; reaches exactly 0 at the top of the atmosphere.
  FS.pressure = (body, altitude) => {
    const atmosphere = body.atmo;
    if (!atmosphere || altitude >= atmosphere.height) {
      return 0;
    }
    altitude = Math.max(altitude, -1000);
    const top = Math.exp(-atmosphere.height / atmosphere.H);
    return (atmosphere.p0 * (Math.exp(-altitude / atmosphere.H) - top)) / (1 - top);
  };
  FS.density = (body, altitude) => {
    const atmosphere = body.atmo;
    if (!atmosphere) {
      return 0;
    }
    return (FS.pressure(body, altitude) / atmosphere.p0) * atmosphere.rho0;
  };

  // Velocity of the air (co-rotating atmosphere) at position r relative to the body.
  FS.airVel = (body, position) => ({ x: -body.omega * position.y, y: body.omega * position.x });

  // Highest time-warp level allowed at this altitude.
  FS.maxWarpIndex = (body, altitude) => {
    let warpIndex = 0;
    for (let index = 0; index < body.warpAlt.length; index++) {
      if (altitude >= body.warpAlt[index]) {
        warpIndex = index;
      }
    }
    return warpIndex;
  };
})();
