// Δv, staging and part data for the sample craft.
const { loadGame, check, near, done } = require('./lib');
const FS = loadGame();

check(FS.PARTS.length === 18, 'there are 18 parts');
check(new Set(FS.PARTS.map((partType) => partType.id)).size === FS.PARTS.length, 'part ids are unique');
check(
  FS.SAMPLE_CRAFT.every((craft) =>
    (craft.parts || craft.tree.map((trial) => trial.id)).every((partId) => FS.PART[partId]),
  ),
  'every sample craft uses known parts',
);

// Δv per stage in vacuum, for stages that light engines
const vacuumStages = (name) => {
  const craft = FS.SAMPLE_CRAFT.find((sample) => sample.name === name);
  const parts = FS.toParts(craft.parts);
  const stages = FS.stagesOf(parts);
  const stats = FS.stageStats(parts, stages, 0, 0, 9.81);
  return stats.events.filter((stageEvent, stageIndex) => stages[stageIndex].ignite);
};

const hopper = vacuumStages('Hopper');
near(hopper[0].dv, 590, 2, 'Hopper vacuum Δv');

const orbiter = vacuumStages('Orbiter I');
near(orbiter[0].dv, 2413, 2, 'Orbiter I first stage vacuum Δv');
near(orbiter[1].dv, 2954, 2, 'Orbiter I second stage vacuum Δv');

const voyager = vacuumStages('Mira Voyager');
const total = voyager.reduce((sum, stage) => sum + stage.dv, 0);
near(total, 8425, 5, 'Mira Voyager total vacuum Δv');

const stages = FS.stagesOf(FS.toParts(FS.SAMPLE_CRAFT[1].parts));
const pattern = stages
  .map((stage) => (stage.chutes ? 'C' : (stage.decouple ? 'D' : '') + (stage.ignite ? 'I' : '')))
  .join(' ');
check(pattern === 'I DI D C', `Orbiter I staging is "I DI D C" (got "${pattern}")`);

done();
