// The part tree: craft files, off-centre thrust, side boosters, staging and separation.
const { loadGame, fakeGame, check, near, done } = require('./lib');
const FS = loadGame();
const V = FS.vec;

// A craft placed in a circular 700 km orbit, so gravity and air don't get in the way.
function inOrbit(source) {
  const v = new FS.Vessel('Test', source, FS.root, {});
  const R0 = 700000;
  v.landed = null;
  v.r = { x: R0, y: 0 };
  v.v = { x: 0, y: -Math.sqrt(FS.root.mu / R0) };
  v.angle = Math.PI / 2;
  v.sas = false;
  return v;
}

// --- Saving and loading a tree keeps it exactly ---
{
  const twin = FS.SAMPLE_CRAFT.find((c) => c.name === 'Twin Boosters').tree;
  const again = FS.serialParts(FS.partsFromSerial(twin));
  check(JSON.stringify(again) === JSON.stringify(twin), 'a saved part tree loads and saves back unchanged');
}

// --- Off-centre thrust turns the craft; a mirrored pair does not ---
{
  const one = FS.stackToParts(['sparrow', 't400', 'gnat']);
  FS.attachPart(one, 'gnat', one[1], { x: 0.9, y: one[1].pos.y });
  const v = inOrbit(one);
  for (const p of v.parts) if (p.def.engine) p.lit = true;
  v.throttle = 1;
  for (let i = 0; i < 50; i++) v.step(0.02, i * 0.02, fakeGame());
  check(v.omega > 0.01, `one side engine on the right turns the craft anticlockwise (spin ${v.omega.toFixed(3)} rad/s)`);

  const two = FS.stackToParts(['sparrow', 't400', 'gnat']);
  FS.attachPart(two, 'gnat', two[1], { x: 0.9, y: two[1].pos.y });
  FS.attachPart(two, 'gnat', two[1], { x: -0.9, y: two[1].pos.y }, 0, true);
  const w = inOrbit(two);
  for (const p of w.parts) if (p.def.engine) p.lit = true;
  w.throttle = 1;
  for (let i = 0; i < 50; i++) w.step(0.02, i * 0.02, fakeGame());
  near(w.omega, 0, 1e-9, 'a mirrored pair of side engines pushes straight (spin, rad/s)');
  check(w.thrustNow > 0 && v.thrustNow > 0, 'side engines draw fuel from the tank they hang on');
}

// --- On the ground, engines that turn the craft tip it over once they beat its weight ---
{
  // one engine pushing up on one side, one pushing down on the other: no lift, all turn
  const pinwheel = (id, x = 1.3) => {
    const parts = FS.stackToParts(['lark', 't800']);
    const t = parts[1];
    FS.attachPart(parts, id, t, { x, y: t.pos.y - 1 }, 0);
    FS.attachPart(parts, id, t, { x: -x, y: t.pos.y + 1 }, Math.PI);
    const v = new FS.Vessel('Pinwheel', FS.serialParts(parts), FS.root, {});
    v.placeOnPad(0);
    for (const p of v.parts) if (p.def.engine) p.lit = true;
    return v;
  };
  const g = fakeGame();
  const small = pinwheel('gnat', 0.95);
  small.throttle = 1;
  for (let i = 0; i < 100; i++) small.step(0.02, i * 0.02, g);
  check(small.landed && small.landed.rel === 0, `small engines can't tip it: its weight holds it on its base (turning effect ${(small.thrustTorque / 1000).toFixed(0)} kN·m)`);

  const big = pinwheel('hornet');
  big.throttle = 0.12;
  let t = 0, most = 0;
  const up0 = big.angle;
  for (let i = 0; i < 300 && !big.dead; i++) { t += 0.02; big.step(0.02, t, g); most = Math.max(most, Math.abs(FS.wrapAngle(big.angle - up0))); }
  check(!big.dead && !big.landed && most > 1, `bigger engines tip it and turn it over on the ground (turned ${(most * 180 / Math.PI).toFixed(0)}°)`);
  big.throttle = 0;
  for (let i = 0; i < 400 && !big.dead && !big.landed; i++) { t += 0.02; big.step(0.02, t, g); }
  check(big.landed && Math.abs(big.landed.rel) > 0.3, `with the engines off it comes to rest where it fell (${(big.landed && big.landed.rel * 180 / Math.PI).toFixed(0)}° from upright)`);

  const hard = pinwheel('hornet');
  hard.throttle = 1;
  for (let i = 0; i < 150 && !hard.dead; i++) hard.step(0.02, i * 0.02, g);
  check(hard.dead, 'at full power it flips so hard that it smashes into the ground');
}

// --- Side boosters: staging order, Δv, and separation ---
{
  const twin = FS.SAMPLE_CRAFT.find((c) => c.name === 'Twin Boosters').tree;
  const v = inOrbit(twin);
  const pattern = v.stages.map((e) => (e.chutes ? 'C' : (e.decouple ? 'D' : '') + (e.ignite ? 'I' : ''))).join(' ');
  check(pattern === 'I D DI D C', `boosters light with the core and drop first: "I D DI D C" (got "${pattern}")`);
  check(v.stages[0].engines.length === 3, 'stage 1 lights the core engine and both boosters');
  check(v.stages[1].decouplers.length === 2, 'stage 2 fires both side decouplers');

  const st = FS.stageStats(v.parts, v.stages, 0, 0, 9.81);
  check(st.events[0].dv > 500 && st.events[1].dv > 500, `boosters and core both give Δv (${st.events[0].dv.toFixed(0)} then ${st.events[1].dv.toFixed(0)} m/s)`);

  const game = fakeGame();
  v.sas = true;
  v.sasMode = 'stability';
  v.sasTarget = v.angle;
  v.stage(game);
  v.throttle = 1;
  const boosters = v.parts.filter((p) => p.def.id === 'rumbler');
  let t = 0;
  while (boosters.some((b) => b.solid > 0) && t < 120) { v.step(0.02, t, game); t += 0.02; }
  check(boosters.every((b) => b.solid === 0), `boosters burn out (after ${t.toFixed(0)} s)`);
  near(v.omega, 0, 0.01, 'symmetric boosters keep the craft steady (spin, rad/s)');

  const before = { parts: v.parts.length, r: { ...v.r }, v: { ...v.v } };
  v.stage(game);
  check(game.debris.length === 2, 'staging drops both boosters as two pieces of debris');
  check(v.parts.length === before.parts - 4, 'the craft loses the two boosters and their decouplers');
  const [a, b] = game.debris;
  const side = (d) => V.dot(V.sub(d.r, v.r), v.side);
  check(side(a) * side(b) < 0 && Math.abs(side(a)) > 1, `the boosters fall away on opposite sides (${side(a).toFixed(2)} m and ${side(b).toFixed(2)} m)`);
  check(game.debris.every((d) => V.len(V.sub(d.v, v.v)) < 3), 'each booster leaves at a gentle separation speed');
  check(game.debris.every((d) => Math.abs(FS.wrapAngle(d.angle - v.angle)) < 1e-9), 'the boosters keep the craft\'s orientation');
  check(V.len(V.sub(v.r, before.r)) < 1, 'the craft\'s centre of mass shifts only slightly');

  // the next stage drops the core and lights the upper engine
  const ev = v.stage(game);
  check(ev.decouple && ev.ignite && game.debris.length === 3 && v.parts.some((p) => p.def.id === 'wren' && p.lit), 'the next stage drops the core and lights the upper stage');
}

done();
