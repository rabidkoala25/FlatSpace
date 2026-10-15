// Full flights: ascent to orbit, hopper with parachute landing, capsule reentry.
const { loadGame, fakeGame, check, done } = require('./lib');
const FS = loadGame();
const V = FS.vec;

// --- Ascent to orbit with a scripted gravity turn (Orbiter I) ---
{
  const game = fakeGame();
  const craft = FS.SAMPLE_CRAFT.find((c) => c.name === 'Orbiter I');
  const v = new FS.Vessel(craft.name, craft.parts, FS.root, { throttle: 1 });
  let t = 0;
  v.placeOnPad(t);
  v.stage(game);
  const dt = 0.02;
  let coasting = false, circularizing = false, reached = false;
  for (let i = 0; i < 600 / dt && !v.dead; i++) {
    const alt = v.altitude;
    const up = V.angle(v.r);
    const pitch = alt < 1000 ? 0 : Math.min((Math.PI / 2) * 0.95, ((alt - 1000) / 45000) * (Math.PI / 2));
    v.sasMode = 'stability';
    v.sasTarget = up - pitch; // east is clockwise
    const o = FS.orbitFromState(v.r, v.v, v.body.mu, t);
    if (!coasting && o.ap - FS.root.R > 85000) { v.throttle = 0; coasting = true; }
    if (coasting && !circularizing) {
      v.sasTarget = V.angle(v.v);
      if (FS.timeToNu(o, Math.PI, t) < 25 && alt > 70000) { v.throttle = 1; circularizing = true; }
    }
    if (circularizing && o.pe - FS.root.R > 75000) { v.throttle = 0; reached = true; break; }
    if (t > 1 && v.thrustNow === 0 && v.throttle > 0 && v.stageIdx < 2) v.stage(game);
    v.step(dt, t, game);
    for (const d of game.debris) d.step(dt, t, game);
    t += dt;
  }
  check(reached && !v.dead, 'Orbiter I reaches orbit with a scripted gravity turn');
  check(v.situation() === 'Orbiting Aster', `situation reads "Orbiting Aster" (got "${v.situation()}")`);
  check(game.debris.length === 1, 'the first stage was dropped as debris');
}

// --- Hopper: straight up, parachute down ---
{
  const game = fakeGame();
  const craft = FS.SAMPLE_CRAFT.find((c) => c.name === 'Hopper');
  const v = new FS.Vessel(craft.name, craft.parts, FS.root, { throttle: 1 });
  let t = 0, chute = false;
  v.placeOnPad(0);
  v.stage(game);
  v.sasMode = 'stability';
  v.sasTarget = V.angle(v.r) + 0.15;
  for (let i = 0; i < 200000; i++) {
    v.step(0.02, t, game);
    t += 0.02;
    if (v.dead || (v.landed && t > 10)) break;
    if (!chute && v.thrustNow === 0 && t > 5) { v.stage(game); chute = true; v.sas = false; }
  }
  check(v.stats.maxAlt > 10000, `Hopper climbs above 10 km (got ${(v.stats.maxAlt / 1000).toFixed(1)} km)`);
  check(!v.dead && !!v.landed, 'Hopper lands safely under its parachute');
}

// --- Capsule reentry from 80 km with a low periapsis ---
{
  const game = fakeGame();
  const v = new FS.Vessel('Capsule', ['canopy', 'lark'], FS.root, {});
  const r = 680000;
  const a = (r + 625000) / 2;
  v.r = { x: r, y: 0 };
  v.v = { x: 0, y: Math.sqrt(FS.root.mu * (2 / r - 1 / a)) };
  v.angle = Math.PI / 2 + 0.3;
  v.landed = null;
  v.sas = false;
  v.stage(game); // arm the parachute
  let t = 0, maxHeat = 0;
  for (let i = 0; i < 400000 && !v.dead && !v.landed; i++) {
    v.step(0.02, t, game);
    t += 0.02;
    maxHeat = Math.max(maxHeat, v.heat);
  }
  check(maxHeat > 0.5, `reentry produces heating glow (peak ${maxHeat.toFixed(2)})`);
  check(!v.dead && !!v.landed, 'capsule survives reentry and lands');
}

done();
