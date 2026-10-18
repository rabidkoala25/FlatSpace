// Δv, staging and part data for the sample craft.
const { loadGame, check, near, done } = require('./lib');
const FS = loadGame();

check(FS.PARTS.length === 18, 'there are 18 parts');
check(new Set(FS.PARTS.map((p) => p.id)).size === FS.PARTS.length, 'part ids are unique');
check(FS.SAMPLE_CRAFT.every((c) => (c.parts || c.tree.map((t) => t.id)).every((id) => FS.PART[id])), 'every sample craft uses known parts');

// Δv per stage in vacuum, for stages that light engines
const vac = (name) => {
  const c = FS.SAMPLE_CRAFT.find((x) => x.name === name);
  const parts = FS.toParts(c.parts);
  const stages = FS.stagesOf(parts);
  const st = FS.stageStats(parts, stages, 0, 0, 9.81);
  return st.events.filter((e, k) => stages[k].ignite);
};

const hopper = vac('Hopper');
near(hopper[0].dv, 590, 2, 'Hopper vacuum Δv');

const orbiter = vac('Orbiter I');
near(orbiter[0].dv, 2413, 2, 'Orbiter I first stage vacuum Δv');
near(orbiter[1].dv, 2954, 2, 'Orbiter I second stage vacuum Δv');

const voyager = vac('Mira Voyager');
const total = voyager.reduce((s, x) => s + x.dv, 0);
near(total, 8425, 5, 'Mira Voyager total vacuum Δv');

const stages = FS.stagesOf(FS.toParts(FS.SAMPLE_CRAFT[1].parts));
const pattern = stages.map((e) => (e.chutes ? 'C' : (e.decouple ? 'D' : '') + (e.ignite ? 'I' : ''))).join(' ');
check(pattern === 'I DI D C', `Orbiter I staging is "I DI D C" (got "${pattern}")`);

done();
