// bodies.js — planets and moons: orbits on rails, rotation, terrain, atmosphere.
(function () {
  const TAU = FS.TAU;

  // Body definitions. Units: metres, seconds, m^3/s^2 for mu (= G·M).
  const defs = [
    {
      name: 'Aster', R: 600000, mu: 3.5316e12, parent: null,
      rotPeriod: -21549.425, rot0: 0, // negative = turns clockwise, so 'east' is to the right on screen
      atmo: { height: 70000, H: 5600, p0: 1.0, rho0: 1.225, color: [96, 160, 236] },
      ocean: true,
      terrain: { seed: 11, base: 5, octaves: 12, amp: 2600, persist: 0.52, bias: 350 },
      colors: { land: '#4f7a3a', landDeep: '#2d4626', rock: '#7c7a6b', sand: '#c9b77e', ocean: '#1f4f8f', oceanDeep: '#163a6c', disc: '#3d6fae', snow: '#e8eef2' },
      pad: { lon: 0.35, height: 72 },
      warpAlt: [0, 70000, 70000, 70000, 120000, 240000, 480000, 2000000, 6000000],
    },
    {
      name: 'Mira', R: 200000, mu: 6.5138398e10, parent: 'Aster',
      a: 12000000, phase0: 1.7, rot0: 0,
      atmo: null, ocean: false,
      terrain: { seed: 23, base: 6, octaves: 11, amp: 2400, persist: 0.5, bias: 0, craters: 70 },
      colors: { land: '#8d8b86', landDeep: '#4a4946', rock: '#9e9b94', disc: '#a9a6a0' },
      warpAlt: [0, 5000, 10000, 25000, 50000, 100000, 200000, 400000, 800000],
    },
    {
      name: 'Pell', R: 60000, mu: 1.7658e9, parent: 'Aster',
      a: 47000000, phase0: 0.9, rotPeriod: -40400, rot0: 0,
      atmo: null, ocean: false,
      terrain: { seed: 37, base: 4, octaves: 10, amp: 1600, persist: 0.5, bias: 300, flats: true },
      colors: { land: '#9fc7b8', landDeep: '#5f8a7c', rock: '#b8ddd0', disc: '#a8d4c4' },
      warpAlt: [0, 3000, 6000, 8000, 12000, 30000, 60000, 120000, 240000],
    },
  ];

  const bodies = defs.map((d) => Object.assign({}, d));
  const byName = {};
  bodies.forEach((b) => (byName[b.name] = b));
  bodies.forEach((b) => {
    b.parent = b.parent ? byName[b.parent] : null;
    b.children = [];
  });
  bodies.forEach((b) => {
    if (b.parent) {
      b.parent.children.push(b);
      // Everything in this system turns clockwise (negative angular rates), so
      // prograde/east points to the right of the screen when you launch.
      b.n = -Math.sqrt(b.parent.mu / (b.a * b.a * b.a)); // mean motion (rad/s)
      b.period = TAU / Math.abs(b.n);
      b.soi = b.a * Math.pow(b.mu / b.parent.mu, 0.4);
      if (!b.rotPeriod) b.rotPeriod = -b.period; // tidally locked
    } else {
      b.soi = Infinity;
    }
    b.omega = TAU / b.rotPeriod;
    // Craters: precomputed random bowls (angular centre, angular radius, depth)
    if (b.terrain.craters) {
      const r = FS.rng(b.terrain.seed * 977);
      b.craterList = [];
      for (let i = 0; i < b.terrain.craters; i++) {
        const rad = 0.004 + Math.pow(r(), 2.2) * 0.07;
        b.craterList.push({ lon: r() * TAU, rad, depth: rad * b.R * (0.05 + r() * 0.06) });
      }
    }
  });

  FS.bodies = bodies;
  FS.bodyByName = byName;
  FS.root = bodies.find((b) => !b.parent);

  // Position of a body relative to its parent at time t (circular orbit, CCW).
  FS.bodyPos = (b, t) => {
    if (!b.parent) return { x: 0, y: 0 };
    const ang = b.phase0 + b.n * t;
    return { x: Math.cos(ang) * b.a, y: Math.sin(ang) * b.a };
  };
  FS.bodyVel = (b, t) => {
    if (!b.parent) return { x: 0, y: 0 };
    const ang = b.phase0 + b.n * t;
    const s = b.a * b.n;
    return { x: -Math.sin(ang) * s, y: Math.cos(ang) * s };
  };
  // Absolute position (root frame).
  FS.bodyAbs = (b, t) => {
    let p = { x: 0, y: 0 };
    for (let c = b; c && c.parent; c = c.parent) p = FS.vec.add(p, FS.bodyPos(c, t));
    return p;
  };
  FS.bodyAbsVel = (b, t) => {
    let v = { x: 0, y: 0 };
    for (let c = b; c && c.parent; c = c.parent) v = FS.vec.add(v, FS.bodyVel(c, t));
    return v;
  };
  // Rotation angle of the body's surface at time t.
  FS.bodyRot = (b, t) => b.rot0 + b.omega * t;

  // ---- Terrain ----
  // Periodic 1D value noise: x in [0, period), wraps around the planet seamlessly.
  function noise1(x, period, seed) {
    const i0 = Math.floor(x);
    const f = x - i0;
    const a = FS.hash(((i0 % period) + period) % period, seed);
    const b = FS.hash((((i0 + 1) % period) + period) % period, seed);
    const t = f * f * (3 - 2 * f);
    return a + (b - a) * t;
  }

  // Height above datum (sea level) in metres for body-fixed longitude lon (radians).
  FS.terrainHeight = (b, lon) => {
    const T = b.terrain;
    let u = (lon / TAU) % 1;
    if (u < 0) u += 1;
    let h = 0, amp = T.amp, freq = T.base;
    for (let k = 0; k < T.octaves; k++) {
      // Ridged on the first octaves for mountain shapes, smooth for the rest
      let n = noise1(u * freq, freq, T.seed + k * 101) * 2 - 1;
      if (k === 1 || k === 2) n = (1 - Math.abs(n)) * 1.6 - 0.8;
      h += n * amp;
      amp *= T.persist;
      freq *= 2;
    }
    h += T.bias;
    if (T.flats && h < 0) h *= 0.12;
    if (b.craterList) {
      for (const c of b.craterList) {
        let d = Math.abs(FS.wrapAngle(lon - c.lon));
        if (d > c.rad * 1.6) continue;
        const x = d / c.rad;
        if (x < 1) h += c.depth * (x * x - 1);
        h += c.depth * 0.3 * Math.exp(-Math.pow((x - 1) / 0.22, 2));
      }
    }
    if (b.pad) {
      const d = Math.abs(FS.wrapAngle(lon - b.pad.lon));
      const w = FS.smoothstep(0.022, 0.006, d); // 1 near the pad, 0 far away
      h = FS.lerp(h, b.pad.height, w);
    }
    return h;
  };

  // Height of whatever you'd land on: ocean surface or ground.
  FS.surfaceHeight = (b, lon) => {
    const h = FS.terrainHeight(b, lon);
    return b.ocean ? Math.max(h, 0) : h;
  };

  // Longitude (body-fixed) under an inertial direction angle at time t.
  FS.lonAt = (b, inertialAngle, t) => FS.wrapAngle(inertialAngle - FS.bodyRot(b, t));

  // ---- Atmosphere ----
  // Pressure in atmospheres; reaches exactly 0 at the top of the atmosphere.
  FS.pressure = (b, alt) => {
    const A = b.atmo;
    if (!A || alt >= A.height) return 0;
    alt = Math.max(alt, -1000);
    const top = Math.exp(-A.height / A.H);
    return (A.p0 * (Math.exp(-alt / A.H) - top)) / (1 - top);
  };
  FS.density = (b, alt) => {
    const A = b.atmo;
    if (!A) return 0;
    return (FS.pressure(b, alt) / A.p0) * A.rho0;
  };

  // Velocity of the air (co-rotating atmosphere) at position r relative to the body.
  FS.airVel = (b, r) => ({ x: -b.omega * r.y, y: b.omega * r.x });

  // Highest time-warp level allowed at this altitude.
  FS.maxWarpIndex = (b, alt) => {
    let idx = 0;
    for (let i = 0; i < b.warpAlt.length; i++) if (alt >= b.warpAlt[i]) idx = i;
    return idx;
  };
})();
