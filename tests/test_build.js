// Drag-and-drop building (build.js): snapping to stack nodes and sides, overlap checks,
// carrying parts, re-rooting, and rebuilding every sample craft by dragging alone.
const { loadGame, check, near, done } = require('./lib');
const Flatspace = loadGame();
const Build = Flatspace.Build;
const Vector = Flatspace.Vector;
const SNAP = 34 / 20; // the editor's 34 px snap at 20 px per metre

// Drag part `id` and let go with its centre at `at`, the way the editor does.
// Returns the new part list, or null when the drop is refused (the part goes back to the tray).
function drop(parts, partId, spot) {
  const part = Flatspace.newPart(partId);
  Flatspace.relayout([part]);
  Build.placeHeld([part], part, spot);
  const candidate = Build.candidate(parts, [part], part, spot, SNAP);
  if (!candidate || Build.blocker(parts, [part], part, candidate)) {
    return null;
  }
  return Build.attach(parts, [part], part, candidate);
}

// A sloppy drop below the lowest free bottom node: off by up to half a metre each way.
function dropBelow(parts, partId, dropNumber) {
  if (!parts.length) {
    return drop(parts, partId, { x: 3, y: 5 });
  }
  const freeNode = Build.freeNodes(parts)
    .filter((node) => node.node === 'bottom')
    .sort((first, second) => first.position.y - second.position.y)[0];
  const jitterX = ((dropNumber * 37) % 7) / 14 - 0.25;
  const jitterY = ((dropNumber * 53) % 5) / 10 - 0.2;
  return drop(parts, partId, {
    x: freeNode.position.x + jitterX,
    y: freeNode.position.y - Flatspace.PART[partId].length / 2 + jitterY,
  });
}

// Stack-built craft compare by shape: every part's offset from the root, in order.
const shape = (parts) =>
  parts
    .map(
      (part) =>
        `${part.type.id}@${(part.position.x - parts[0].position.x).toFixed(3)},${(part.position.y - parts[0].position.y).toFixed(3)}`,
    )
    .join(' ');
const deltaVOf = (parts) => Flatspace.stageStats(parts, Flatspace.stagesOf(parts), 0, 0, 9.81).total;

// --- Every stack sample craft can be rebuilt by dragging alone ---
for (const craft of Flatspace.SAMPLE_CRAFT.filter((sample) => sample.parts)) {
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
  const reference = Flatspace.stackToParts(craft.parts);
  check(
    allMatch && shape(parts) === shape(reference),
    `${craft.name} rebuilt by dragging matches the sample part for part`,
  );
  near(deltaVOf(parts), deltaVOf(reference), 0.5, `${craft.name} rebuilt has the same Δv`);
}

// --- Twin Boosters: the stack, then side decouplers and boosters on each side ---
{
  const reference = Flatspace.partsFromSerial(
    Flatspace.SAMPLE_CRAFT.find((craft) => craft.name === 'Twin Boosters').tree,
  );
  let parts = [];
  ['canopy', 'lark', 'decoupler', 't400', 'wren', 'decoupler', 't800', 't800', 'kestrel'].forEach(
    (partId, index) => (parts = dropBelow(parts, partId, index)),
  );
  const tank = parts[7];
  for (const side of [1, -1]) {
    parts = drop(parts, 'sidedecoupler', Vector.add(tank.position, { x: side * 0.95, y: 0.3 }));
    check(!!parts, `a side decoupler snaps to the ${side > 0 ? 'right' : 'left'} of the lower tank`);
    const decoupler = parts[parts.length - 1];
    check(
      decoupler.parent === tank &&
        decoupler.node === 'surface' &&
        Math.abs(decoupler.position.y - tank.position.y) < 1e-9,
      '  …centred on the tank (snapped to the middle of its side)',
    );
    parts = drop(parts, 'rumbler', Vector.add(decoupler.position, { x: side * 0.6, y: -0.25 }));
    check(
      !!parts && parts[parts.length - 1].parent === decoupler,
      '  …and a booster attaches to the decoupler',
    );
  }
  const positionsOf = (partList) =>
    partList
      .map(
        (part) =>
          `${part.type.id}@${(part.position.x - partList[0].position.x + 1e-6).toFixed(2)},${(part.position.y - partList[0].position.y + 1e-6).toFixed(2)}`,
      )
      .sort()
      .join(' ');
  check(
    positionsOf(parts) === positionsOf(reference),
    'Twin Boosters rebuilt by dragging matches the sample',
  );
  const stagePattern = Flatspace.stagesOf(parts)
    .map((stage) => (stage.decouple ? 'D' : '') + (stage.ignite ? 'I' : '') + (stage.chutes ? 'C' : ''))
    .join(' ');
  check(stagePattern === 'I D DI D C', `…and stages the same way (${stagePattern})`);
  near(deltaVOf(parts), deltaVOf(reference), 0.5, '…with the same Δv');

  // a tank pushed against the booster overlaps it and is refused
  const booster = parts.find((part) => part.type.id === 'rumbler' && part.position.x > 0);
  const newTank = Flatspace.newPart('t400');
  Flatspace.relayout([newTank]);
  const onTank = {
    kind: 'surface',
    parent: tank,
    side: 1,
    position: Vector.add(tank.position, { x: 1.25, y: 0 }),
    rotation: 0,
    distance: 0,
  };
  const hit = Build.blocker(parts, [newTank], newTank, onTank);
  check(
    hit && (hit.type.id === 'sidedecoupler' || hit.type.id === 'rumbler'),
    'a tank on the side where the booster hangs is blocked by it',
  );
  const candidate = Build.candidate(
    parts,
    [newTank],
    newTank,
    Vector.add(tank.position, { x: 1.3, y: 0 }),
    SNAP,
  );
  check(
    candidate && Build.blocker(parts, [newTank], newTank, candidate),
    '…and so is every spot in reach of that drop (the ghost shows red)',
  );
  const boosterCandidate = Build.candidate(
    parts,
    [newTank],
    newTank,
    Vector.add(booster.position, { x: 1.1, y: 0 }),
    SNAP,
  );
  check(
    boosterCandidate &&
      boosterCandidate.parent === booster &&
      !Build.blocker(parts, [newTank], newTank, boosterCandidate),
    'the outer side of the booster is free',
  );
  check(
    drop(parts, 't100', Vector.add(booster.position, { x: 9, y: 0 })) === null,
    'a part dropped far from the craft is refused',
  );
}

// --- Rules for nodes ---
{
  let parts = drop([], 'lark', { x: 0, y: 0 });
  check(
    Build.candidate(
      parts,
      [Flatspace.newPart('sidedecoupler')],
      Flatspace.newPart('sidedecoupler'),
      { x: 0, y: -0.6 - 0.3 },
      SNAP,
    ) === null ||
      Build.candidate(
        parts,
        [Flatspace.newPart('sidedecoupler')],
        Flatspace.newPart('sidedecoupler'),
        { x: 0, y: -0.9 },
        SNAP,
      ).kind === 'surface',
    'a side decoupler never stacks on a node',
  );
  const chute = Flatspace.newPart('canopy');
  Flatspace.relayout([chute]);
  const under = { x: 0, y: parts[0].position.y - 0.65 - 0.225 };
  const candidate = Build.candidate(parts, [chute], chute, under, SNAP);
  check(
    !candidate || candidate.kind !== 'bottom',
    'a parachute has no top node, so it cannot hang below a capsule',
  );
  parts = drop(parts, 'canopy', { x: 0.2, y: 0.9 });
  check(parts && parts[1].node === 'top', 'a parachute snaps on top of the capsule');
  const tank = Flatspace.newPart('t100');
  Flatspace.relayout([tank]);
  const tankCandidate = Build.candidate(
    parts,
    [tank],
    tank,
    { x: 0, y: parts[1].position.y + 0.225 + 0.375 },
    SNAP,
  );
  check(!tankCandidate || tankCandidate.parent !== parts[1], 'nothing can go on top of a parachute');
}

// --- Carrying a part takes everything below it ---
{
  let parts = Flatspace.stackToParts(['lark', 'decoupler', 't400', 'gnat']);
  const tank = parts[2];
  const held = Flatspace.subtree(parts, tank);
  check(
    held.map((part) => part.type.id).join() === 't400,gnat',
    'picking up a tank carries the engine below it',
  );
  parts = parts.filter((part) => !held.includes(part));
  Build.placeHeld(held, tank, { x: 5, y: 5 });
  check(Math.abs(held[1].position.x - 5) < 1e-9 && held[1].position.y < 5, 'the engine moves with the tank');
  const freeNode = Build.freeNodes(parts).find(
    (node) => node.part.type.id === 'decoupler' && node.node === 'bottom',
  );
  const candidate = Build.candidate(
    parts,
    held,
    tank,
    { x: freeNode.position.x + 0.3, y: freeNode.position.y - 0.95 + 0.4 },
    SNAP,
  );
  check(
    candidate &&
      candidate.kind === 'bottom' &&
      candidate.parent === freeNode.part &&
      !Build.blocker(parts, held, tank, candidate),
    'the tank snaps back under the decoupler',
  );
  parts = Build.attach(parts, held, tank, candidate);
  check(
    shape(parts) === shape(Flatspace.stackToParts(['lark', 'decoupler', 't400', 'gnat'])),
    'and the craft is whole again',
  );
  check(parts[1].width === 1.25, 'the decoupler takes the width of its neighbours');
}

// --- Re-rooting keeps the craft's shape and staging ---
{
  const reference = Flatspace.stackToParts(['canopy', 'lark', 'decoupler', 't400', 'wren']);
  const parts = Flatspace.stackToParts(['canopy', 'lark', 'decoupler', 't400', 'wren']);
  const before = parts.map((part) => ({ ...part.position }));
  const lark = parts[1];
  Build.reroot(parts, lark);
  check(parts[0] === lark && !lark.parent, 'the chosen part becomes the root, listed first');
  check(
    parts.every((part) => {
      const referenceIndex = reference.findIndex(
        (referencePart) =>
          referencePart.type.id === part.type.id &&
          Math.abs(referencePart.position.y - part.position.y) < 1e-9,
      );
      return referenceIndex >= 0;
    }),
    'every part stays where it was',
  );
  check(
    parts.find((part) => part.type.id === 'canopy').node === 'top',
    'the parachute now sits on top of the capsule',
  );
  near(deltaVOf(parts), deltaVOf(reference), 0.5, 'the Δv is unchanged');
  const again = Flatspace.partsFromSerial(Flatspace.serialParts(parts));
  check(shape(again) === shape(parts), 'a re-rooted craft saves and loads unchanged');
  check(before.length === parts.length, 'no parts lost');
}

// --- Picking: the smallest part under the pointer wins ---
{
  const parts = Flatspace.partsFromSerial(
    Flatspace.SAMPLE_CRAFT.find((craft) => craft.name === 'Twin Boosters').tree,
  );
  const decoupler = parts.find((part) => part.type.id === 'sidedecoupler' && part.position.x > 0);
  check(
    Build.partAt(parts, { x: decoupler.position.x - 0.1, y: decoupler.position.y }) === decoupler,
    'a side decoupler can be picked over the tank behind it',
  );
  check(Build.partAt(parts, { x: 20, y: 0 }) === null, 'empty space picks nothing');
}

// ================= Step A3: precision tools =================
const RADIANS_PER_DEGREE = Math.PI / 180;
// Drop a held group with mirror symmetry, the way the editor does (place()).
function dropMirrored(parts, held, root, spot) {
  Build.placeHeld(held, root, spot);
  const candidate = Build.candidate(parts, held, root, spot, SNAP, true);
  if (!candidate || Build.blocker(parts, held, root, candidate, true)) {
    return null;
  }
  const line = Build.mirrorFor(parts, candidate.parent, candidate.kind);
  let all = Build.attach(parts, held, root, candidate);
  if (line) {
    const twin = Build.makeTwin(held, line, candidate.kind);
    Build.linkTwins(held, twin);
    all = all.concat(twin);
    Flatspace.relayout(all);
  }
  return all;
}
const part = (partId, spin = 0) => {
  const newPart = Flatspace.newPart(partId);
  newPart.spin = spin;
  Flatspace.relayout([newPart]);
  return newPart;
};

// --- Mirror: side boosters in pairs; parts on a twin get twins on the other twin ---
{
  let parts = Flatspace.stackToParts(['lark', 't400', 'decoupler', 't800', 't800', 'kestrel']);
  const core = parts[3];
  const lower = parts[4];
  const decoupler = part('sidedecoupler');
  parts = dropMirrored(parts, [decoupler], decoupler, Vector.add(core.position, { x: 0.9, y: 0.2 }));
  const decouplerTwin = Build.twinOf(parts, decoupler);
  check(
    decouplerTwin &&
      decouplerTwin.parent === core &&
      Math.abs(decouplerTwin.position.x + decoupler.position.x - 2 * core.position.x) < 1e-9 &&
      decouplerTwin.flip !== decoupler.flip,
    'mirror on: a side decoupler comes with a twin on the other side',
  );
  const booster = part('rumbler');
  parts = dropMirrored(parts, [booster], booster, Vector.add(decoupler.position, { x: 0.7, y: 0 }));
  const booTwin = Build.twinOf(parts, booster);
  check(
    booTwin && booTwin.parent === decouplerTwin,
    'a booster on a twinned decoupler gets its twin on the other decoupler',
  );
  const stagePattern = Flatspace.stagesOf(parts)
    .map((stage) => (stage.decouple ? 'D' : '') + (stage.ignite ? 'I' : ''))
    .join(' ');
  check(stagePattern.startsWith('I D'), `the mirrored boosters stage like the sample (${stagePattern})`);
  const centre = Flatspace.centreOfThrust(Flatspace.stagesOf(parts)[0].engines);
  check(
    Math.abs(centre.position.x - core.position.x) < 1e-9 && Math.abs(centre.direction.x) < 1e-9,
    'mirrored boosters keep the thrust on the centre line',
  );

  // --- Rotate: tilted fins, mirrored the other way, staying on the surface ---
  const fin = part('sweptfin', 15 * RADIANS_PER_DEGREE);
  parts = dropMirrored(parts, [fin], fin, Vector.add(lower.position, { x: 1.0, y: -1.4 }));
  check(!!parts, 'tilted fins fit on the tank below the boosters');
  const finTwin = Build.twinOf(parts, fin);
  near(fin.rotation / RADIANS_PER_DEGREE, 15, 0.01, 'the fin is tilted 15°');
  near(finTwin.rotation / RADIANS_PER_DEGREE, -15, 0.01, 'its twin is tilted the mirror way');
  const inner = (part) =>
    Math.min(...Build.corners(part).map((corner) => Math.abs(corner.x - lower.position.x)));
  near(inner(fin), 0.625, 0.001, 'the tilted fin still touches the tank (inner corner on the surface)');
  check(
    !Build.moveOnSurface(parts, fin, Build.surfaceHeight(fin), fin.rotation + 15 * RADIANS_PER_DEGREE),
    'turning a placed fin another 15° works',
  );
  near(finTwin.rotation / RADIANS_PER_DEGREE, -30, 0.01, '…and its twin turns the mirror way');

  // --- Offset: slide along the parent; the twin follows; overlaps are refused ---
  const startY = Build.surfaceHeight(fin);
  check(!Build.moveOnSurface(parts, fin, startY - 0.25, fin.rotation), 'a fin slides 0.25 m down its tank');
  near(Build.surfaceHeight(finTwin), startY - 0.25, 1e-9, '…and its twin slides with it');
  const blocked = Build.moveOnSurface(parts, fin, 1.875, fin.rotation);
  check(
    blocked && blocked.type.id === 'rumbler',
    `sliding the fin up into the booster is refused (blocked by the ${blocked && blocked.type.name})`,
  );
  near(Build.surfaceHeight(fin), startY - 0.25, 1e-9, '…and leaves it where it was');

  // --- Saving keeps angles, offsets and mirror links ---
  const again = Flatspace.partsFromSerial(Flatspace.serialParts(parts));
  check(
    JSON.stringify(Flatspace.serialParts(again)) === JSON.stringify(Flatspace.serialParts(parts)),
    'a mirrored, tilted craft saves and loads unchanged',
  );
  check(
    Build.twinOf(again, again[parts.indexOf(fin)]) === again[parts.indexOf(finTwin)],
    'mirror links survive saving',
  );

  // --- Turning a parent carries its side parts round with it ---
  const pod = Flatspace.stackToParts(['t400']);
  const secondFin = Flatspace.attachPart(pod, 'sweptfin', pod[0], { x: 0.9, y: 0 });
  pod[0].rotation = 30 * RADIANS_PER_DEGREE;
  Flatspace.relayout(pod);
  const expected = Flatspace.rotateVector({ x: 0.9, y: 0 }, 30 * RADIANS_PER_DEGREE);
  check(
    Math.abs(secondFin.position.x - expected.x) < 1e-9 &&
      Math.abs(secondFin.position.y - expected.y) < 1e-9 &&
      Math.abs(secondFin.rotation - 30 * RADIANS_PER_DEGREE) < 1e-9,
    'side parts turn with the part they hang on',
  );

  // --- Copies are new parts with their own mirror links ---
  const copy = Build.clone(Flatspace.subtree(parts, core));
  check(
    copy.length === Flatspace.subtree(parts, core).length && copy.every((copied) => !parts.includes(copied)),
    'a copy has the same parts, all new',
  );
  check(
    copy
      .filter((copied) => copied.symmetryGroup)
      .every((copied) => !parts.some((part) => part.symmetryGroup === copied.symmetryGroup)),
    'a copy gets its own mirror links',
  );
}

// --- Overlays: the centre of pressure moves behind the centre of mass with fins ---
{
  const bare = Flatspace.stackToParts(['lark', 't800', 't800', 'kestrel']);
  const finned = Flatspace.stackToParts(['lark', 't800', 't800', 'fins', 'kestrel']);
  const bareAhead = Flatspace.centreOfPressure(bare).ahead;
  const finnedAhead = Flatspace.centreOfPressure(finned).ahead;
  check(
    bareAhead > 0 && finnedAhead < 0,
    `fins move the centre of pressure from ahead of the centre of mass (${bareAhead.toFixed(2)} m) to behind it (${finnedAhead.toFixed(2)} m)`,
  );
  // and flight agrees: a finned rocket turns back into the airflow without SAS
  const fakeGame = { emit() {} };
  const flyTest = (partIds) => {
    const vessel = new Flatspace.Vessel('t', partIds, Flatspace.root, {});
    vessel.landed = null;
    vessel.stabilityAssist = false;
    vessel.position = { x: Flatspace.root.radius + 4000, y: 0 };
    vessel.velocity = Vector.add(Flatspace.airVelocity(Flatspace.root, vessel.position), { x: 300, y: 0 });
    vessel.angle = 5 * RADIANS_PER_DEGREE;
    for (let step = 0; step < 300; step++) {
      vessel.step(0.02, step * 0.02, fakeGame);
    }
    const airVelocity = Vector.subtract(
      vessel.velocity,
      Flatspace.airVelocity(Flatspace.root, vessel.position),
    );
    return (
      Math.abs(Flatspace.wrapAngle(vessel.angle - Math.atan2(airVelocity.y, airVelocity.x))) /
      RADIANS_PER_DEGREE
    );
  };
  const finnedTurn = flyTest(Flatspace.serialParts(finned));
  const bareTurn = flyTest(Flatspace.serialParts(bare));
  check(
    finnedTurn < 5 && bareTurn > 5,
    `in flight, the finned rocket straightens (5° → ${finnedTurn.toFixed(1)}°) and the bare one doesn't (→ ${bareTurn.toFixed(1)}°)`,
  );
}

done();
