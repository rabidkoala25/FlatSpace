// Step A4: stretchable tanks, part settings, custom staging and craft files.
const { loadGame, fakeGame, check, near, done } = require('./lib');
const FS = loadGame();
const Vector = FS.vec;
const dvOf = (parts) => FS.stageStats(parts, FS.stagesOf(parts), 0, 0, 9.81);

// --- Stretching scales mass, fuel and drag with volume ---
{
  const tank = FS.newPart('t800', { len: 9 });
  near(tank.cap, 9000, 1e-6, '9 m Ferro Long Tank holds 9 t of fuel');
  near(tank.dry, 1125, 1e-6, '…and weighs 1.125 t empty');
  const wide = FS.newPart('t800', { len: 4, size: 2.5 });
  near(wide.cap, 16000, 1e-6, 'doubling the width quadruples the fuel');
  near(wide.cda / FS.PART.t800.cda, 4, 1e-9, '…and the front drag area');
  const oddTank = FS.newPart('t800', { len: 3.1, size: 2 });
  check(
    oddTank.len === 3 && oddTank.size === 1.25,
    `lengths snap to 0.25 m (3.1 → ${oddTank.len}) and widths to the six sizes`,
  );
  // every preset uses the same density as the base tanks
  const allMatch = FS.DATA.tankPresets.every((preset) => {
    const part = FS.newPart(preset.base, { len: preset.len, size: preset.size });
    return (
      Math.abs(part.cap - 640 * preset.len * preset.size * preset.size) < 1e-6 &&
      Math.abs(part.dry - part.cap / 8) < 1e-6
    );
  });
  check(
    allMatch,
    `all ${FS.DATA.tankPresets.length} tank presets hold 640 kg of fuel per m·m² and weigh an eighth of that empty`,
  );
  check(
    new Set(FS.DATA.tankPresets.map((preset) => preset.size)).size === 6,
    'presets come in all six widths',
  );
  // a stack decoupler takes the width of a widened tank next to it
  const stack = FS.stackToParts(['t800', 'decoupler', 't400']);
  stack[0].size = 2.5;
  FS.applySize(stack[0]);
  stack[2].size = 2.5;
  FS.applySize(stack[2]);
  FS.relayout(stack);
  check(stack[1].w === 2.5, 'a decoupler between 2.5 m tanks is 2.5 m wide');
  // stack positions follow a stretched tank
  const secondStack = FS.stackToParts(['lark', 't800', 'kestrel']);
  const startY = secondStack[2].pos.y;
  secondStack[1].len = 9;
  FS.applySize(secondStack[1]);
  FS.relayout(secondStack);
  near(secondStack[2].pos.y - startY, -5, 1e-9, 'the engine below a tank stretched by 5 m moves down 5 m');
}

// --- Settings save and load ---
{
  const parts = FS.stackToParts([
    'canopy',
    'lark',
    'decoupler',
    't400',
    'wren',
    'decoupler',
    't800',
    'kestrel',
  ]);
  Object.assign(parts[0], { chuteAlt: 1500 });
  Object.assign(parts[2], { crossfeed: true });
  Object.assign(parts[3], { skin: 'gold', fill: 0.5 });
  Object.assign(parts[4], { limit: 0.6, gimbal: 0.25 });
  Object.assign(parts[6], { len: 9, size: 1.875, skin: 'roll' });
  parts.forEach((part) => FS.applySize(part));
  FS.relayout(parts);
  const serial = FS.serialParts(parts);
  const again = FS.partsFromSerial(serial);
  check(
    JSON.stringify(FS.serialParts(again)) === JSON.stringify(serial),
    'every setting survives saving and loading',
  );
  check(
    again[6].len === 9 && again[6].size === 1.875 && again[6].skin === 'roll' && again[3].fuel === 1000,
    'stretched size, look and fuel level come back',
  );
  check(!('len' in serial[1]) && !('skin' in serial[1]), 'unchanged settings are not written (small files)');
}

// --- Thrust limit, fill level and crossfeed in the Δv maths ---
{
  const makeStack = () => FS.stackToParts(['sparrow', 't400', 'gnat']);
  const full = dvOf(makeStack());
  const half = makeStack();
  half[2].limit = 0.5;
  const halfStats = dvOf(half);
  near(halfStats.total, full.total, 0.01, 'a 50% thrust limit keeps the Δv');
  near(halfStats.events[0].time / full.events[0].time, 2, 0.001, '…and doubles the burn time');
  const halfFull = makeStack();
  halfFull[1].fill = 0.5;
  FS.applySize(halfFull[1]);
  check(
    dvOf(halfFull).total < full.total * 0.75 && dvOf(halfFull).total > 0,
    'a half-full tank gives less Δv',
  );
  // crossfeed joins fuel groups across a decoupler
  const crossfeedStack = FS.stackToParts(['sparrow', 't400', 'decoupler', 't400', 'gnat']);
  check(FS.flowGroups(crossfeedStack).length === 2, 'a decoupler splits the fuel');
  crossfeedStack[2].crossfeed = true;
  check(FS.flowGroups(crossfeedStack).length === 1, 'with crossfeed on, fuel flows across it');
  // in flight, the limit halves the thrust
  const vessel = new FS.Vessel('t', FS.serialParts(half), FS.root, { throttle: 1 });
  vessel.landed = null;
  vessel.r = { x: 800000, y: 0 };
  vessel.v = { x: 0, y: 0 };
  for (const part of vessel.parts) {
    if (part.def.engine) {
      part.lit = true;
    }
  }
  const thrust = vessel.runEngines(0, 0);
  near(thrust / FS.PART.gnat.engine.vac, 0.5, 1e-9, 'in flight, a 50% limit gives half the thrust');
}

// --- Custom staging ---
{
  const parts = FS.stackToParts(FS.SAMPLE_CRAFT.find((craft) => craft.name === 'Orbiter I').parts);
  const auto = FS.stagesOf(parts).map((stage) =>
    stage.parts
      .map((part) => part.def.id)
      .sort()
      .join('+'),
  );
  FS.freezeStaging(parts);
  check(FS.customStaging(parts), 'freezing turns staging custom');
  const frozen = FS.stagesOf(parts).map((stage) =>
    stage.parts
      .map((part) => part.def.id)
      .sort()
      .join('+'),
  );
  check(
    JSON.stringify(auto) === JSON.stringify(frozen),
    `frozen staging fires exactly as automatic did (${frozen.join(' | ')})`,
  );
  // split "decouple + ignite Wren" into two stages
  const wren = parts.find((part) => part.def.id === 'wren');
  for (const part of parts) {
    if (part.stage > 1) {
      part.stage++;
    }
  }
  wren.stage = 2;
  const split = FS.stagesOf(parts).map((stage) => stage.parts.map((part) => part.def.id).join('+'));
  check(
    split.join(' | ') === 'kestrel | decoupler | wren | decoupler | canopy',
    `stages can be split (${split.join(' | ')})`,
  );
  parts.find((part) => part.def.id === 'canopy').stage = -1;
  check(!FS.stagesOf(parts).some((stage) => stage.chutes), 'a part can be left out of staging');
  check(FS.customStages(parts, true).length === FS.stagesOf(parts).length, 'no empty stages in flight');
  FS.resetStaging(parts);
  check(!FS.customStaging(parts) && FS.stagesOf(parts).length === 4, 'reset brings automatic staging back');
}

// --- Parachute opening height ---
{
  const fall = (openAltitude) => {
    const game = fakeGame();
    const vessel = new FS.Vessel('c', ['canopy', 'lark'], FS.root, {});
    vessel.parts[0].chuteAlt = openAltitude;
    vessel.landed = null;
    vessel.sas = false;
    vessel.r = { x: FS.root.R + 6000, y: 0 };
    vessel.v = FS.airVel(FS.root, vessel.r);
    vessel.angle = 0;
    vessel.stage(game);
    let openedAt = null;
    for (let step = 0; step < 60000 && !vessel.landed && !vessel.dead; step++) {
      vessel.step(0.02, step * 0.02, game);
      if (!openedAt && vessel.parts[0].chute === 'full') {
        openedAt =
          vessel.altitude - FS.surfaceHeight(FS.root, FS.lonAt(FS.root, Vector.angle(vessel.r), step * 0.02));
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
  const parts = FS.partsFromSerial(FS.SAMPLE_CRAFT.find((craft) => craft.name === 'Twin Boosters').tree);
  parts[6].len = 6;
  parts[6].skin = 'steel';
  FS.applySize(parts[6]);
  FS.relayout(parts);
  FS.freezeStaging(parts);
  const text = FS.craftToText('Steel Twins', parts);
  check(
    text.startsWith('FLATSPACE-CRAFT-1:') && !/\s/.test(text),
    'share text is one line with a clear prefix',
  );
  const back = FS.craftFromText(text);
  check(
    back.name === 'Steel Twins' && JSON.stringify(back.parts) === JSON.stringify(FS.serialParts(parts)),
    'share text loads back exactly',
  );
  const json = FS.craftFromText(FS.craftToJSON('Steel Twins', parts));
  check(
    JSON.stringify(json.parts) === JSON.stringify(FS.serialParts(parts)),
    'a craft file loads back exactly',
  );
  const oldCraft = FS.craftFromText(
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
  const serial = FS.serialParts(parts);
  serial[7].id = 'mystery'; // the lower tank: the boosters hang from it
  const partial = FS.craftFromText(
    JSON.stringify({ format: 'flatspace-craft', version: 3, name: 'X', parts: serial }),
  );
  check(
    partial.skipped === 6 && partial.parts.every((serial) => serial.parent < partial.parts.length),
    `unknown parts are left out with everything attached to them (${partial.skipped} parts)`,
  );
  check(
    !!FS.craftFromText('hello').error &&
      !!FS.craftFromText('{"format":"flatspace-craft","version":99,"parts":[]}').error,
    'garbage and newer-version files give a clear error',
  );
}

// --- Done when: custom staging, a 9 m stretched tank and custom looks fly as configured ---
{
  const parts = FS.stackToParts([
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
  bigTank.len = 9;
  bigTank.skin = 'roll';
  FS.applySize(bigTank);
  parts[3].skin = 'gold';
  FS.relayout(parts);
  FS.freezeStaging(parts);
  const wren = parts[4];
  for (const part of parts) {
    if (part.stage > 1) {
      part.stage++;
    }
  }
  wren.stage = 2; // decouple, then light the upper stage separately
  const text = FS.craftToText('Long Gold', parts);
  const loaded = FS.craftFromText(text);
  const game = fakeGame();
  const vessel = new FS.Vessel('Long Gold', loaded.parts, FS.root, { throttle: 1 });
  check(
    vessel.parts[6].len === 9 &&
      vessel.parts[6].cap === 9000 &&
      vessel.parts[6].skin === 'roll' &&
      vessel.parts[3].skin === 'gold',
    'the imported craft keeps its 9 m tank and its looks in flight',
  );
  check(
    vessel.stages.map((stage) => stage.parts.map((part) => part.def.id).join('+')).join(' | ') ===
      'hornet | decoupler | wren | decoupler | canopy',
    'and its custom staging',
  );
  let time = 0;
  vessel.placeOnPad(time);
  vessel.stage(game);
  let maxAp = 0;
  let wrenLitAfterDecouple = null;
  for (let step = 0; step < 400 / 0.02 && !vessel.dead; step++) {
    const altitude = vessel.altitude;
    const pitch =
      altitude < 1000 ? 0 : Math.min((Math.PI / 2) * 0.95, ((altitude - 1000) / 45000) * (Math.PI / 2));
    vessel.sasMode = 'stability';
    vessel.sasTarget = Vector.angle(vessel.r) - pitch;
    vessel.step(0.02, time, game);
    time += 0.02;
    const orbit = FS.orbitFromState(vessel.r, vessel.v, vessel.body.mu, time);
    maxAp = Math.max(maxAp, orbit.ap - FS.root.R);
    if (maxAp > 85000) {
      vessel.throttle = 0;
    }
    if (vessel.thrustNow === 0 && vessel.stageIdx === 1) {
      vessel.stage(game); // decouple only
      wrenLitAfterDecouple = vessel.parts.find((part) => part.def.id === 'wren').lit;
      vessel.stage(game); // now light the Wren
    }
  }
  check(
    wrenLitAfterDecouple === false,
    'the decouple stage fires on its own, without lighting the upper stage',
  );
  check(
    maxAp > 70000,
    `the craft flies as configured and reaches space (apoapsis ${(maxAp / 1000).toFixed(0)} km)`,
  );
}

// --- Parts on a sloped face line up with it ---
{
  const Build = FS.Build;
  let parts = FS.stackToParts(['lark', 't400']);
  const lark = parts[0];
  const fin = FS.newPart('sweptfin');
  FS.relayout([fin]);
  fin.spin = 0;
  const spot = Vector.add(lark.pos, { x: 0.7, y: 0 });
  Build.placeHeld([fin], fin, spot);
  const candidate = Build.candidate(parts, [fin], fin, spot, 1.7);
  const tilt = Math.atan2((lark.w - lark.tw) / 2, lark.len);
  check(
    candidate && candidate.kind === 'srf' && candidate.parent === lark,
    'a fin dropped beside the capsule goes on its sloped side',
  );
  near((candidate.rot * 180) / Math.PI, (tilt * 180) / Math.PI, 1e-6, 'it leans with the face (degrees)');
  parts = Build.attach(parts, [fin], fin, candidate);
  // flush: the fin's inner edge lies along the face line
  const corners = Build.quad(fin).map((corner) => FS.rotV(Vector.sub(corner, lark.pos), -lark.rot));
  const faceNormal = { x: Math.cos(tilt), y: Math.sin(tilt) };
  const faceDist = (corner) =>
    (corner.x - (lark.w / 2 + ((lark.tw - lark.w) / 2) * ((corner.y + lark.len / 2) / lark.len))) *
    Math.cos(tilt);
  const inner = Math.min(...corners.map(faceDist));
  near(inner, 0, 1e-6, 'and sits flush on it, touching but not inside (m)');
}

// --- Floating parts: left out of the craft, or launched beside it ---
{
  const craft = FS.stackToParts(['lark', 't400', 'hornet']);
  const extra = FS.newPart('t100');
  extra.pos = { x: 6, y: craft[1].pos.y };
  extra.loose = 'keep';
  const all = craft.concat([extra]);
  FS.relayout(all);
  const serial = FS.serialParts(all);
  check(
    serial[3].parent === -1 && serial[3].loose === 'keep',
    'a floating part saves as its own tree, marked to launch',
  );
  const back = FS.partsFromSerial(serial);
  check(back[3].loose === 'keep' && !back[3].parent, '…and loads back the same');
  const vessel = new FS.Vessel('t', serial, FS.root, {});
  check(vessel.parts.length === 3, 'a vessel built from the whole list flies only the craft proper');
  const game = FS.game;
  game.newFlight({
    name: 'Float',
    parts: FS.serialParts(craft),
    extras: [{ parts: FS.serialParts([extra]) }],
  });
  const debrisVessel = game.debris[0];
  const layout = FS.massLayout(craft);
  const want = Vector.sub(extra.pos, layout.com);
  const offset = Vector.sub(debrisVessel.r, game.vessel.r);
  check(
    game.debris.length === 1 && Math.abs(Vector.len(offset) - Vector.len(want)) < 1e-6,
    `a floating part set to launch appears beside the craft, ${Vector.len(offset).toFixed(2)} m from its centre of mass, as placed`,
  );
}

// --- In flight: using parts from their pop-up ---
{
  const game = fakeGame();
  const parts = FS.stackToParts(['sparrow', 't400', 'decoupler', 't400', 'gnat']);
  const vessel = new FS.Vessel('t', FS.serialParts(parts), FS.root, { throttle: 1 });
  vessel.landed = null;
  vessel.r = { x: 800000, y: 0 };
  vessel.v = { x: 0, y: 2000 };
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
