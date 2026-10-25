// On-rails accuracy, encounter prediction and SOI change.
const { loadGame, fakeGame, check, near, done } = require('./lib');
const FS = loadGame();
const Vector = FS.vec;

// --- One full orbit on rails returns to the same place ---
{
  const vessel = new FS.Vessel('Probe', ['sparrow'], FS.root, {});
  const ORBIT_RADIUS = 700000;
  vessel.r = { x: ORBIT_RADIUS, y: 0 };
  vessel.v = { x: 0, y: -Math.sqrt(FS.root.mu / ORBIT_RADIUS) * 1.1 };
  vessel.landed = null;
  vessel.goOnRails(0);
  const orbit = vessel.rails;
  const start = { ...vessel.r };
  vessel.railsTo(orbit.period, fakeGame());
  near(Vector.len(Vector.sub(vessel.r, start)), 0, 0.01, 'position after one orbit on rails (m)');
}

// --- Find a burn that meets Mira, then fly it on rails ---
{
  const game = fakeGame();
  const vessel = new FS.Vessel('Probe', ['sparrow'], FS.root, {});
  const ORBIT_RADIUS = 700000;
  let predicted = null;
  for (let angle = 0; angle < FS.TAU && !predicted; angle += 0.05) {
    const position = { x: Math.cos(angle) * ORBIT_RADIUS, y: Math.sin(angle) * ORBIT_RADIUS };
    const speed = Math.sqrt(FS.root.mu / ORBIT_RADIUS) + 860;
    const velocity = { x: Math.sin(angle) * speed, y: -Math.cos(angle) * speed }; // clockwise orbit
    const patches = FS.predictPatches(FS.root, position, velocity, 0, 3);
    const encounter = patches.find((patch) => patch.end === 'encounter');
    if (encounter) {
      predicted = encounter;
      vessel.r = position;
      vessel.v = velocity;
      vessel.landed = null;
    }
  }
  check(!!predicted && predicted.next.name === 'Mira', 'a prograde burn of 860 m/s finds a Mira encounter');
  if (predicted) {
    let time = 0;
    vessel.goOnRails(0);
    while (time < 400000 && vessel.body === FS.root) {
      time += 60;
      vessel.railsTo(time, game);
    }
    check(vessel.body.name === 'Mira', "flying on rails enters Mira's sphere of influence");
    near(time, predicted.tEnd, 60, 'SOI change time matches the prediction (s)');
    check(
      game.events.some((event) => event.type === 'soi' && event.to === 'Mira'),
      'an SOI-change event was raised',
    );
  }
}

done();
