// Δv, staging and part data for the sample craft.
const { loadGame, check, near, done } = require('./lib');
const Flatspace = loadGame();

check(Flatspace.PARTS.length === 18, 'there are 18 parts');
check(
  new Set(Flatspace.PARTS.map((partType) => partType.id)).size === Flatspace.PARTS.length,
  'part ids are unique',
);
check(
  Flatspace.SAMPLE_CRAFT.every((craft) =>
    (craft.parts || craft.tree.map((trial) => trial.id)).every((partId) => Flatspace.PART[partId]),
  ),
  'every sample craft uses known parts',
);

// Δv per stage in vacuum, for stages that light engines
const vacuumStages = (name) => {
  const craft = Flatspace.SAMPLE_CRAFT.find((sample) => sample.name === name);
  const parts = Flatspace.toParts(craft.parts);
  const stages = Flatspace.stagesOf(parts);
  const stats = Flatspace.stageStats(parts, stages, 0, 0, 9.81);
  return stats.events.filter((stageEvent, stageIndex) => stages[stageIndex].ignite);
};

const hopper = vacuumStages('Hopper');
near(hopper[0].deltaV, 590, 2, 'Hopper vacuum Δv');

const orbiter = vacuumStages('Orbiter I');
near(orbiter[0].deltaV, 2413, 2, 'Orbiter I first stage vacuum Δv');
near(orbiter[1].deltaV, 2954, 2, 'Orbiter I second stage vacuum Δv');

const voyager = vacuumStages('Mira Voyager');
const total = voyager.reduce((sum, stage) => sum + stage.deltaV, 0);
near(total, 8425, 5, 'Mira Voyager total vacuum Δv');

const stages = Flatspace.stagesOf(Flatspace.toParts(Flatspace.SAMPLE_CRAFT[1].parts));
const pattern = stages
  .map((stage) => (stage.chutes ? 'C' : (stage.decouple ? 'D' : '') + (stage.ignite ? 'I' : '')))
  .join(' ');
check(pattern === 'I DI D C', `Orbiter I staging is "I DI D C" (got "${pattern}")`);

done();
