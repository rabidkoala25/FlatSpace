// The simulation through FS.game (sim.js, warp.js, nodes.js), with no page around it.
const { loadGame, check, near, done } = require('./lib');
const FS = loadGame();
const V = FS.vec;
const G = FS.game;

const seen = [];
for (const type of ['flight-start', 'staged', 'soi', 'message']) G.on(type, (d) => seen.push(type));

const orbiter = FS.SAMPLE_CRAFT.find((c) => c.name === 'Orbiter I');

// --- Events, and staged debris kept through time warp ---
{
  G.newFlight({ name: orbiter.name, parts: orbiter.parts.slice() });
  check(seen.includes('flight-start'), 'starting a flight emits "flight-start"');
  G.debugOrbit(100000);
  const v = G.vessel;
  v.stage(G); // ignite
  v.stage(G); // drop the first stage
  check(seen.includes('staged') && G.debris.length === 1, 'staging emits "staged" and the dropped stage becomes debris');

  G.update(0.05); // one physics frame with the throttle closed
  G.warpIdx = 3;  // 50×, on rails
  for (let i = 0; i < 20; i++) G.update(0.05);
  check(G.onRails, 'time warp puts the craft on rails');
  check(G.debris.length === 1 && G.debris[0].rails, 'debris stays, and goes on rails too');
  const gap = V.len(V.sub(G.debris[0].r, v.r));
  check(gap > 1 && gap < 1000, `debris keeps flying nearby on rails (${gap.toFixed(1)} m away)`);
  G.stopWarp();
  G.update(0.05);
  check(!G.onRails && !G.debris[0].rails, 'stopping warp takes craft and debris off rails');
}

// --- A node placed beyond a Mira encounter survives the SOI change ---
{
  G.newFlight({ name: 'Probe', parts: ['sparrow', 't100', 'gnat'] });
  G.debugOrbit(100000);
  const v = G.vessel;
  const R0 = V.len(v.r);
  let found = false;
  for (let ang = 0; ang < FS.TAU && !found; ang += 0.05) {
    const r = V.fromAngle(ang, R0);
    const sp = Math.sqrt(FS.root.mu / R0) + 860;
    const vel = { x: Math.sin(ang) * sp, y: -Math.cos(ang) * sp };
    const p = FS.predictPatches(FS.root, r, vel, G.t, 3);
    if (p[0].end === 'encounter') { v.r = r; v.v = vel; found = true; }
  }
  check(found, 'set up a transfer orbit that meets Mira');
  G.patchTimer = 0;
  G.update(0.02);
  const p1 = G.patches[1];
  check(p1 && p1.body.name === 'Mira', 'the predicted path has a Mira patch');

  const tNode = p1.tStart + 0.3 * (Math.min(p1.tEnd, p1.tStart + 20000) - p1.tStart);
  const nd = G.createNode(tNode);
  check(nd && nd.body.name === 'Mira' && nd.patchIndex === 1, 'a node can be placed on the Mira patch');
  check(nd && nd.originT === p1.tStart, 'that node is drawn relative to Mira at the start of the patch');
  G.editNode('pro', -50);
  check(G.nodePatches && G.nodePatches[0].body.name === 'Mira', 'the planned path after the node starts at Mira');

  // Warp until the craft enters Mira's sphere of influence
  for (let i = 0; i < 4000 && v.body === FS.root; i++) { G.changeWarp(7); G.update(0.1); }
  check(v.body.name === 'Mira', 'warping carries the craft into Mira\'s sphere of influence');
  check(!!G.node, 'the node survives the SOI change');
  check(G.node && G.node.body.name === 'Mira' && G.node.patchIndex === 0, 'the node is now on the current (Mira) patch');
  near(G.node ? G.node.t : 0, tNode, 0.001, 'the node keeps its time');
}

done();
