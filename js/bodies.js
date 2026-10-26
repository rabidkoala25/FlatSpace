// bodies.js — planets and moons: orbits on rails, rotation, terrain, atmosphere.
(function () {
  const FULL_TURN = Flatspace.TAU;

  // Body definitions live in data/bodies.js.
  const bodyDefinitions = Flatspace.DATA.bodies;

  const bodies = bodyDefinitions.map((bodyData) => Object.assign({}, bodyData));
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
      body.meanMotion = -Math.sqrt(
        body.parent.gravityParameter / (body.semiMajorAxis * body.semiMajorAxis * body.semiMajorAxis),
      ); // mean motion (rad/s)
      body.period = FULL_TURN / Math.abs(body.meanMotion);
      body.sphereOfInfluence =
        body.semiMajorAxis * Math.pow(body.gravityParameter / body.parent.gravityParameter, 0.4);
      if (!body.rotationPeriod) {
        body.rotationPeriod = -body.period;
      } // tidally locked
    } else {
      body.sphereOfInfluence = Infinity;
    }
    body.angularVelocity = FULL_TURN / body.rotationPeriod;
    // Craters: precomputed random bowls (angular centre, angular radius, depth)
    if (body.terrain.craters) {
      const random = Flatspace.seededRandom(body.terrain.seed * 977);
      body.craterList = [];
      for (let craterNumber = 0; craterNumber < body.terrain.craters; craterNumber++) {
        const craterRadius = 0.004 + Math.pow(random(), 2.2) * 0.07;
        body.craterList.push({
          longitude: random() * FULL_TURN,
          radius: craterRadius,
          depth: craterRadius * body.radius * (0.05 + random() * 0.06),
        });
      }
    }
  });

  Flatspace.bodies = bodies;
  Flatspace.bodyByName = byName;
  Flatspace.root = bodies.find((body) => !body.parent);

  // Position of a body relative to its parent at a given time (circular orbit, counter-clockwise).
  Flatspace.bodyPosition = (body, time) => {
    if (!body.parent) {
      return { x: 0, y: 0 };
    }
    const angle = body.startPhase + body.meanMotion * time;
    return { x: Math.cos(angle) * body.semiMajorAxis, y: Math.sin(angle) * body.semiMajorAxis };
  };
  Flatspace.bodyVelocity = (body, time) => {
    if (!body.parent) {
      return { x: 0, y: 0 };
    }
    const angle = body.startPhase + body.meanMotion * time;
    const speed = body.semiMajorAxis * body.meanMotion;
    return { x: -Math.sin(angle) * speed, y: Math.cos(angle) * speed };
  };
  // Absolute position (root frame).
  Flatspace.bodyAbsolutePosition = (body, time) => {
    let position = { x: 0, y: 0 };
    for (let current = body; current && current.parent; current = current.parent) {
      position = Flatspace.Vector.add(position, Flatspace.bodyPosition(current, time));
    }
    return position;
  };
  Flatspace.bodyAbsoluteVelocity = (body, time) => {
    let velocity = { x: 0, y: 0 };
    for (let current = body; current && current.parent; current = current.parent) {
      velocity = Flatspace.Vector.add(velocity, Flatspace.bodyVelocity(current, time));
    }
    return velocity;
  };
  // Rotation angle of the body's surface at a given time.
  Flatspace.bodyRotation = (body, time) => body.startRotation + body.angularVelocity * time;

  // ---- Terrain ----
  // Periodic 1D value noise: x in [0, period), wraps around the planet seamlessly.
  function noise1(x, period, seed) {
    const cell = Math.floor(x);
    const fraction = x - cell;
    const leftValue = Flatspace.hash(((cell % period) + period) % period, seed);
    const rightValue = Flatspace.hash((((cell + 1) % period) + period) % period, seed);
    const smooth = fraction * fraction * (3 - 2 * fraction);
    return leftValue + (rightValue - leftValue) * smooth;
  }

  // Height above datum (sea level) in metres for body-fixed longitude lon (radians).
  Flatspace.terrainHeight = (body, longitude) => {
    const terrain = body.terrain;
    let around = (longitude / FULL_TURN) % 1;
    if (around < 0) {
      around += 1;
    }
    let height = 0;
    let amplitude = terrain.amplitude;
    let frequency = terrain.base;
    for (let octave = 0; octave < terrain.octaves; octave++) {
      // Ridged on the first octaves for mountain shapes, smooth for the rest
      let noise = noise1(around * frequency, frequency, terrain.seed + octave * 101) * 2 - 1;
      if (octave === 1 || octave === 2) {
        noise = (1 - Math.abs(noise)) * 1.6 - 0.8;
      }
      height += noise * amplitude;
      amplitude *= terrain.persist;
      frequency *= 2;
    }
    height += terrain.bias;
    if (terrain.flats && height < 0) {
      height *= 0.12;
    }
    if (body.craterList) {
      for (const crater of body.craterList) {
        let distance = Math.abs(Flatspace.wrapAngle(longitude - crater.longitude));
        if (distance > crater.radius * 1.6) {
          continue;
        }
        const craterFraction = distance / crater.radius;
        if (craterFraction < 1) {
          height += crater.depth * (craterFraction * craterFraction - 1);
        }
        height += crater.depth * 0.3 * Math.exp(-Math.pow((craterFraction - 1) / 0.22, 2));
      }
    }
    if (body.launchPad) {
      const distance = Math.abs(Flatspace.wrapAngle(longitude - body.launchPad.longitude));
      const launchPadWeight = Flatspace.smoothstep(0.022, 0.006, distance); // 1 near the pad, 0 far away
      height = Flatspace.interpolate(height, body.launchPad.height, launchPadWeight);
    }
    return height;
  };

  // Height of whatever you'd land on: ocean surface or ground.
  Flatspace.surfaceHeight = (body, longitude) => {
    const height = Flatspace.terrainHeight(body, longitude);
    return body.ocean ? Math.max(height, 0) : height;
  };

  // Longitude (body-fixed) under an inertial direction angle at a given time.
  Flatspace.longitudeAt = (body, inertialAngle, time) =>
    Flatspace.wrapAngle(inertialAngle - Flatspace.bodyRotation(body, time));

  // ---- Atmosphere ----
  // Pressure in atmospheres; reaches exactly 0 at the top of the atmosphere.
  Flatspace.pressure = (body, altitude) => {
    const atmosphere = body.atmosphere;
    if (!atmosphere || altitude >= atmosphere.height) {
      return 0;
    }
    altitude = Math.max(altitude, -1000);
    const top = Math.exp(-atmosphere.height / atmosphere.scaleHeight);
    return (atmosphere.seaLevelPressure * (Math.exp(-altitude / atmosphere.scaleHeight) - top)) / (1 - top);
  };
  Flatspace.density = (body, altitude) => {
    const atmosphere = body.atmosphere;
    if (!atmosphere) {
      return 0;
    }
    return (Flatspace.pressure(body, altitude) / atmosphere.seaLevelPressure) * atmosphere.seaLevelDensity;
  };

  // Velocity of the air (co-rotating atmosphere) at a position relative to the body.
  Flatspace.airVelocity = (body, position) => ({
    x: -body.angularVelocity * position.y,
    y: body.angularVelocity * position.x,
  });

  // Highest time-warp level allowed at this altitude.
  Flatspace.maxWarpIndex = (body, altitude) => {
    let warpIndex = 0;
    for (let index = 0; index < body.warpAltitude.length; index++) {
      if (altitude >= body.warpAltitude[index]) {
        warpIndex = index;
      }
    }
    return warpIndex;
  };
})();
