// The part tree: craft files, off-centre thrust, side boosters, staging and separation.
const { loadGame, fakeGame, check, near, done } = require('./lib');
const Flatspace = loadGame();
const Vector = Flatspace.Vector;

// A craft placed in a circular 700 km orbit, so gravity and air don't get in the way.
function inOrbit(source) {
  const vessel = new Flatspace.Vessel('Test', source, Flatspace.root, {});
  const ORBIT_RADIUS = 700000;
  vessel.landed = null;
  vessel.position = { x: ORBIT_RADIUS, y: 0 };
  vessel.velocity = { x: 0, y: -Math.sqrt(Flatspace.root.gravityParameter / ORBIT_RADIUS) };
  vessel.angle = Math.PI / 2;
  vessel.stabilityAssist = false;
  return vessel;
}

// --- Saving and loading a tree keeps it exactly ---
{
  const twin = Flatspace.SAMPLE_CRAFT.find((craft) => craft.name === 'Twin Boosters').tree;
  const again = Flatspace.serialParts(Flatspace.partsFromSerial(twin));
  check(JSON.stringify(again) === JSON.stringify(twin), 'a saved part tree loads and saves back unchanged');
}

// --- Off-centre thrust turns the craft; a mirrored pair does not ---
{
  const straightStack = Flatspace.stackToParts(['sparrow', 't400', 'gnat']);
  Flatspace.attachPart(straightStack, 'gnat', straightStack[1], { x: 0.9, y: straightStack[1].position.y });
  const vessel = inOrbit(straightStack);
  for (const part of vessel.parts) {
    if (part.type.engine) {
      part.lit = true;
    }
  }
  vessel.throttle = 1;
  for (let step = 0; step < 50; step++) {
    vessel.step(0.02, step * 0.02, fakeGame());
  }
  check(
    vessel.angularVelocity > 0.01,
    `one side engine on the right turns the craft anticlockwise (spin ${vessel.angularVelocity.toFixed(3)} rad/s)`,
  );

  const secondStack = Flatspace.stackToParts(['sparrow', 't400', 'gnat']);
  Flatspace.attachPart(secondStack, 'gnat', secondStack[1], { x: 0.9, y: secondStack[1].position.y });
  Flatspace.attachPart(
    secondStack,
    'gnat',
    secondStack[1],
    { x: -0.9, y: secondStack[1].position.y },
    0,
    true,
  );
  const secondVessel = inOrbit(secondStack);
  for (const part of secondVessel.parts) {
    if (part.type.engine) {
      part.lit = true;
    }
  }
  secondVessel.throttle = 1;
  for (let step = 0; step < 50; step++) {
    secondVessel.step(0.02, step * 0.02, fakeGame());
  }
  near(
    secondVessel.angularVelocity,
    0,
    1e-9,
    'a mirrored pair of side engines pushes straight (spin, rad/s)',
  );
  check(
    secondVessel.thrustNow > 0 && vessel.thrustNow > 0,
    'side engines draw fuel from the tank they hang on',
  );
}

// --- On the ground, engines that turn the craft tip it over once they beat its weight ---
{
  // one engine pushing up on one side, one pushing down on the other: no lift, all turn
  const pinwheel = (engineId, offsetX = 1.3) => {
    const parts = Flatspace.stackToParts(['lark', 't800']);
    const tank = parts[1];
    Flatspace.attachPart(parts, engineId, tank, { x: offsetX, y: tank.position.y - 1 }, 0);
    Flatspace.attachPart(parts, engineId, tank, { x: -offsetX, y: tank.position.y + 1 }, Math.PI);
    const vessel = new Flatspace.Vessel('Pinwheel', Flatspace.serialParts(parts), Flatspace.root, {});
    vessel.placeOnPad(0);
    for (const part of vessel.parts) {
      if (part.type.engine) {
        part.lit = true;
      }
    }
    return vessel;
  };
  const game = fakeGame();
  const small = pinwheel('gnat', 0.95);
  small.throttle = 1;
  for (let step = 0; step < 100; step++) {
    small.step(0.02, step * 0.02, game);
  }
  check(
    small.landed && small.landed.relativeRotation === 0,
    `small engines can't tip it: its weight holds it on its base (turning effect ${(small.thrustTorque / 1000).toFixed(0)} kN·m)`,
  );

  const bigPinwheel = pinwheel('hornet');
  bigPinwheel.throttle = 0.12;
  let time = 0;
  let most = 0;
  const startAngle = bigPinwheel.angle;
  for (let step = 0; step < 300 && !bigPinwheel.dead; step++) {
    time += 0.02;
    bigPinwheel.step(0.02, time, game);
    most = Math.max(most, Math.abs(Flatspace.wrapAngle(bigPinwheel.angle - startAngle)));
  }
  check(
    !bigPinwheel.dead && !bigPinwheel.landed && most > 1,
    `bigger engines tip it and turn it over on the ground (turned ${((most * 180) / Math.PI).toFixed(0)}°)`,
  );
  bigPinwheel.throttle = 0;
  for (let step = 0; step < 400 && !bigPinwheel.dead && !bigPinwheel.landed; step++) {
    time += 0.02;
    bigPinwheel.step(0.02, time, game);
  }
  check(
    bigPinwheel.landed && Math.abs(bigPinwheel.landed.relativeRotation) > 0.3,
    `with the engines off it comes to rest where it fell (${(bigPinwheel.landed && (bigPinwheel.landed.relativeRotation * 180) / Math.PI).toFixed(0)}° from upright)`,
  );

  const hard = pinwheel('hornet');
  hard.throttle = 1;
  for (let step = 0; step < 150 && !hard.dead; step++) {
    hard.step(0.02, step * 0.02, game);
  }
  check(hard.dead, 'at full power it flips so hard that it smashes into the ground');
}

// --- Side boosters: staging order, Δv, and separation ---
{
  const twin = Flatspace.SAMPLE_CRAFT.find((craft) => craft.name === 'Twin Boosters').tree;
  const vessel = inOrbit(twin);
  const pattern = vessel.stages
    .map((stage) => (stage.chutes ? 'C' : (stage.decouple ? 'D' : '') + (stage.ignite ? 'I' : '')))
    .join(' ');
  check(
    pattern === 'I D DI D C',
    `boosters light with the core and drop first: "I D DI D C" (got "${pattern}")`,
  );
  check(vessel.stages[0].engines.length === 3, 'stage 1 lights the core engine and both boosters');
  check(vessel.stages[1].decouplers.length === 2, 'stage 2 fires both side decouplers');

  const stats = Flatspace.stageStats(vessel.parts, vessel.stages, 0, 0, 9.81);
  check(
    stats.events[0].deltaV > 500 && stats.events[1].deltaV > 500,
    `boosters and core both give Δv (${stats.events[0].deltaV.toFixed(0)} then ${stats.events[1].deltaV.toFixed(0)} m/s)`,
  );

  const game = fakeGame();
  vessel.stabilityAssist = true;
  vessel.stabilityAssistMode = 'stability';
  vessel.stabilityAssistTarget = vessel.angle;
  vessel.stage(game);
  vessel.throttle = 1;
  const boosters = vessel.parts.filter((part) => part.type.id === 'rumbler');
  let time = 0;
  while (boosters.some((booster) => booster.solid > 0) && time < 120) {
    vessel.step(0.02, time, game);
    time += 0.02;
  }
  check(
    boosters.every((booster) => booster.solid === 0),
    `boosters burn out (after ${time.toFixed(0)} s)`,
  );
  near(vessel.angularVelocity, 0, 0.01, 'symmetric boosters keep the craft steady (spin, rad/s)');

  const before = {
    parts: vessel.parts.length,
    position: { ...vessel.position },
    velocity: { ...vessel.velocity },
  };
  vessel.stage(game);
  check(game.debris.length === 2, 'staging drops both boosters as two pieces of debris');
  check(vessel.parts.length === before.parts - 4, 'the craft loses the two boosters and their decouplers');
  const [firstDebris, secondDebris] = game.debris;
  const side = (debrisVessel) =>
    Vector.dot(Vector.subtract(debrisVessel.position, vessel.position), vessel.side);
  check(
    side(firstDebris) * side(secondDebris) < 0 && Math.abs(side(firstDebris)) > 1,
    `the boosters fall away on opposite sides (${side(firstDebris).toFixed(2)} m and ${side(secondDebris).toFixed(2)} m)`,
  );
  check(
    game.debris.every(
      (debrisVessel) => Vector.length(Vector.subtract(debrisVessel.velocity, vessel.velocity)) < 3,
    ),
    'each booster leaves at a gentle separation speed',
  );
  check(
    game.debris.every(
      (debrisVessel) => Math.abs(Flatspace.wrapAngle(debrisVessel.angle - vessel.angle)) < 1e-9,
    ),
    "the boosters keep the craft's orientation",
  );
  check(
    Vector.length(Vector.subtract(vessel.position, before.position)) < 1,
    "the craft's centre of mass shifts only slightly",
  );

  // the next stage drops the core and lights the upper engine
  const stage = vessel.stage(game);
  check(
    stage.decouple &&
      stage.ignite &&
      game.debris.length === 3 &&
      vessel.parts.some((part) => part.type.id === 'wren' && part.lit),
    'the next stage drops the core and lights the upper stage',
  );
}

done();
