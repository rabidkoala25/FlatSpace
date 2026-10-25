// Full flights: ascent to orbit, hopper with parachute landing, capsule reentry.
const { loadGame, fakeGame, check, done } = require('./lib');
const FS = loadGame();
const Vector = FS.vec;

// --- Ascent to orbit with a scripted gravity turn (Orbiter I) ---
{
  const game = fakeGame();
  const craft = FS.SAMPLE_CRAFT.find((craft) => craft.name === 'Orbiter I');
  const vessel = new FS.Vessel(craft.name, craft.parts, FS.root, { throttle: 1 });
  let time = 0;
  vessel.placeOnPad(time);
  vessel.stage(game);
  const timeStep = 0.02;
  let coasting = false;
  let circularizing = false;
  let reached = false;
  for (let step = 0; step < 600 / timeStep && !vessel.dead; step++) {
    const altitude = vessel.altitude;
    const upAngle = Vector.angle(vessel.r);
    const pitch =
      altitude < 1000 ? 0 : Math.min((Math.PI / 2) * 0.95, ((altitude - 1000) / 45000) * (Math.PI / 2));
    vessel.sasMode = 'stability';
    vessel.sasTarget = upAngle - pitch; // east is clockwise
    const orbit = FS.orbitFromState(vessel.r, vessel.v, vessel.body.mu, time);
    if (!coasting && orbit.ap - FS.root.R > 85000) {
      vessel.throttle = 0;
      coasting = true;
    }
    if (coasting && !circularizing) {
      vessel.sasTarget = Vector.angle(vessel.v);
      if (FS.timeToNu(orbit, Math.PI, time) < 25 && altitude > 70000) {
        vessel.throttle = 1;
        circularizing = true;
      }
    }
    if (circularizing && orbit.pe - FS.root.R > 75000) {
      vessel.throttle = 0;
      reached = true;
      break;
    }
    if (time > 1 && vessel.thrustNow === 0 && vessel.throttle > 0 && vessel.stageIdx < 2) {
      vessel.stage(game);
    }
    vessel.step(timeStep, time, game);
    for (const debrisVessel of game.debris) {
      debrisVessel.step(timeStep, time, game);
    }
    time += timeStep;
  }
  check(reached && !vessel.dead, 'Orbiter I reaches orbit with a scripted gravity turn');
  check(
    vessel.situation() === 'Orbiting Aster',
    `situation reads "Orbiting Aster" (got "${vessel.situation()}")`,
  );
  check(game.debris.length === 1, 'the first stage was dropped as debris');
}

// --- Hopper: straight up, parachute down ---
{
  const game = fakeGame();
  const craft = FS.SAMPLE_CRAFT.find((craft) => craft.name === 'Hopper');
  const vessel = new FS.Vessel(craft.name, craft.parts, FS.root, { throttle: 1 });
  let time = 0;
  let chute = false;
  vessel.placeOnPad(0);
  vessel.stage(game);
  vessel.sasMode = 'stability';
  vessel.sasTarget = Vector.angle(vessel.r) + 0.15;
  for (let step = 0; step < 200000; step++) {
    vessel.step(0.02, time, game);
    time += 0.02;
    if (vessel.dead || (vessel.landed && time > 10)) {
      break;
    }
    if (!chute && vessel.thrustNow === 0 && time > 5) {
      vessel.stage(game);
      chute = true;
      vessel.sas = false;
    }
  }
  check(
    vessel.stats.maxAlt > 1500,
    `Hopper hops above 1.5 km (got ${(vessel.stats.maxAlt / 1000).toFixed(1)} km)`,
  );
  check(!vessel.dead && !!vessel.landed, 'Hopper lands safely under its parachute');
}

// --- Capsule reentry from 80 km with a low periapsis ---
{
  const game = fakeGame();
  const vessel = new FS.Vessel('Capsule', ['canopy', 'lark'], FS.root, {});
  const startRadius = 680000;
  const semiMajorAxis = (startRadius + 625000) / 2;
  vessel.r = { x: startRadius, y: 0 };
  vessel.v = { x: 0, y: Math.sqrt(FS.root.mu * (2 / startRadius - 1 / semiMajorAxis)) };
  vessel.angle = Math.PI / 2 + 0.3;
  vessel.landed = null;
  vessel.sas = false;
  vessel.stage(game); // arm the parachute
  let time = 0;
  let maxHeat = 0;
  for (let step = 0; step < 400000 && !vessel.dead && !vessel.landed; step++) {
    vessel.step(0.02, time, game);
    time += 0.02;
    maxHeat = Math.max(maxHeat, vessel.heat);
  }
  check(maxHeat > 0.5, `reentry produces heating glow (peak ${maxHeat.toFixed(2)})`);
  check(!vessel.dead && !!vessel.landed, 'capsule survives reentry and lands');
}

// --- Twin Boosters: side boosters through the atmosphere, then to orbit ---
{
  const game = fakeGame();
  const vessel = new FS.Vessel(
    'Twin Boosters',
    FS.SAMPLE_CRAFT.find((craft) => craft.name === 'Twin Boosters').tree,
    FS.root,
    { throttle: 1 },
  );
  let time = 0;
  vessel.placeOnPad(time);
  vessel.stage(game);
  let coasting = false;
  let circularizing = false;
  let reached = false;
  const dropAlt = [];
  for (let step = 0; step < 700 / 0.02 && !vessel.dead; step++) {
    const altitude = vessel.altitude;
    const pitch =
      altitude < 1000 ? 0 : Math.min((Math.PI / 2) * 0.95, ((altitude - 1000) / 45000) * (Math.PI / 2));
    vessel.sasMode = 'stability';
    vessel.sasTarget = Vector.angle(vessel.r) - pitch;
    const orbit = FS.orbitFromState(vessel.r, vessel.v, vessel.body.mu, time);
    if (!coasting && orbit.ap - FS.root.R > 85000) {
      vessel.throttle = 0;
      coasting = true;
    }
    if (coasting && !circularizing) {
      vessel.sasTarget = Vector.angle(vessel.v);
      if (FS.timeToNu(orbit, Math.PI, time) < 25 && altitude > 70000) {
        vessel.throttle = 1;
        circularizing = true;
      }
    }
    if (circularizing && orbit.pe - FS.root.R > 75000) {
      vessel.throttle = 0;
      reached = true;
      break;
    }
    // stage once whatever the next stage drops has run dry
    const next = vessel.stages[vessel.stageIdx];
    if (
      time > 1 &&
      vessel.throttle > 0 &&
      next &&
      next.decouple &&
      next.decouplers.every((decoupler) =>
        FS.subtree(vessel.parts, decoupler).every((part) => part.fuel + part.solid < 1e-6),
      )
    ) {
      dropAlt.push(altitude);
      vessel.stage(game);
    }
    vessel.step(0.02, time, game);
    for (const debrisVessel of game.debris) {
      debrisVessel.step(0.02, time, game);
    }
    time += 0.02;
  }
  check(
    dropAlt.length >= 2 && dropAlt[0] < 15000,
    `boosters drop low in the atmosphere (${(dropAlt[0] / 1000).toFixed(1)} km), then the core`,
  );
  check(
    reached && !vessel.dead && vessel.situation() === 'Orbiting Aster',
    'Twin Boosters flies through the atmosphere and reaches orbit',
  );
}

done();
