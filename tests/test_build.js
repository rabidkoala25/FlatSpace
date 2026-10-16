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

done();
