// Step A4: stretchable tanks, part settings, custom staging and craft files.
const { loadGame, fakeGame, check, near, done } = require('./lib');
const FS = loadGame();
const V = FS.vec;
const dvOf = (parts) => FS.stageStats(parts, FS.stagesOf(parts), 0, 0, 9.81);

// --- Stretching scales mass, fuel and drag with volume ---
{
  const t = FS.newPart('t800', { len: 9 });
  near(t.cap, 9000, 1e-6, '9 m Ferro Long Tank holds 9 t of fuel');
  near(t.dry, 1125, 1e-6, '…and weighs 1.125 t empty');
  const wide = FS.newPart('t800', { len: 4, size: 2.5 });
  near(wide.cap, 16000, 1e-6, 'doubling the width quadruples the fuel');
  near(wide.cda / FS.PART.t800.cda, 4, 1e-9, '…and the front drag area');
  const odd = FS.newPart('t800', { len: 3.1, size: 2 });
  check(odd.len === 3 && odd.size === 1.25, `lengths snap to 0.25 m (3.1 → ${odd.len}) and widths to the six sizes`);
  // every preset uses the same density as the base tanks
  const ok = FS.DATA.tankPresets.every((pr) => {
    const p = FS.newPart(pr.base, { len: pr.len, size: pr.size });
    return Math.abs(p.cap - 640 * pr.len * pr.size * pr.size) < 1e-6 && Math.abs(p.dry - p.cap / 8) < 1e-6;
  });
  check(ok, `all ${FS.DATA.tankPresets.length} tank presets hold 640 kg of fuel per m·m² and weigh an eighth of that empty`);
  check(new Set(FS.DATA.tankPresets.map((p) => p.size)).size === 6, 'presets come in all six widths');
  // a stack decoupler takes the width of a widened tank next to it
  const stack = FS.stackToParts(['t800', 'decoupler', 't400']);
  stack[0].size = 2.5; FS.applySize(stack[0]); stack[2].size = 2.5; FS.applySize(stack[2]); FS.relayout(stack);
  check(stack[1].w === 2.5, 'a decoupler between 2.5 m tanks is 2.5 m wide');
  // stack positions follow a stretched tank
  const s2 = FS.stackToParts(['lark', 't800', 'kestrel']);
  const y0 = s2[2].pos.y;
  s2[1].len = 9; FS.applySize(s2[1]); FS.relayout(s2);
  near(s2[2].pos.y - y0, -5, 1e-9, 'the engine below a tank stretched by 5 m moves down 5 m');
}

// --- Settings save and load ---
{
  const parts = FS.stackToParts(['canopy', 'lark', 'decoupler', 't400', 'wren', 'decoupler', 't800', 'kestrel']);
  Object.assign(parts[0], { chuteAlt: 1500 });
  Object.assign(parts[2], { crossfeed: true });
  Object.assign(parts[3], { skin: 'gold', fill: 0.5 });
  Object.assign(parts[4], { limit: 0.6, gimbal: 0.25 });
  Object.assign(parts[6], { len: 9, size: 1.875, skin: 'roll' });
  parts.forEach((p) => FS.applySize(p));
  FS.relayout(parts);
  const ser = FS.serialParts(parts);
  const again = FS.partsFromSerial(ser);
  check(JSON.stringify(FS.serialParts(again)) === JSON.stringify(ser), 'every setting survives saving and loading');
  check(again[6].len === 9 && again[6].size === 1.875 && again[6].skin === 'roll' && again[3].fuel === 1000, 'stretched size, look and fuel level come back');
  check(!('len' in ser[1]) && !('skin' in ser[1]), 'unchanged settings are not written (small files)');
}

// --- Thrust limit, fill level and crossfeed in the Δv maths ---
{
  const mk = () => FS.stackToParts(['sparrow', 't400', 'gnat']);
  const full = dvOf(mk());
  const half = mk(); half[2].limit = 0.5;
  const h = dvOf(half);
  near(h.total, full.total, 0.01, 'a 50% thrust limit keeps the Δv');
  near(h.events[0].time / full.events[0].time, 2, 0.001, '…and doubles the burn time');
  const low = mk(); low[1].fill = 0.5; FS.applySize(low[1]);
  check(dvOf(low).total < full.total * 0.75 && dvOf(low).total > 0, 'a half-full tank gives less Δv');
  // crossfeed joins fuel groups across a decoupler
  const xf = FS.stackToParts(['sparrow', 't400', 'decoupler', 't400', 'gnat']);
  check(FS.flowGroups(xf).length === 2, 'a decoupler splits the fuel');
  xf[2].crossfeed = true;
  check(FS.flowGroups(xf).length === 1, 'with crossfeed on, fuel flows across it');
  // in flight, the limit halves the thrust
  const v = new FS.Vessel('t', FS.serialParts(half), FS.root, { throttle: 1 });
  v.landed = null; v.r = { x: 800000, y: 0 }; v.v = { x: 0, y: 0 };
  for (const q of v.parts) if (q.def.engine) q.lit = true;
  const F = v.runEngines(0, 0);
  near(F / FS.PART.gnat.engine.vac, 0.5, 1e-9, 'in flight, a 50% limit gives half the thrust');
}

// --- Custom staging ---
{
  const parts = FS.stackToParts(FS.SAMPLE_CRAFT.find((c) => c.name === 'Orbiter I').parts);
  const auto = FS.stagesOf(parts).map((e) => e.parts.map((p) => p.def.id).sort().join('+'));
  FS.freezeStaging(parts);
  check(FS.customStaging(parts), 'freezing turns staging custom');
  const frozen = FS.stagesOf(parts).map((e) => e.parts.map((p) => p.def.id).sort().join('+'));
  check(JSON.stringify(auto) === JSON.stringify(frozen), `frozen staging fires exactly as automatic did (${frozen.join(' | ')})`);
  // split "decouple + ignite Wren" into two stages
  const wren = parts.find((p) => p.def.id === 'wren');
  for (const p of parts) if (p.stage > 1) p.stage++;
  wren.stage = 2;
  const split = FS.stagesOf(parts).map((e) => e.parts.map((p) => p.def.id).join('+'));
  check(split.join(' | ') === 'kestrel | decoupler | wren | decoupler | canopy', `stages can be split (${split.join(' | ')})`);
  parts.find((p) => p.def.id === 'canopy').stage = -1;
  check(!FS.stagesOf(parts).some((e) => e.chutes), 'a part can be left out of staging');
  check(FS.customStages(parts, true).length === FS.stagesOf(parts).length, 'no empty stages in flight');
  FS.resetStaging(parts);
  check(!FS.customStaging(parts) && FS.stagesOf(parts).length === 4, 'reset brings automatic staging back');
}

// --- Parachute opening height ---
{
  const fall = (alt) => {
    const g = fakeGame();
    const v = new FS.Vessel('c', ['canopy', 'lark'], FS.root, {});
    v.parts[0].chuteAlt = alt;
    v.landed = null; v.sas = false;
    v.r = { x: FS.root.R + 6000, y: 0 }; v.v = FS.airVel(FS.root, v.r); v.angle = 0;
    v.stage(g);
    let at = null;
    for (let i = 0; i < 60000 && !v.landed && !v.dead; i++) {
      v.step(0.02, i * 0.02, g);
      if (!at && v.parts[0].chute === 'full') at = v.altitude - FS.surfaceHeight(FS.root, FS.lonAt(FS.root, V.angle(v.r), i * 0.02));
    }
    return { at, landed: !!v.landed && !v.dead };
  };
  const a = fall(2500), b = fall(1000);
  check(a.at > 2300 && a.at <= 2500 && b.at > 900 && b.at <= 1000, `the parachute opens fully at its set height (${a.at.toFixed(0)} m and ${b.at.toFixed(0)} m)`);
  check(a.landed && b.landed, 'and the capsule lands safely either way');
}

// --- Craft files ---
{
  const parts = FS.partsFromSerial(FS.SAMPLE_CRAFT.find((c) => c.name === 'Twin Boosters').tree);
  parts[6].len = 6; parts[6].skin = 'steel'; FS.applySize(parts[6]); FS.relayout(parts);
  FS.freezeStaging(parts);
  const text = FS.craftToText('Steel Twins', parts);
  check(text.startsWith('FLATSPACE-CRAFT-1:') && !/\s/.test(text), 'share text is one line with a clear prefix');
  const back = FS.craftFromText(text);
  check(back.name === 'Steel Twins' && JSON.stringify(back.parts) === JSON.stringify(FS.serialParts(parts)), 'share text loads back exactly');
  const json = FS.craftFromText(FS.craftToJSON('Steel Twins', parts));
  check(JSON.stringify(json.parts) === JSON.stringify(FS.serialParts(parts)), 'a craft file loads back exactly');
  const old = FS.craftFromText(JSON.stringify({ format: 'flatspace-craft', version: 1, name: 'Old', parts: ['canopy', 'lark', 'thumper'] }));
  check(old.parts && old.parts.length === 3 && old.parts[2].id === 'rumbler', 'an old-format craft file is upgraded (stack list, renamed booster)');
  const ser = FS.serialParts(parts);
  ser[7].id = 'mystery'; // the lower tank: the boosters hang from it
  const partial = FS.craftFromText(JSON.stringify({ format: 'flatspace-craft', version: 3, name: 'X', parts: ser }));
  check(partial.skipped === 6 && partial.parts.every((s) => s.parent < partial.parts.length), `unknown parts are left out with everything attached to them (${partial.skipped} parts)`);
  check(!!FS.craftFromText('hello').error && !!FS.craftFromText('{"format":"flatspace-craft","version":99,"parts":[]}').error, 'garbage and newer-version files give a clear error');
}

// --- Done when: custom staging, a 9 m stretched tank and custom looks fly as configured ---
{
  const parts = FS.stackToParts(['canopy', 'lark', 'decoupler', 't400', 'wren', 'decoupler', 't800', 'fins', 'hornet']);
  const big = parts[6];
  big.len = 9; big.skin = 'roll'; FS.applySize(big);
  parts[3].skin = 'gold';
  FS.relayout(parts);
  FS.freezeStaging(parts);
  const wren = parts[4];
  for (const p of parts) if (p.stage > 1) p.stage++;
  wren.stage = 2; // decouple, then light the upper stage separately
  const text = FS.craftToText('Long Gold', parts);
  const loaded = FS.craftFromText(text);
  const g = fakeGame();
  const v = new FS.Vessel('Long Gold', loaded.parts, FS.root, { throttle: 1 });
  check(v.parts[6].len === 9 && v.parts[6].cap === 9000 && v.parts[6].skin === 'roll' && v.parts[3].skin === 'gold', 'the imported craft keeps its 9 m tank and its looks in flight');
  check(v.stages.map((e) => e.parts.map((p) => p.def.id).join('+')).join(' | ') === 'hornet | decoupler | wren | decoupler | canopy', 'and its custom staging');
  let t = 0;
  v.placeOnPad(t);
  v.stage(g);
  let maxAp = 0, wrenLitAfterDecouple = null;
  for (let i = 0; i < 400 / 0.02 && !v.dead; i++) {
    const alt = v.altitude;
    const pitch = alt < 1000 ? 0 : Math.min((Math.PI / 2) * 0.95, ((alt - 1000) / 45000) * (Math.PI / 2));
    v.sasMode = 'stability';
    v.sasTarget = V.angle(v.r) - pitch;
    v.step(0.02, t, g);
    t += 0.02;
    const o = FS.orbitFromState(v.r, v.v, v.body.mu, t);
    maxAp = Math.max(maxAp, o.ap - FS.root.R);
    if (maxAp > 85000) v.throttle = 0;
    if (v.thrustNow === 0 && v.stageIdx === 1) {
      v.stage(g); // decouple only
      wrenLitAfterDecouple = v.parts.find((p) => p.def.id === 'wren').lit;
      v.stage(g); // now light the Wren
    }
  }
  check(wrenLitAfterDecouple === false, 'the decouple stage fires on its own, without lighting the upper stage');
  check(maxAp > 70000, `the craft flies as configured and reaches space (apoapsis ${(maxAp / 1000).toFixed(0)} km)`);
}

done();
