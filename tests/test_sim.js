// The simulation through Flatspace.game (sim.js, warp.js, nodes.js), with no page around it.
const { loadGame, check, near, done } = require('./lib');
const Flatspace = loadGame();
const Vector = Flatspace.Vector;
const game = Flatspace.game;

const seen = [];
for (const type of ['flight-start', 'staged', 'sphere-change', 'message']) {
  game.on(type, (data) => seen.push(type));
}

const orbiter = Flatspace.SAMPLE_CRAFT.find((craft) => craft.name === 'Orbiter I');

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
  game.warpIndex = 3; // 50×, on rails
  for (let step = 0; step < 20; step++) {
    game.update(0.05);
  }
  check(game.onRails, 'time warp puts the craft on rails');
  check(game.debris.length === 1 && game.debris[0].rails, 'debris stays, and goes on rails too');
  const gap = Vector.length(Vector.subtract(game.debris[0].position, vessel.position));
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
  const orbitRadius = Vector.length(vessel.position);
  let found = false;
  for (let angle = 0; angle < Flatspace.TAU && !found; angle += 0.05) {
    const position = Vector.fromAngle(angle, orbitRadius);
    const speed = Math.sqrt(Flatspace.root.gravityParameter / orbitRadius) + 860;
    const velocity = { x: Math.sin(angle) * speed, y: -Math.cos(angle) * speed };
    const patches = Flatspace.predictPatches(Flatspace.root, position, velocity, game.time, 3);
    if (patches[0].end === 'encounter') {
      vessel.position = position;
      vessel.velocity = velocity;
      found = true;
    }
  }
  check(found, 'set up a transfer orbit that meets Mira');
  game.patchTimer = 0;
  game.update(0.02);
  const secondPatch = game.patches[1];
  check(secondPatch && secondPatch.body.name === 'Mira', 'the predicted path has a Mira patch');

  const nodeTime =
    secondPatch.startTime +
    0.3 * (Math.min(secondPatch.endTime, secondPatch.startTime + 20000) - secondPatch.startTime);
  const node = game.createNode(nodeTime);
  check(node && node.body.name === 'Mira' && node.patchIndex === 1, 'a node can be placed on the Mira patch');
  check(
    node && node.originTime === secondPatch.startTime,
    'that node is drawn relative to Mira at the start of the patch',
  );
  game.editNode('prograde', -50);
  check(
    game.nodePatches && game.nodePatches[0].body.name === 'Mira',
    'the planned path after the node starts at Mira',
  );

  // Warp until the craft enters Mira's sphere of influence
  for (let step = 0; step < 4000 && vessel.body === Flatspace.root; step++) {
    game.changeWarp(7);
    game.update(0.1);
  }
  check(vessel.body.name === 'Mira', "warping carries the craft into Mira's sphere of influence");
  check(!!game.node, 'the node survives the SOI change');
  check(
    game.node && game.node.body.name === 'Mira' && game.node.patchIndex === 0,
    'the node is now on the current (Mira) patch',
  );
  near(game.node ? game.node.time : 0, nodeTime, 0.001, 'the node keeps its time');
}

done();
