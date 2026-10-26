// Step A4: stretchable tanks, part settings, custom staging and craft files.
const { loadGame, fakeGame, check, near, done } = require('./lib');
const Flatspace = loadGame();
const Vector = Flatspace.Vector;
const deltaVOf = (parts) => Flatspace.stageStats(parts, Flatspace.stagesOf(parts), 0, 0, 9.81);

// --- Stretching scales mass, fuel and drag with volume ---
{
  const tank = Flatspace.newPart('t800', { length: 9 });
  near(tank.fuelCapacity, 9000, 1e-6, '9 m Ferro Long Tank holds 9 t of fuel');
  near(tank.dry, 1125, 1e-6, '…and weighs 1.125 t empty');
  const wide = Flatspace.newPart('t800', { length: 4, size: 2.5 });
  near(wide.fuelCapacity, 16000, 1e-6, 'doubling the width quadruples the fuel');
  near(wide.dragArea / Flatspace.PART.t800.dragArea, 4, 1e-9, '…and the front drag area');
  const oddTank = Flatspace.newPart('t800', { length: 3.1, size: 2 });
  check(
    oddTank.length === 3 && oddTank.size === 1.25,
    `lengths snap to 0.25 m (3.1 → ${oddTank.length}) and widths to the six sizes`,
  );
  // every preset uses the same density as the base tanks
  const allMatch = Flatspace.DATA.tankPresets.every((preset) => {
    const part = Flatspace.newPart(preset.base, { length: preset.length, size: preset.size });
    return (
      Math.abs(part.fuelCapacity - 640 * preset.length * preset.size * preset.size) < 1e-6 &&
      Math.abs(part.dry - part.fuelCapacity / 8) < 1e-6
    );
  });
  check(
    allMatch,
    `all ${Flatspace.DATA.tankPresets.length} tank presets hold 640 kg of fuel per m·m² and weigh an eighth of that empty`,
  );
  check(
    new Set(Flatspace.DATA.tankPresets.map((preset) => preset.size)).size === 6,
    'presets come in all six widths',
  );
  // a stack decoupler takes the width of a widened tank next to it
  const stack = Flatspace.stackToParts(['t800', 'decoupler', 't400']);
  stack[0].size = 2.5;
  Flatspace.applySize(stack[0]);
  stack[2].size = 2.5;
  Flatspace.applySize(stack[2]);
  Flatspace.relayout(stack);
  check(stack[1].width === 2.5, 'a decoupler between 2.5 m tanks is 2.5 m wide');
  // stack positions follow a stretched tank
  const secondStack = Flatspace.stackToParts(['lark', 't800', 'kestrel']);
  const startY = secondStack[2].position.y;
  secondStack[1].length = 9;
  Flatspace.applySize(secondStack[1]);
  Flatspace.relayout(secondStack);
  near(
    secondStack[2].position.y - startY,
    -5,
    1e-9,
    'the engine below a tank stretched by 5 m moves down 5 m',
  );
}

// --- Settings save and load ---
{
  const parts = Flatspace.stackToParts([
    'canopy',
    'lark',
    'decoupler',
    't400',
    'wren',
    'decoupler',
    't800',
    'kestrel',
  ]);
  Object.assign(parts[0], { chuteAltitude: 1500 });
  Object.assign(parts[2], { crossfeed: true });
  Object.assign(parts[3], { skin: 'gold', fill: 0.5 });
  Object.assign(parts[4], { limit: 0.6, gimbal: 0.25 });
  Object.assign(parts[6], { length: 9, size: 1.875, skin: 'roll' });
  parts.forEach((part) => Flatspace.applySize(part));
  Flatspace.relayout(parts);
  const serial = Flatspace.serialParts(parts);
  const again = Flatspace.partsFromSerial(serial);
  check(
    JSON.stringify(Flatspace.serialParts(again)) === JSON.stringify(serial),
    'every setting survives saving and loading',
  );
  check(
    again[6].length === 9 && again[6].size === 1.875 && again[6].skin === 'roll' && again[3].fuel === 1000,
    'stretched size, look and fuel level come back',
  );
  check(
    !('length' in serial[1]) && !('skin' in serial[1]),
    'unchanged settings are not written (small files)',
  );
}

// --- Thrust limit, fill level and crossfeed in the Δv maths ---
{
  const makeStack = () => Flatspace.stackToParts(['sparrow', 't400', 'gnat']);
  const full = deltaVOf(makeStack());
  const half = makeStack();
  half[2].limit = 0.5;
  const halfStats = deltaVOf(half);
  near(halfStats.total, full.total, 0.01, 'a 50% thrust limit keeps the Δv');
  near(halfStats.events[0].time / full.events[0].time, 2, 0.001, '…and doubles the burn time');
  const halfFull = makeStack();
  halfFull[1].fill = 0.5;
  Flatspace.applySize(halfFull[1]);
  check(
    deltaVOf(halfFull).total < full.total * 0.75 && deltaVOf(halfFull).total > 0,
    'a half-full tank gives less Δv',
  );
  // crossfeed joins fuel groups across a decoupler
  const crossfeedStack = Flatspace.stackToParts(['sparrow', 't400', 'decoupler', 't400', 'gnat']);
  check(Flatspace.flowGroups(crossfeedStack).length === 2, 'a decoupler splits the fuel');
  crossfeedStack[2].crossfeed = true;
  check(Flatspace.flowGroups(crossfeedStack).length === 1, 'with crossfeed on, fuel flows across it');
  // in flight, the limit halves the thrust
  const vessel = new Flatspace.Vessel('t', Flatspace.serialParts(half), Flatspace.root, { throttle: 1 });
  vessel.landed = null;
  vessel.position = { x: 800000, y: 0 };
  vessel.velocity = { x: 0, y: 0 };
  for (const part of vessel.parts) {
    if (part.type.engine) {
      part.lit = true;
    }
  }
  const thrust = vessel.runEngines(0, 0);
  near(
    thrust / Flatspace.PART.gnat.engine.vacuumThrust,
    0.5,
    1e-9,
    'in flight, a 50% limit gives half the thrust',
  );
}

// --- Custom staging ---
{
  const parts = Flatspace.stackToParts(
    Flatspace.SAMPLE_CRAFT.find((craft) => craft.name === 'Orbiter I').parts,
  );
  const auto = Flatspace.stagesOf(parts).map((stage) =>
    stage.parts
      .map((part) => part.type.id)
      .sort()
      .join('+'),
  );
  Flatspace.freezeStaging(parts);
  check(Flatspace.customStaging(parts), 'freezing turns staging custom');
  const frozen = Flatspace.stagesOf(parts).map((stage) =>
    stage.parts
      .map((part) => part.type.id)
      .sort()
      .join('+'),
  );
  check(
    JSON.stringify(auto) === JSON.stringify(frozen),
    `frozen staging fires exactly as automatic did (${frozen.join(' | ')})`,
  );
  // split "decouple + ignite Wren" into two stages
  const wren = parts.find((part) => part.type.id === 'wren');
  for (const part of parts) {
    if (part.stage > 1) {
      part.stage++;
    }
  }
  wren.stage = 2;
  const split = Flatspace.stagesOf(parts).map((stage) => stage.parts.map((part) => part.type.id).join('+'));
  check(
    split.join(' | ') === 'kestrel | decoupler | wren | decoupler | canopy',
    `stages can be split (${split.join(' | ')})`,
  );
  parts.find((part) => part.type.id === 'canopy').stage = -1;
  check(!Flatspace.stagesOf(parts).some((stage) => stage.chutes), 'a part can be left out of staging');
  check(
    Flatspace.customStages(parts, true).length === Flatspace.stagesOf(parts).length,
    'no empty stages in flight',
  );
  Flatspace.resetStaging(parts);
  check(
    !Flatspace.customStaging(parts) && Flatspace.stagesOf(parts).length === 4,
    'reset brings automatic staging back',
  );
}

// --- Parachute opening height ---
{
  const fall = (openAltitude) => {
    const game = fakeGame();
    const vessel = new Flatspace.Vessel('c', ['canopy', 'lark'], Flatspace.root, {});
    vessel.parts[0].chuteAltitude = openAltitude;
    vessel.landed = null;
    vessel.stabilityAssist = false;
    vessel.position = { x: Flatspace.root.radius + 6000, y: 0 };
    vessel.velocity = Flatspace.airVelocity(Flatspace.root, vessel.position);
    vessel.angle = 0;
    vessel.stage(game);
    let openedAt = null;
    for (let step = 0; step < 60000 && !vessel.landed && !vessel.dead; step++) {
      vessel.step(0.02, step * 0.02, game);
      if (!openedAt && vessel.parts[0].chute === 'full') {
        openedAt =
          vessel.altitude -
          Flatspace.surfaceHeight(
            Flatspace.root,
            Flatspace.longitudeAt(Flatspace.root, Vector.angle(vessel.position), step * 0.02),
          );
      }
    }
    return { at: openedAt, landed: !!vessel.landed && !vessel.dead };
  };
  const highOpen = fall(2500);
  const lowOpen = fall(1000);
  check(
    highOpen.at > 2300 && highOpen.at <= 2500 && lowOpen.at > 900 && lowOpen.at <= 1000,
    `the parachute opens fully at its set height (${highOpen.at.toFixed(0)} m and ${lowOpen.at.toFixed(0)} m)`,
  );
  check(highOpen.landed && lowOpen.landed, 'and the capsule lands safely either way');
}

// --- Craft files ---
{
  const parts = Flatspace.partsFromSerial(
    Flatspace.SAMPLE_CRAFT.find((craft) => craft.name === 'Twin Boosters').tree,
  );
  parts[6].length = 6;
  parts[6].skin = 'steel';
  Flatspace.applySize(parts[6]);
  Flatspace.relayout(parts);
  Flatspace.freezeStaging(parts);
  const text = Flatspace.craftToText('Steel Twins', parts);
  check(
    text.startsWith('FLATSPACE-CRAFT-1:') && !/\s/.test(text),
    'share text is one line with a clear prefix',
  );
  const back = Flatspace.craftFromText(text);
  check(
    back.name === 'Steel Twins' &&
      JSON.stringify(back.parts) === JSON.stringify(Flatspace.serialParts(parts)),
    'share text loads back exactly',
  );
  const json = Flatspace.craftFromText(Flatspace.craftToJSON('Steel Twins', parts));
  check(
    JSON.stringify(json.parts) === JSON.stringify(Flatspace.serialParts(parts)),
    'a craft file loads back exactly',
  );
  const oldCraft = Flatspace.craftFromText(
    JSON.stringify({
      format: 'flatspace-craft',
      version: 1,
      name: 'Old',
      parts: ['canopy', 'lark', 'thumper'],
    }),
  );
  check(
    oldCraft.parts && oldCraft.parts.length === 3 && oldCraft.parts[2].id === 'rumbler',
    'an old-format craft file is upgraded (stack list, renamed booster)',
  );
  const serial = Flatspace.serialParts(parts);
  serial[7].id = 'mystery'; // the lower tank: the boosters hang from it
  const partial = Flatspace.craftFromText(
    JSON.stringify({ format: 'flatspace-craft', version: 3, name: 'X', parts: serial }),
  );
  check(
    partial.skipped === 6 && partial.parts.every((serial) => serial.parent < partial.parts.length),
    `unknown parts are left out with everything attached to them (${partial.skipped} parts)`,
  );
  check(
    !!Flatspace.craftFromText('hello').error &&
      !!Flatspace.craftFromText('{"format":"flatspace-craft","version":99,"parts":[]}').error,
    'garbage and newer-version files give a clear error',
  );
}

// --- Done when: custom staging, a 9 m stretched tank and custom looks fly as configured ---
{
  const parts = Flatspace.stackToParts([
    'canopy',
    'lark',
    'decoupler',
    't400',
    'wren',
    'decoupler',
    't800',
    'fins',
    'hornet',
  ]);
  const bigTank = parts[6];
  bigTank.length = 9;
  bigTank.skin = 'roll';
  Flatspace.applySize(bigTank);
  parts[3].skin = 'gold';
  Flatspace.relayout(parts);
  Flatspace.freezeStaging(parts);
  const wren = parts[4];
  for (const part of parts) {
    if (part.stage > 1) {
      part.stage++;
    }
  }
  wren.stage = 2; // decouple, then light the upper stage separately
  const text = Flatspace.craftToText('Long Gold', parts);
  const loaded = Flatspace.craftFromText(text);
  const game = fakeGame();
  const vessel = new Flatspace.Vessel('Long Gold', loaded.parts, Flatspace.root, { throttle: 1 });
  check(
    vessel.parts[6].length === 9 &&
      vessel.parts[6].fuelCapacity === 9000 &&
      vessel.parts[6].skin === 'roll' &&
      vessel.parts[3].skin === 'gold',
    'the imported craft keeps its 9 m tank and its looks in flight',
  );
  check(
    vessel.stages.map((stage) => stage.parts.map((part) => part.type.id).join('+')).join(' | ') ===
      'hornet | decoupler | wren | decoupler | canopy',
    'and its custom staging',
  );
  let time = 0;
  vessel.placeOnPad(time);
  vessel.stage(game);
  let maxApoapsis = 0;
  let wrenLitAfterDecouple = null;
  for (let step = 0; step < 400 / 0.02 && !vessel.dead; step++) {
    const altitude = vessel.altitude;
    const pitch =
      altitude < 1000 ? 0 : Math.min((Math.PI / 2) * 0.95, ((altitude - 1000) / 45000) * (Math.PI / 2));
    vessel.stabilityAssistMode = 'stability';
    vessel.stabilityAssistTarget = Vector.angle(vessel.position) - pitch;
    vessel.step(0.02, time, game);
    time += 0.02;
    const orbit = Flatspace.orbitFromState(
      vessel.position,
      vessel.velocity,
      vessel.body.gravityParameter,
      time,
    );
    maxApoapsis = Math.max(maxApoapsis, orbit.apoapsis - Flatspace.root.radius);
    if (maxApoapsis > 85000) {
      vessel.throttle = 0;
    }
    if (vessel.thrustNow === 0 && vessel.stageIndex === 1) {
      vessel.stage(game); // decouple only
      wrenLitAfterDecouple = vessel.parts.find((part) => part.type.id === 'wren').lit;
      vessel.stage(game); // now light the Wren
    }
  }
  check(
    wrenLitAfterDecouple === false,
    'the decouple stage fires on its own, without lighting the upper stage',
  );
  check(
    maxApoapsis > 70000,
    `the craft flies as configured and reaches space (apoapsis ${(maxApoapsis / 1000).toFixed(0)} km)`,
  );
}

// --- Parts on a sloped face line up with it ---
{
  const Build = Flatspace.Build;
  let parts = Flatspace.stackToParts(['lark', 't400']);
  const lark = parts[0];
  const fin = Flatspace.newPart('sweptfin');
  Flatspace.relayout([fin]);
  fin.spin = 0;
  const spot = Vector.add(lark.position, { x: 0.7, y: 0 });
  Build.placeHeld([fin], fin, spot);
  const candidate = Build.candidate(parts, [fin], fin, spot, 1.7);
  const tilt = Math.atan2((lark.width - lark.topWidth) / 2, lark.length);
  check(
    candidate && candidate.kind === 'surface' && candidate.parent === lark,
    'a fin dropped beside the capsule goes on its sloped side',
  );
  near(
    (candidate.rotation * 180) / Math.PI,
    (tilt * 180) / Math.PI,
    1e-6,
    'it leans with the face (degrees)',
  );
  parts = Build.attach(parts, [fin], fin, candidate);
  // flush: the fin's inner edge lies along the face line
  const corners = Build.corners(fin).map((corner) =>
    Flatspace.rotateVector(Vector.subtract(corner, lark.position), -lark.rotation),
  );
  const faceNormal = { x: Math.cos(tilt), y: Math.sin(tilt) };
  const faceDistance = (corner) =>
    (corner.x -
      (lark.width / 2 + ((lark.topWidth - lark.width) / 2) * ((corner.y + lark.length / 2) / lark.length))) *
    Math.cos(tilt);
  const inner = Math.min(...corners.map(faceDistance));
  near(inner, 0, 1e-6, 'and sits flush on it, touching but not inside (m)');
}

// --- Floating parts: left out of the craft, or launched beside it ---
{
  const craft = Flatspace.stackToParts(['lark', 't400', 'hornet']);
  const extra = Flatspace.newPart('t100');
  extra.position = { x: 6, y: craft[1].position.y };
  extra.loose = 'keep';
  const all = craft.concat([extra]);
  Flatspace.relayout(all);
  const serial = Flatspace.serialParts(all);
  check(
    serial[3].parent === -1 && serial[3].loose === 'keep',
    'a floating part saves as its own tree, marked to launch',
  );
  const back = Flatspace.partsFromSerial(serial);
  check(back[3].loose === 'keep' && !back[3].parent, '…and loads back the same');
  const vessel = new Flatspace.Vessel('t', serial, Flatspace.root, {});
  check(vessel.parts.length === 3, 'a vessel built from the whole list flies only the craft proper');
  const game = Flatspace.game;
  game.newFlight({
    name: 'Float',
    parts: Flatspace.serialParts(craft),
    extras: [{ parts: Flatspace.serialParts([extra]) }],
  });
  const debrisVessel = game.debris[0];
  const layout = Flatspace.massLayout(craft);
  const want = Vector.subtract(extra.position, layout.centreOfMass);
  const offset = Vector.subtract(debrisVessel.position, game.vessel.position);
  check(
    game.debris.length === 1 && Math.abs(Vector.length(offset) - Vector.length(want)) < 1e-6,
    `a floating part set to launch appears beside the craft, ${Vector.length(offset).toFixed(2)} m from its centre of mass, as placed`,
  );
}

// --- In flight: using parts from their pop-up ---
{
  const game = fakeGame();
  const parts = Flatspace.stackToParts(['sparrow', 't400', 'decoupler', 't400', 'gnat']);
  const vessel = new Flatspace.Vessel('t', Flatspace.serialParts(parts), Flatspace.root, { throttle: 1 });
  vessel.landed = null;
  vessel.position = { x: 800000, y: 0 };
  vessel.velocity = { x: 0, y: 2000 };
  const gnat = vessel.parts[4];
  const decoupler = vessel.parts[2];
  check(vessel.act(gnat, 'ignite', game) && gnat.lit, 'an engine can be lit from its pop-up');
  check(vessel.runEngines(0, 0) > 0, '…and pushes');
  check(
    vessel.act(gnat, 'shutdown', game) && !gnat.lit && vessel.runEngines(0, 0) === 0,
    '…and shut down again',
  );
  const partCount = vessel.parts.length;
  check(
    vessel.act(decoupler, 'decouple', game) && vessel.parts.length < partCount && game.debris.length === 1,
    'a decoupler can be fired on its own, dropping what is below it',
  );
  check(!vessel.act(gnat, 'ignite', game), 'parts that left the craft can no longer be used from it');
}

done();
