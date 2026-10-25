// The simulation through FS.game (sim.js, warp.js, nodes.js), with no page around it.
const { loadGame, check, near, done } = require('./lib');
const FS = loadGame();
const Vector = FS.vec;
const game = FS.game;

const seen = [];
for (const type of ['flight-start', 'staged', 'soi', 'message']) {
  game.on(type, (data) => seen.push(type));
}

const orbiter = FS.SAMPLE_CRAFT.find((craft) => craft.name === 'Orbiter I');

// --- Events, and staged debris kept through time warp ---
{
  game.newFlight({ name: orbiter.name, parts: orbiter.parts.slice() });
  check(seen.includes('flight-start'), 'starting a flight emits "flight-start"');
  game.debugOrbit(100000);
  const vessel = game.vessel;
  vessel.stage(game); // ignite
  vessel.stage(game); // drop the first stage
  check(
    seen.includes('staged') && game.debris.length === 1,
    'staging emits "staged" and the dropped stage becomes debris',
  );

  game.update(0.05); // one physics frame with the throttle closed
  game.warpIdx = 3; // 50×, on rails
  for (let step = 0; step < 20; step++) {
    game.update(0.05);
  }
  check(game.onRails, 'time warp puts the craft on rails');
  check(game.debris.length === 1 && game.debris[0].rails, 'debris stays, and goes on rails too');
  const gap = Vector.len(Vector.sub(game.debris[0].r, vessel.r));
  check(gap > 1 && gap < 1000, `debris keeps flying nearby on rails (${gap.toFixed(1)} m away)`);
  game.stopWarp();
  game.update(0.05);
  check(!game.onRails && !game.debris[0].rails, 'stopping warp takes craft and debris off rails');
}

// --- A node placed beyond a Mira encounter survives the SOI change ---
{
  game.newFlight({ name: 'Probe', parts: ['sparrow', 't100', 'gnat'] });
  game.debugOrbit(100000);
  const vessel = game.vessel;
  const orbitRadius = Vector.len(vessel.r);
  let found = false;
  for (let angle = 0; angle < FS.TAU && !found; angle += 0.05) {
    const position = Vector.fromAngle(angle, orbitRadius);
    const speed = Math.sqrt(FS.root.mu / orbitRadius) + 860;
    const velocity = { x: Math.sin(angle) * speed, y: -Math.cos(angle) * speed };
    const patches = FS.predictPatches(FS.root, position, velocity, game.t, 3);
    if (patches[0].end === 'encounter') {
      vessel.r = position;
      vessel.v = velocity;
      found = true;
    }
  }
  check(found, 'set up a transfer orbit that meets Mira');
  game.patchTimer = 0;
  game.update(0.02);
  const secondPatch = game.patches[1];
  check(secondPatch && secondPatch.body.name === 'Mira', 'the predicted path has a Mira patch');

  const tNode =
    secondPatch.tStart + 0.3 * (Math.min(secondPatch.tEnd, secondPatch.tStart + 20000) - secondPatch.tStart);
  const node = game.createNode(tNode);
  check(node && node.body.name === 'Mira' && node.patchIndex === 1, 'a node can be placed on the Mira patch');
  check(
    node && node.originT === secondPatch.tStart,
    'that node is drawn relative to Mira at the start of the patch',
  );
  game.editNode('pro', -50);
  check(
    game.nodePatches && game.nodePatches[0].body.name === 'Mira',
    'the planned path after the node starts at Mira',
  );

  // Warp until the craft enters Mira's sphere of influence
  for (let step = 0; step < 4000 && vessel.body === FS.root; step++) {
    game.changeWarp(7);
    game.update(0.1);
  }
  check(vessel.body.name === 'Mira', "warping carries the craft into Mira's sphere of influence");
  check(!!game.node, 'the node survives the SOI change');
  check(
    game.node && game.node.body.name === 'Mira' && game.node.patchIndex === 0,
    'the node is now on the current (Mira) patch',
  );
  near(game.node ? game.node.t : 0, tNode, 0.001, 'the node keeps its time');
}

done();
