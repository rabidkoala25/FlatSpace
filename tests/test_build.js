// Drag-and-drop building (build.js): snapping to stack nodes and sides, overlap checks,
// carrying parts, re-rooting, and rebuilding every sample craft by dragging alone.
const { loadGame, check, near, done } = require('./lib');
const FS = loadGame();
const Build = FS.Build;
const Vector = FS.vec;
const SNAP = 34 / 20; // the editor's 34 px snap at 20 px per metre

// Drag part `id` and let go with its centre at `at`, the way the editor does.
// Returns the new part list, or null when the drop is refused (the part goes back to the tray).
function drop(parts, partId, spot) {
  const part = FS.newPart(partId);
  FS.relayout([part]);
  Build.placeHeld([part], part, spot);
  const cand = Build.candidate(parts, [part], part, spot, SNAP);
  if (!cand || Build.blocker(parts, [part], part, cand)) {
    return null;
  }
  return Build.attach(parts, [part], part, cand);
}

// A sloppy drop below the lowest free bottom node: off by up to half a metre each way.
function dropBelow(parts, partId, dropNumber) {
  if (!parts.length) {
    return drop(parts, partId, { x: 3, y: 5 });
  }
  const freeNode = Build.freeNodes(parts)
    .filter((node) => node.node === 'bottom')
    .sort((first, second) => first.pos.y - second.pos.y)[0];
  const jitterX = ((dropNumber * 37) % 7) / 14 - 0.25;
  const jitterY = ((dropNumber * 53) % 5) / 10 - 0.2;
  return drop(parts, partId, {
    x: freeNode.pos.x + jitterX,
    y: freeNode.pos.y - FS.PART[partId].len / 2 + jitterY,
  });
}

// Stack-built craft compare by shape: every part's offset from the root, in order.
const shape = (parts) =>
  parts
    .map(
      (part) =>
        `${part.def.id}@${(part.pos.x - parts[0].pos.x).toFixed(3)},${(part.pos.y - parts[0].pos.y).toFixed(3)}`,
    )
    .join(' ');
const dvOf = (parts) => FS.stageStats(parts, FS.stagesOf(parts), 0, 0, 9.81).total;

// --- Every stack sample craft can be rebuilt by dragging alone ---
for (const craft of FS.SAMPLE_CRAFT.filter((sample) => sample.parts)) {
  let parts = [];
  let allMatch = true;
  craft.parts.forEach((partId, index) => {
    const next = dropBelow(parts, partId, index);
    if (!next) {
      allMatch = false;
    } else {
      parts = next;
    }
  });
  const reference = FS.stackToParts(craft.parts);
  check(
    allMatch && shape(parts) === shape(reference),
    `${craft.name} rebuilt by dragging matches the sample part for part`,
  );
  near(dvOf(parts), dvOf(reference), 0.5, `${craft.name} rebuilt has the same Δv`);
}

// --- Twin Boosters: the stack, then side decouplers and boosters on each side ---
{
  const reference = FS.partsFromSerial(FS.SAMPLE_CRAFT.find((craft) => craft.name === 'Twin Boosters').tree);
  let parts = [];
  ['canopy', 'lark', 'decoupler', 't400', 'wren', 'decoupler', 't800', 't800', 'kestrel'].forEach(
    (partId, index) => (parts = dropBelow(parts, partId, index)),
  );
  const tank = parts[7];
  for (const side of [1, -1]) {
    parts = drop(parts, 'radec', Vector.add(tank.pos, { x: side * 0.95, y: 0.3 }));
    check(!!parts, `a side decoupler snaps to the ${side > 0 ? 'right' : 'left'} of the lower tank`);
    const decoupler = parts[parts.length - 1];
    check(
      decoupler.parent === tank && decoupler.node === 'srf' && Math.abs(decoupler.pos.y - tank.pos.y) < 1e-9,
      '  …centred on the tank (snapped to the middle of its side)',
    );
    parts = drop(parts, 'rumbler', Vector.add(decoupler.pos, { x: side * 0.6, y: -0.25 }));
    check(
      !!parts && parts[parts.length - 1].parent === decoupler,
      '  …and a booster attaches to the decoupler',
    );
  }
  const positionsOf = (partList) =>
    partList
      .map(
        (part) =>
          `${part.def.id}@${(part.pos.x - partList[0].pos.x + 1e-6).toFixed(2)},${(part.pos.y - partList[0].pos.y + 1e-6).toFixed(2)}`,
      )
      .sort()
      .join(' ');
  check(
    positionsOf(parts) === positionsOf(reference),
    'Twin Boosters rebuilt by dragging matches the sample',
  );
  const stagePattern = FS.stagesOf(parts)
    .map((stage) => (stage.decouple ? 'D' : '') + (stage.ignite ? 'I' : '') + (stage.chutes ? 'C' : ''))
    .join(' ');
  check(stagePattern === 'I D DI D C', `…and stages the same way (${stagePattern})`);
  near(dvOf(parts), dvOf(reference), 0.5, '…with the same Δv');

  // a tank pushed against the booster overlaps it and is refused
  const booster = parts.find((part) => part.def.id === 'rumbler' && part.pos.x > 0);
  const newTank = FS.newPart('t400');
  FS.relayout([newTank]);
  const onTank = {
    kind: 'srf',
    parent: tank,
    side: 1,
    pos: Vector.add(tank.pos, { x: 1.25, y: 0 }),
    rot: 0,
    dist: 0,
  };
  const hit = Build.blocker(parts, [newTank], newTank, onTank);
  check(
    hit && (hit.def.id === 'radec' || hit.def.id === 'rumbler'),
    'a tank on the side where the booster hangs is blocked by it',
  );
  const candidate = Build.candidate(parts, [newTank], newTank, Vector.add(tank.pos, { x: 1.3, y: 0 }), SNAP);
  check(
    candidate && Build.blocker(parts, [newTank], newTank, candidate),
    '…and so is every spot in reach of that drop (the ghost shows red)',
  );
  const boosterCandidate = Build.candidate(
    parts,
    [newTank],
    newTank,
    Vector.add(booster.pos, { x: 1.1, y: 0 }),
    SNAP,
  );
  check(
    boosterCandidate &&
      boosterCandidate.parent === booster &&
      !Build.blocker(parts, [newTank], newTank, boosterCandidate),
    'the outer side of the booster is free',
  );
  check(
    drop(parts, 't100', Vector.add(booster.pos, { x: 9, y: 0 })) === null,
    'a part dropped far from the craft is refused',
  );
}

// --- Rules for nodes ---
{
  let parts = drop([], 'lark', { x: 0, y: 0 });
  check(
    Build.candidate(parts, [FS.newPart('radec')], FS.newPart('radec'), { x: 0, y: -0.6 - 0.3 }, SNAP) ===
      null ||
      Build.candidate(parts, [FS.newPart('radec')], FS.newPart('radec'), { x: 0, y: -0.9 }, SNAP).kind ===
        'srf',
    'a side decoupler never stacks on a node',
  );
  const chute = FS.newPart('canopy');
  FS.relayout([chute]);
  const under = { x: 0, y: parts[0].pos.y - 0.65 - 0.225 };
  const candidate = Build.candidate(parts, [chute], chute, under, SNAP);
  check(
    !candidate || candidate.kind !== 'bottom',
    'a parachute has no top node, so it cannot hang below a capsule',
  );
  parts = drop(parts, 'canopy', { x: 0.2, y: 0.9 });
  check(parts && parts[1].node === 'top', 'a parachute snaps on top of the capsule');
  const tank = FS.newPart('t100');
  FS.relayout([tank]);
  const tankCandidate = Build.candidate(
    parts,
    [tank],
    tank,
    { x: 0, y: parts[1].pos.y + 0.225 + 0.375 },
    SNAP,
  );
  check(!tankCandidate || tankCandidate.parent !== parts[1], 'nothing can go on top of a parachute');
}

// --- Carrying a part takes everything below it ---
{
  let parts = FS.stackToParts(['lark', 'decoupler', 't400', 'gnat']);
  const tank = parts[2];
  const held = FS.subtree(parts, tank);
  check(
    held.map((part) => part.def.id).join() === 't400,gnat',
    'picking up a tank carries the engine below it',
  );
  parts = parts.filter((part) => !held.includes(part));
  Build.placeHeld(held, tank, { x: 5, y: 5 });
  check(Math.abs(held[1].pos.x - 5) < 1e-9 && held[1].pos.y < 5, 'the engine moves with the tank');
  const freeNode = Build.freeNodes(parts).find(
    (node) => node.part.def.id === 'decoupler' && node.node === 'bottom',
  );
  const cand = Build.candidate(
    parts,
    held,
    tank,
    { x: freeNode.pos.x + 0.3, y: freeNode.pos.y - 0.95 + 0.4 },
    SNAP,
  );
  check(
    cand &&
      cand.kind === 'bottom' &&
      cand.parent === freeNode.part &&
      !Build.blocker(parts, held, tank, cand),
    'the tank snaps back under the decoupler',
  );
  parts = Build.attach(parts, held, tank, cand);
  check(
    shape(parts) === shape(FS.stackToParts(['lark', 'decoupler', 't400', 'gnat'])),
    'and the craft is whole again',
  );
  check(parts[1].w === 1.25, 'the decoupler takes the width of its neighbours');
}

// --- Re-rooting keeps the craft's shape and staging ---
{
  const reference = FS.stackToParts(['canopy', 'lark', 'decoupler', 't400', 'wren']);
  const parts = FS.stackToParts(['canopy', 'lark', 'decoupler', 't400', 'wren']);
  const before = parts.map((part) => ({ ...part.pos }));
  const lark = parts[1];
  Build.reroot(parts, lark);
  check(parts[0] === lark && !lark.parent, 'the chosen part becomes the root, listed first');
  check(
    parts.every((part) => {
      const referenceIndex = reference.findIndex(
        (referencePart) =>
          referencePart.def.id === part.def.id && Math.abs(referencePart.pos.y - part.pos.y) < 1e-9,
      );
      return referenceIndex >= 0;
    }),
    'every part stays where it was',
  );
  check(
    parts.find((part) => part.def.id === 'canopy').node === 'top',
    'the parachute now sits on top of the capsule',
  );
  near(dvOf(parts), dvOf(reference), 0.5, 'the Δv is unchanged');
  const again = FS.partsFromSerial(FS.serialParts(parts));
  check(shape(again) === shape(parts), 'a re-rooted craft saves and loads unchanged');
  check(before.length === parts.length, 'no parts lost');
}

// --- Picking: the smallest part under the pointer wins ---
{
  const parts = FS.partsFromSerial(FS.SAMPLE_CRAFT.find((craft) => craft.name === 'Twin Boosters').tree);
  const decoupler = parts.find((part) => part.def.id === 'radec' && part.pos.x > 0);
  check(
    Build.partAt(parts, { x: decoupler.pos.x - 0.1, y: decoupler.pos.y }) === decoupler,
    'a side decoupler can be picked over the tank behind it',
  );
  check(Build.partAt(parts, { x: 20, y: 0 }) === null, 'empty space picks nothing');
}

// ================= Step A3: precision tools =================
const RADIANS_PER_DEGREE = Math.PI / 180;
// Drop a held group with mirror symmetry, the way the editor does (place()).
function dropMirrored(parts, held, root, spot) {
  Build.placeHeld(held, root, spot);
  const cand = Build.candidate(parts, held, root, spot, SNAP, true);
  if (!cand || Build.blocker(parts, held, root, cand, true)) {
    return null;
  }
  const line = Build.mirrorFor(parts, cand.parent, cand.kind);
  let all = Build.attach(parts, held, root, cand);
  if (line) {
    const twin = Build.makeTwin(held, line, cand.kind);
    Build.linkTwins(held, twin);
    all = all.concat(twin);
    FS.relayout(all);
  }
  return all;
}
const part = (partId, spin = 0) => {
  const newPart = FS.newPart(partId);
  newPart.spin = spin;
  FS.relayout([newPart]);
  return newPart;
};

// --- Mirror: side boosters in pairs; parts on a twin get twins on the other twin ---
{
  let parts = FS.stackToParts(['lark', 't400', 'decoupler', 't800', 't800', 'kestrel']);
  const core = parts[3];
  const lower = parts[4];
  const decoupler = part('radec');
  parts = dropMirrored(parts, [decoupler], decoupler, Vector.add(core.pos, { x: 0.9, y: 0.2 }));
  const decTwin = Build.twinOf(parts, decoupler);
  check(
    decTwin &&
      decTwin.parent === core &&
      Math.abs(decTwin.pos.x + decoupler.pos.x - 2 * core.pos.x) < 1e-9 &&
      decTwin.flip !== decoupler.flip,
    'mirror on: a side decoupler comes with a twin on the other side',
  );
  const booster = part('rumbler');
  parts = dropMirrored(parts, [booster], booster, Vector.add(decoupler.pos, { x: 0.7, y: 0 }));
  const booTwin = Build.twinOf(parts, booster);
  check(
    booTwin && booTwin.parent === decTwin,
    'a booster on a twinned decoupler gets its twin on the other decoupler',
  );
  const stagePattern = FS.stagesOf(parts)
    .map((stage) => (stage.decouple ? 'D' : '') + (stage.ignite ? 'I' : ''))
    .join(' ');
  check(stagePattern.startsWith('I D'), `the mirrored boosters stage like the sample (${stagePattern})`);
  const centre = FS.centreOfThrust(FS.stagesOf(parts)[0].engines);
  check(
    Math.abs(centre.pos.x - core.pos.x) < 1e-9 && Math.abs(centre.dir.x) < 1e-9,
    'mirrored boosters keep the thrust on the centre line',
  );

  // --- Rotate: tilted fins, mirrored the other way, staying on the surface ---
  const fin = part('sweptfin', 15 * RADIANS_PER_DEGREE);
  parts = dropMirrored(parts, [fin], fin, Vector.add(lower.pos, { x: 1.0, y: -1.4 }));
  check(!!parts, 'tilted fins fit on the tank below the boosters');
  const finTwin = Build.twinOf(parts, fin);
  near(fin.rot / RADIANS_PER_DEGREE, 15, 0.01, 'the fin is tilted 15°');
  near(finTwin.rot / RADIANS_PER_DEGREE, -15, 0.01, 'its twin is tilted the mirror way');
  const inner = (part) => Math.min(...Build.quad(part).map((corner) => Math.abs(corner.x - lower.pos.x)));
  near(inner(fin), 0.625, 0.001, 'the tilted fin still touches the tank (inner corner on the surface)');
  check(
    !Build.moveOnSurface(parts, fin, Build.surfaceHeight(fin), fin.rot + 15 * RADIANS_PER_DEGREE),
    'turning a placed fin another 15° works',
  );
  near(finTwin.rot / RADIANS_PER_DEGREE, -30, 0.01, '…and its twin turns the mirror way');

  // --- Offset: slide along the parent; the twin follows; overlaps are refused ---
  const startY = Build.surfaceHeight(fin);
  check(!Build.moveOnSurface(parts, fin, startY - 0.25, fin.rot), 'a fin slides 0.25 m down its tank');
  near(Build.surfaceHeight(finTwin), startY - 0.25, 1e-9, '…and its twin slides with it');
  const blocked = Build.moveOnSurface(parts, fin, 1.875, fin.rot);
  check(
    blocked && blocked.def.id === 'rumbler',
    `sliding the fin up into the booster is refused (blocked by the ${blocked && blocked.def.name})`,
  );
  near(Build.surfaceHeight(fin), startY - 0.25, 1e-9, '…and leaves it where it was');

  // --- Saving keeps angles, offsets and mirror links ---
  const again = FS.partsFromSerial(FS.serialParts(parts));
  check(
    JSON.stringify(FS.serialParts(again)) === JSON.stringify(FS.serialParts(parts)),
    'a mirrored, tilted craft saves and loads unchanged',
  );
  check(
    Build.twinOf(again, again[parts.indexOf(fin)]) === again[parts.indexOf(finTwin)],
    'mirror links survive saving',
  );

  // --- Turning a parent carries its side parts round with it ---
  const pod = FS.stackToParts(['t400']);
  const secondFin = FS.attachPart(pod, 'sweptfin', pod[0], { x: 0.9, y: 0 });
  pod[0].rot = 30 * RADIANS_PER_DEGREE;
  FS.relayout(pod);
  const expected = FS.rotV({ x: 0.9, y: 0 }, 30 * RADIANS_PER_DEGREE);
  check(
    Math.abs(secondFin.pos.x - expected.x) < 1e-9 &&
      Math.abs(secondFin.pos.y - expected.y) < 1e-9 &&
      Math.abs(secondFin.rot - 30 * RADIANS_PER_DEGREE) < 1e-9,
    'side parts turn with the part they hang on',
  );

  // --- Copies are new parts with their own mirror links ---
  const copy = Build.clone(FS.subtree(parts, core));
  check(
    copy.length === FS.subtree(parts, core).length && copy.every((copied) => !parts.includes(copied)),
    'a copy has the same parts, all new',
  );
  check(
    copy.filter((copied) => copied.sym).every((copied) => !parts.some((part) => part.sym === copied.sym)),
    'a copy gets its own mirror links',
  );
}

// --- Overlays: the centre of pressure moves behind the centre of mass with fins ---
{
  const bare = FS.stackToParts(['lark', 't800', 't800', 'kestrel']);
  const finned = FS.stackToParts(['lark', 't800', 't800', 'fins', 'kestrel']);
  const bareAhead = FS.centreOfPressure(bare).ahead;
  const finnedAhead = FS.centreOfPressure(finned).ahead;
  check(
    bareAhead > 0 && finnedAhead < 0,
    `fins move the centre of pressure from ahead of the centre of mass (${bareAhead.toFixed(2)} m) to behind it (${finnedAhead.toFixed(2)} m)`,
  );
  // and flight agrees: a finned rocket turns back into the airflow without SAS
  const fakeG = { emit() {} };
  const flyTest = (src) => {
    const vessel = new FS.Vessel('t', src, FS.root, {});
    vessel.landed = null;
    vessel.sas = false;
    vessel.r = { x: FS.root.R + 4000, y: 0 };
    vessel.v = Vector.add(FS.airVel(FS.root, vessel.r), { x: 300, y: 0 });
    vessel.angle = 5 * RADIANS_PER_DEGREE;
    for (let step = 0; step < 300; step++) {
      vessel.step(0.02, step * 0.02, fakeG);
    }
    const airVelocity = Vector.sub(vessel.v, FS.airVel(FS.root, vessel.r));
    return (
      Math.abs(FS.wrapAngle(vessel.angle - Math.atan2(airVelocity.y, airVelocity.x))) / RADIANS_PER_DEGREE
    );
  };
  const finnedTurn = flyTest(FS.serialParts(finned));
  const bareTurn = flyTest(FS.serialParts(bare));
  check(
    finnedTurn < 5 && bareTurn > 5,
    `in flight, the finned rocket straightens (5° → ${finnedTurn.toFixed(1)}°) and the bare one doesn't (→ ${bareTurn.toFixed(1)}°)`,
  );
}

done();
