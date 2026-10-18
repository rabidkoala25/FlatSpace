// Drag-and-drop building (build.js): snapping to stack nodes and sides, overlap checks,
// carrying parts, re-rooting, and rebuilding every sample craft by dragging alone.
const { loadGame, check, near, done } = require('./lib');
const FS = loadGame();
const B = FS.Build;
const V = FS.vec;
const SNAP = 34 / 20; // the editor's 34 px snap at 20 px per metre

// Drag part `id` and let go with its centre at `at`, the way the editor does.
// Returns the new part list, or null when the drop is refused (the part goes back to the tray).
function drop(parts, id, at) {
  const p = FS.newPart(id);
  FS.relayout([p]);
  B.placeHeld([p], p, at);
  const cand = B.candidate(parts, [p], p, at, SNAP);
  if (!cand || B.blocker(parts, [p], p, cand)) return null;
  return B.attach(parts, [p], p, cand);
}

// A sloppy drop below the lowest free bottom node: off by up to half a metre each way.
function dropBelow(parts, id, k) {
  if (!parts.length) return drop(parts, id, { x: 3, y: 5 });
  const n = B.freeNodes(parts).filter((f) => f.node === 'bottom').sort((a, b) => a.pos.y - b.pos.y)[0];
  const jx = ((k * 37) % 7) / 14 - 0.25, jy = ((k * 53) % 5) / 10 - 0.2;
  return drop(parts, id, { x: n.pos.x + jx, y: n.pos.y - FS.PART[id].len / 2 + jy });
}

// Stack-built craft compare by shape: every part's offset from the root, in order.
const shape = (parts) => parts.map((p) => `${p.def.id}@${(p.pos.x - parts[0].pos.x).toFixed(3)},${(p.pos.y - parts[0].pos.y).toFixed(3)}`).join(' ');
const dvOf = (parts) => FS.stageStats(parts, FS.stagesOf(parts), 0, 0, 9.81).total;

// --- Every stack sample craft can be rebuilt by dragging alone ---
for (const c of FS.SAMPLE_CRAFT.filter((s) => s.parts)) {
  let parts = [];
  let ok = true;
  c.parts.forEach((id, k) => { const next = dropBelow(parts, id, k); if (!next) ok = false; else parts = next; });
  const ref = FS.stackToParts(c.parts);
  check(ok && shape(parts) === shape(ref), `${c.name} rebuilt by dragging matches the sample part for part`);
  near(dvOf(parts), dvOf(ref), 0.5, `${c.name} rebuilt has the same Δv`);
}

// --- Twin Boosters: the stack, then side decouplers and boosters on each side ---
{
  const ref = FS.partsFromSerial(FS.SAMPLE_CRAFT.find((c) => c.name === 'Twin Boosters').tree);
  let parts = [];
  ['canopy', 'lark', 'decoupler', 't400', 'wren', 'decoupler', 't800', 't800', 'kestrel'].forEach((id, k) => (parts = dropBelow(parts, id, k)));
  const tank = parts[7];
  for (const side of [1, -1]) {
    parts = drop(parts, 'radec', V.add(tank.pos, { x: side * 0.95, y: 0.3 }));
    check(!!parts, `a side decoupler snaps to the ${side > 0 ? 'right' : 'left'} of the lower tank`);
    const dec = parts[parts.length - 1];
    check(dec.parent === tank && dec.node === 'srf' && Math.abs(dec.pos.y - tank.pos.y) < 1e-9, '  …centred on the tank (snapped to the middle of its side)');
    parts = drop(parts, 'rumbler', V.add(dec.pos, { x: side * 0.6, y: -0.25 }));
    check(!!parts && parts[parts.length - 1].parent === dec, '  …and a booster attaches to the decoupler');
  }
  const pos = (ps) => ps.map((p) => `${p.def.id}@${(p.pos.x - ps[0].pos.x + 1e-6).toFixed(2)},${(p.pos.y - ps[0].pos.y + 1e-6).toFixed(2)}`).sort().join(' ');
  check(pos(parts) === pos(ref), 'Twin Boosters rebuilt by dragging matches the sample');
  const st = FS.stagesOf(parts).map((e) => (e.decouple ? 'D' : '') + (e.ignite ? 'I' : '') + (e.chutes ? 'C' : '')).join(' ');
  check(st === 'I D DI D C', `…and stages the same way (${st})`);
  near(dvOf(parts), dvOf(ref), 0.5, '…with the same Δv');

  // a tank pushed against the booster overlaps it and is refused
  const booster = parts.find((p) => p.def.id === 'rumbler' && p.pos.x > 0);
  const t = FS.newPart('t400'); FS.relayout([t]);
  const onTank = { kind: 'srf', parent: tank, side: 1, pos: V.add(tank.pos, { x: 1.25, y: 0 }), rot: 0, dist: 0 };
  const hit = B.blocker(parts, [t], t, onTank);
  check(hit && (hit.def.id === 'radec' || hit.def.id === 'rumbler'), 'a tank on the side where the booster hangs is blocked by it');
  const c = B.candidate(parts, [t], t, V.add(tank.pos, { x: 1.3, y: 0 }), SNAP);
  check(c && B.blocker(parts, [t], t, c), '…and so is every spot in reach of that drop (the ghost shows red)');
  const c3 = B.candidate(parts, [t], t, V.add(booster.pos, { x: 1.1, y: 0 }), SNAP);
  check(c3 && c3.parent === booster && !B.blocker(parts, [t], t, c3), 'the outer side of the booster is free');
  check(drop(parts, 't100', V.add(booster.pos, { x: 9, y: 0 })) === null, 'a part dropped far from the craft is refused');
}

// --- Rules for nodes ---
{
  let parts = drop([], 'lark', { x: 0, y: 0 });
  check(B.candidate(parts, [FS.newPart('radec')], FS.newPart('radec'), { x: 0, y: -0.6 - 0.3 }, SNAP) === null
    || B.candidate(parts, [FS.newPart('radec')], FS.newPart('radec'), { x: 0, y: -0.9 }, SNAP).kind === 'srf',
  'a side decoupler never stacks on a node');
  const chute = FS.newPart('canopy'); FS.relayout([chute]);
  const under = { x: 0, y: parts[0].pos.y - 0.65 - 0.225 };
  const c = B.candidate(parts, [chute], chute, under, SNAP);
  check(!c || c.kind !== 'bottom', 'a parachute has no top node, so it cannot hang below a capsule');
  parts = drop(parts, 'canopy', { x: 0.2, y: 0.9 });
  check(parts && parts[1].node === 'top', 'a parachute snaps on top of the capsule');
  const t = FS.newPart('t100'); FS.relayout([t]);
  const c2 = B.candidate(parts, [t], t, { x: 0, y: parts[1].pos.y + 0.225 + 0.375 }, SNAP);
  check(!c2 || c2.parent !== parts[1], 'nothing can go on top of a parachute');
}

// --- Carrying a part takes everything below it ---
{
  let parts = FS.stackToParts(['lark', 'decoupler', 't400', 'gnat']);
  const tank = parts[2];
  const held = FS.subtree(parts, tank);
  check(held.map((p) => p.def.id).join() === 't400,gnat', 'picking up a tank carries the engine below it');
  parts = parts.filter((p) => !held.includes(p));
  B.placeHeld(held, tank, { x: 5, y: 5 });
  check(Math.abs(held[1].pos.x - 5) < 1e-9 && held[1].pos.y < 5, 'the engine moves with the tank');
  const n = B.freeNodes(parts).find((f) => f.part.def.id === 'decoupler' && f.node === 'bottom');
  const cand = B.candidate(parts, held, tank, { x: n.pos.x + 0.3, y: n.pos.y - 0.95 + 0.4 }, SNAP);
  check(cand && cand.kind === 'bottom' && cand.parent === n.part && !B.blocker(parts, held, tank, cand), 'the tank snaps back under the decoupler');
  parts = B.attach(parts, held, tank, cand);
  check(shape(parts) === shape(FS.stackToParts(['lark', 'decoupler', 't400', 'gnat'])), 'and the craft is whole again');
  check(parts[1].w === 1.25, 'the decoupler takes the width of its neighbours');
}

// --- Re-rooting keeps the craft's shape and staging ---
{
  const ref = FS.stackToParts(['canopy', 'lark', 'decoupler', 't400', 'wren']);
  const parts = FS.stackToParts(['canopy', 'lark', 'decoupler', 't400', 'wren']);
  const before = parts.map((p) => ({ ...p.pos }));
  const lark = parts[1];
  B.reroot(parts, lark);
  check(parts[0] === lark && !lark.parent, 'the chosen part becomes the root, listed first');
  check(parts.every((p) => { const i = ref.findIndex((q) => q.def.id === p.def.id && Math.abs(q.pos.y - p.pos.y) < 1e-9); return i >= 0; }), 'every part stays where it was');
  check(parts.find((p) => p.def.id === 'canopy').node === 'top', 'the parachute now sits on top of the capsule');
  near(dvOf(parts), dvOf(ref), 0.5, 'the Δv is unchanged');
  const again = FS.partsFromSerial(FS.serialParts(parts));
  check(shape(again) === shape(parts), 'a re-rooted craft saves and loads unchanged');
  check(before.length === parts.length, 'no parts lost');
}

// --- Picking: the smallest part under the pointer wins ---
{
  const parts = FS.partsFromSerial(FS.SAMPLE_CRAFT.find((c) => c.name === 'Twin Boosters').tree);
  const dec = parts.find((p) => p.def.id === 'radec' && p.pos.x > 0);
  check(B.partAt(parts, { x: dec.pos.x - 0.1, y: dec.pos.y }) === dec, 'a side decoupler can be picked over the tank behind it');
  check(B.partAt(parts, { x: 20, y: 0 }) === null, 'empty space picks nothing');
}


// ================= Step A3: precision tools =================
const DEG = Math.PI / 180;
// Drop a held group with mirror symmetry, the way the editor does (place()).
function dropMirrored(parts, held, root, at) {
  B.placeHeld(held, root, at);
  const cand = B.candidate(parts, held, root, at, SNAP, true);
  if (!cand || B.blocker(parts, held, root, cand, true)) return null;
  const line = B.mirrorFor(parts, cand.parent, cand.kind);
  let all = B.attach(parts, held, root, cand);
  if (line) { const twin = B.makeTwin(held, line, cand.kind); B.linkTwins(held, twin); all = all.concat(twin); FS.relayout(all); }
  return all;
}
const part = (id, spin = 0) => { const p = FS.newPart(id); p.spin = spin; FS.relayout([p]); return p; };

// --- Mirror: side boosters in pairs; parts on a twin get twins on the other twin ---
{
  let parts = FS.stackToParts(['lark', 't400', 'decoupler', 't800', 't800', 'kestrel']);
  const core = parts[3], lower = parts[4];
  const dec = part('radec');
  parts = dropMirrored(parts, [dec], dec, V.add(core.pos, { x: 0.9, y: 0.2 }));
  const decTwin = B.twinOf(parts, dec);
  check(decTwin && decTwin.parent === core && Math.abs(decTwin.pos.x + dec.pos.x - 2 * core.pos.x) < 1e-9 && decTwin.flip !== dec.flip, 'mirror on: a side decoupler comes with a twin on the other side');
  const boo = part('rumbler');
  parts = dropMirrored(parts, [boo], boo, V.add(dec.pos, { x: 0.7, y: 0 }));
  const booTwin = B.twinOf(parts, boo);
  check(booTwin && booTwin.parent === decTwin, 'a booster on a twinned decoupler gets its twin on the other decoupler');
  const st = FS.stagesOf(parts).map((e) => (e.decouple ? 'D' : '') + (e.ignite ? 'I' : '')).join(' ');
  check(st.startsWith('I D'), `the mirrored boosters stage like the sample (${st})`);
  const o = FS.centreOfThrust(FS.stagesOf(parts)[0].engines);
  check(Math.abs(o.pos.x - core.pos.x) < 1e-9 && Math.abs(o.dir.x) < 1e-9, 'mirrored boosters keep the thrust on the centre line');

  // --- Rotate: tilted fins, mirrored the other way, staying on the surface ---
  const fin = part('sweptfin', 15 * DEG);
  parts = dropMirrored(parts, [fin], fin, V.add(lower.pos, { x: 1.0, y: -1.4 }));
  check(!!parts, 'tilted fins fit on the tank below the boosters');
  const finTwin = B.twinOf(parts, fin);
  near(fin.rot / DEG, 15, 0.01, 'the fin is tilted 15°');
  near(finTwin.rot / DEG, -15, 0.01, 'its twin is tilted the mirror way');
  const inner = (p) => Math.min(...B.quad(p).map((q) => Math.abs(q.x - lower.pos.x)));
  near(inner(fin), 0.625, 0.001, 'the tilted fin still touches the tank (inner corner on the surface)');
  check(!B.moveOnSurface(parts, fin, B.surfaceHeight(fin), fin.rot + 15 * DEG), 'turning a placed fin another 15° works');
  near(finTwin.rot / DEG, -30, 0.01, '…and its twin turns the mirror way');

  // --- Offset: slide along the parent; the twin follows; overlaps are refused ---
  const y0 = B.surfaceHeight(fin);
  check(!B.moveOnSurface(parts, fin, y0 - 0.25, fin.rot), 'a fin slides 0.25 m down its tank');
  near(B.surfaceHeight(finTwin), y0 - 0.25, 1e-9, '…and its twin slides with it');
  const blocked = B.moveOnSurface(parts, fin, 1.875, fin.rot);
  check(blocked && blocked.def.id === 'rumbler', `sliding the fin up into the booster is refused (blocked by the ${blocked && blocked.def.name})`);
  near(B.surfaceHeight(fin), y0 - 0.25, 1e-9, '…and leaves it where it was');

  // --- Saving keeps angles, offsets and mirror links ---
  const again = FS.partsFromSerial(FS.serialParts(parts));
  check(JSON.stringify(FS.serialParts(again)) === JSON.stringify(FS.serialParts(parts)), 'a mirrored, tilted craft saves and loads unchanged');
  check(B.twinOf(again, again[parts.indexOf(fin)]) === again[parts.indexOf(finTwin)], 'mirror links survive saving');

  // --- Turning a parent carries its side parts round with it ---
  const pod = FS.stackToParts(['t400']);
  const f2 = FS.attachPart(pod, 'sweptfin', pod[0], { x: 0.9, y: 0 });
  pod[0].rot = 30 * DEG;
  FS.relayout(pod);
  const exp = FS.rotV({ x: 0.9, y: 0 }, 30 * DEG);
  check(Math.abs(f2.pos.x - exp.x) < 1e-9 && Math.abs(f2.pos.y - exp.y) < 1e-9 && Math.abs(f2.rot - 30 * DEG) < 1e-9, 'side parts turn with the part they hang on');

  // --- Copies are new parts with their own mirror links ---
  const copy = B.clone(FS.subtree(parts, core));
  check(copy.length === FS.subtree(parts, core).length && copy.every((c) => !parts.includes(c)), 'a copy has the same parts, all new');
  check(copy.filter((c) => c.sym).every((c) => !parts.some((p) => p.sym === c.sym)), 'a copy gets its own mirror links');
}

// --- Overlays: the centre of pressure moves behind the centre of mass with fins ---
{
  const bare = FS.stackToParts(['lark', 't800', 't800', 'kestrel']);
  const finned = FS.stackToParts(['lark', 't800', 't800', 'fins', 'kestrel']);
  const a = FS.centreOfPressure(bare).ahead, b = FS.centreOfPressure(finned).ahead;
  check(a > 0 && b < 0, `fins move the centre of pressure from ahead of the centre of mass (${a.toFixed(2)} m) to behind it (${b.toFixed(2)} m)`);
  // and flight agrees: a finned rocket turns back into the airflow without SAS
  const fakeG = { emit() {} };
  const fly = (src) => {
    const v = new FS.Vessel('t', src, FS.root, {});
    v.landed = null; v.sas = false;
    v.r = { x: FS.root.R + 4000, y: 0 };
    v.v = V.add(FS.airVel(FS.root, v.r), { x: 300, y: 0 });
    v.angle = 5 * DEG;
    for (let k = 0; k < 300; k++) v.step(0.02, k * 0.02, fakeG);
    const va = V.sub(v.v, FS.airVel(FS.root, v.r));
    return Math.abs(FS.wrapAngle(v.angle - Math.atan2(va.y, va.x))) / DEG;
  };
  const af = fly(FS.serialParts(finned)), ab = fly(FS.serialParts(bare));
  check(af < 5 && ab > 5, `in flight, the finned rocket straightens (5° → ${af.toFixed(1)}°) and the bare one doesn't (→ ${ab.toFixed(1)}°)`);
}

done();
