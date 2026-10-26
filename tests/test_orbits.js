// On-rails accuracy, encounter prediction and SOI change.
const { loadGame, fakeGame, check, near, done } = require('./lib');
const Flatspace = loadGame();
const Vector = Flatspace.Vector;

// --- One full orbit on rails returns to the same place ---
{
  const vessel = new Flatspace.Vessel('Probe', ['sparrow'], Flatspace.root, {});
  const ORBIT_RADIUS = 700000;
  vessel.position = { x: ORBIT_RADIUS, y: 0 };
  vessel.velocity = { x: 0, y: -Math.sqrt(Flatspace.root.gravityParameter / ORBIT_RADIUS) * 1.1 };
  vessel.landed = null;
  vessel.goOnRails(0);
  const orbit = vessel.rails;
  const start = { ...vessel.position };
  vessel.railsTo(orbit.period, fakeGame());
  near(
    Vector.length(Vector.subtract(vessel.position, start)),
    0,
    0.01,
    'position after one orbit on rails (m)',
  );
}

// --- Find a burn that meets Mira, then fly it on rails ---
{
  const game = fakeGame();
  const vessel = new Flatspace.Vessel('Probe', ['sparrow'], Flatspace.root, {});
  const ORBIT_RADIUS = 700000;
  let predicted = null;
  for (let angle = 0; angle < Flatspace.TAU && !predicted; angle += 0.05) {
    const position = { x: Math.cos(angle) * ORBIT_RADIUS, y: Math.sin(angle) * ORBIT_RADIUS };
    const speed = Math.sqrt(Flatspace.root.gravityParameter / ORBIT_RADIUS) + 860;
    const velocity = { x: Math.sin(angle) * speed, y: -Math.cos(angle) * speed }; // clockwise orbit
    const patches = Flatspace.predictPatches(Flatspace.root, position, velocity, 0, 3);
    const encounter = patches.find((patch) => patch.end === 'encounter');
    if (encounter) {
      predicted = encounter;
      vessel.position = position;
      vessel.velocity = velocity;
      vessel.landed = null;
    }
  }
  check(!!predicted && predicted.next.name === 'Mira', 'a prograde burn of 860 m/s finds a Mira encounter');
  if (predicted) {
    let time = 0;
    vessel.goOnRails(0);
    while (time < 400000 && vessel.body === Flatspace.root) {
      time += 60;
      vessel.railsTo(time, game);
    }
    check(vessel.body.name === 'Mira', "flying on rails enters Mira's sphere of influence");
    near(time, predicted.endTime, 60, 'SOI change time matches the prediction (s)');
    check(
      game.events.some((event) => event.type === 'sphere-change' && event.to === 'Mira'),
      'an SOI-change event was raised',
    );
  }
}

done();
