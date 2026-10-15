// On-rails accuracy, encounter prediction and SOI change.
const { loadGame, fakeGame, check, near, done } = require('./lib');
const FS = loadGame();
const V = FS.vec;

// --- One full orbit on rails returns to the same place ---
{
  const v = new FS.Vessel('Probe', ['sparrow'], FS.root, {});
  const R0 = 700000;
  v.r = { x: R0, y: 0 };
  v.v = { x: 0, y: -Math.sqrt(FS.root.mu / R0) * 1.1 };
  v.landed = null;
  v.goOnRails(0);
  const o = v.rails;
  const start = { ...v.r };
  v.railsTo(o.period, fakeGame());
  near(V.len(V.sub(v.r, start)), 0, 0.01, 'position after one orbit on rails (m)');
}

// --- Find a burn that meets Mira, then fly it on rails ---
{
  const game = fakeGame();
  const v = new FS.Vessel('Probe', ['sparrow'], FS.root, {});
  const R0 = 700000;
  let predicted = null;
  for (let ang = 0; ang < FS.TAU && !predicted; ang += 0.05) {
    const r = { x: Math.cos(ang) * R0, y: Math.sin(ang) * R0 };
    const sp = Math.sqrt(FS.root.mu / R0) + 860;
    const vel = { x: Math.sin(ang) * sp, y: -Math.cos(ang) * sp }; // clockwise orbit
    const patches = FS.predictPatches(FS.root, r, vel, 0, 3);
    const enc = patches.find((p) => p.end === 'encounter');
    if (enc) { predicted = enc; v.r = r; v.v = vel; v.landed = null; }
  }
  check(!!predicted && predicted.next.name === 'Mira', 'a prograde burn of 860 m/s finds a Mira encounter');
  if (predicted) {
    let t = 0;
    v.goOnRails(0);
    while (t < 400000 && v.body === FS.root) { t += 60; v.railsTo(t, game); }
    check(v.body.name === 'Mira', 'flying on rails enters Mira\'s sphere of influence');
    near(t, predicted.tEnd, 60, 'SOI change time matches the prediction (s)');
    check(game.events.some((e) => e.type === 'soi' && e.to === 'Mira'), 'an SOI-change event was raised');
  }
}

done();
