// tools/roadmap.js — draws docs/roadmap.svg from the status table in PLAN.md (section 4.5).
// Run after finishing a step:  node tools/roadmap.js
// A step counts as done when its status cell contains ✅, in progress when it contains ◐.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const plan = fs.readFileSync(path.join(ROOT, 'PLAN.md'), 'utf8');

// Short labels that fit inside a step block.
const SHORT = {
  P: 'Prototype',
  A0: 'Prep',
  A1: 'Part tree',
  A2: 'Drag & drop',
  A3: 'Editor tools',
  A4: 'Staging',
  B1: 'WebGL',
  B2: 'Part sprites',
  B3: 'World art',
  B4: 'Effects',
  B5: 'UI reskin',
  C1: 'Rigid body',
  C2: 'Joints',
  C3: 'Ropes',
  C4: 'Aero',
  C5: 'Orbits',
  D1: 'Legs',
  D2: 'RCS',
  D3: 'Space Center',
  D4: 'Planning',
  D5: 'Structure',
  D6: 'Engines',
  D7: 'Pods',
  E1: 'Solar system',
  E2: 'Planet art',
  E3: 'Science',
  E4: 'Tech tree',
  E5: 'Power, heat',
  E6: 'Docking',
  E7: 'EVA',
  E8: 'Autopilot',
  E9: 'Sound',
  E10: 'Terrain',
  E11: 'Tech, deals',
  F1: 'Funds',
  F2: 'Contracts',
  F3: 'Facilities',
  F4: 'CommNet',
  F5: 'Resources',
  F6: 'Spaceplanes',
  F7: 'Plane parts',
  F8: 'Rovers',
  F9: 'Asteroids',
  F10: 'Planner',
  F11: 'Tech, deals',
  G1: 'Packs',
  G2: 'Missions',
  G3: 'Robotics',
  G4: 'Realism',
  G5: 'Scripting',
  G6: 'Near Future',
  G7: 'Bases',
  G8: 'Classics',
  G9: 'Tech, deals',
  H1: 'Astronauts',
  H2: 'Interiors',
  H3: 'Hands-on',
  H4: 'Repairs',
  H5: 'Life aboard',
  H6: 'Self-landing',
  H7: 'Launch sites',
  H8: 'Tethers',
  H9: 'Replays',
  H10: 'Tech, deals',
};
const PHASE_TITLE = {
  P: 'Prototype',
  A: 'Builder',
  B: 'Pixel art',
  C: 'Physics',
  D: 'Sandbox',
  E: 'Planets & science',
  F: 'Career',
  G: 'Modded',
  H: 'Beyond KSP',
};

// ---- Read the status table ----
const start = plan.indexOf('### 4.5 Status');
const table = plan.slice(start, plan.indexOf('### Prototype (done)', start));
const rows = table.split('\n').filter((line) => /^\| (\*\*)?[A-Z]\d*(\*\*)? \|/.test(line));
const phases = [];
for (const line of rows) {
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
  const stepId = cells[0].replace(/\*/g, '');
  if (/^[A-Z]$/.test(stepId) && cells[0].startsWith('**')) {
    phases.push({ id: stepId, steps: [] });
    continue;
  }
  const status = cells[2].includes('✅') ? 'done' : cells[2].includes('◐') ? 'doing' : 'todo';
  const step = { id: stepId, name: cells[1], status };
  if (stepId === 'P') {
    phases.push({ id: 'P', steps: [step] });
  } else {
    phases[phases.length - 1].steps.push(step);
  }
}
const all = phases.flatMap((phase) => phase.steps);
const next = all.find((step) => step.status !== 'done');
if (next && next.status === 'todo') {
  next.status = 'next';
}
const counted = all.filter((step) => step.id !== 'P');
const doneCount = counted.filter((step) => step.status === 'done').length;
const version =
  (fs.readFileSync(path.join(ROOT, 'js/util.js'), 'utf8').match(/FS\.VERSION = '([^']+)'/) || [])[1] || '';

// ---- Draw ----
const COLOURS = {
  bg: '#0b1222',
  panel: '#111a2f',
  rail: '#26324d',
  ink: '#e6edf7',
  ink2: '#9aa8c2',
  ink3: '#6c7a96',
  done: '#3fb68b',
  doneInk: '#062317',
  next: '#ffb547',
  todoFill: '#141d33',
  todoLine: '#2c3a5a',
};
const FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace";
const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const LEFT = 204;
const BOX_WIDTH = 80;
const GAP = 6;
const BOX_HEIGHT = 46;
const ROW = 62;
const TOP = 112;
const SVG_WIDTH = Math.max(
  1100,
  LEFT + Math.max(...phases.map((phase) => phase.steps.length)) * (BOX_WIDTH + GAP) + 22,
);
const SVG_HEIGHT = TOP + phases.length * ROW + 64;
const out = [];
out.push(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" role="img" aria-labelledby="t d">`,
);
out.push(`<title id="t">Flatspace Program roadmap</title>`);
out.push(
  `<desc id="d">${doneCount} of ${counted.length} roadmap steps done${next ? '. Next: ' + next.id + ' ' + escapeXml(next.name) : ''}.</desc>`,
);
out.push(`<rect width="${SVG_WIDTH}" height="${SVG_HEIGHT}" rx="14" fill="${COLOURS.bg}"/>`);

// header
out.push(
  `<text x="28" y="44" font-family="${FONT}" font-size="22" font-weight="700" fill="${COLOURS.ink}">Flatspace Program roadmap</text>`,
);
out.push(
  `<text x="28" y="70" font-family="${FONT}" font-size="13" fill="${COLOURS.ink2}">${version ? 'v' + version + ' · ' : ''}${doneCount} of ${counted.length} steps done${next ? ' · next: ' + next.id + ' ' + escapeXml(next.name) : ''}</text>`,
);
const barW = 352;
const barX = SVG_WIDTH - 28 - barW;
const barY = 52;
out.push(
  `<rect x="${barX}" y="${barY}" width="${barW}" height="8" rx="4" fill="${COLOURS.todoFill}" stroke="${COLOURS.todoLine}"/>`,
);
out.push(
  `<rect x="${barX}" y="${barY}" width="${Math.max(8, (barW * doneCount) / counted.length).toFixed(1)}" height="8" rx="4" fill="${COLOURS.done}"/>`,
);
out.push(
  `<text x="${barX + barW}" y="${barY - 8}" text-anchor="end" font-family="${MONO}" font-size="12" fill="${COLOURS.ink2}">${Math.round((100 * doneCount) / counted.length)}%</text>`,
);

// rail linking the phases, top to bottom
out.push(
  `<line x1="44" y1="${TOP + BOX_HEIGHT / 2}" x2="44" y2="${TOP + (phases.length - 1) * ROW + BOX_HEIGHT / 2}" stroke="${COLOURS.rail}" stroke-width="2"/>`,
);

phases.forEach((phase, phaseIndex) => {
  const rowY = TOP + phaseIndex * ROW;
  const done = phase.steps.filter((step) => step.status === 'done').length;
  const complete = done === phase.steps.length;
  const active = phase.steps.some((step) => step.status === 'next' || step.status === 'doing');
  // phase badge
  out.push(
    `<circle cx="44" cy="${rowY + BOX_HEIGHT / 2}" r="15" fill="${complete ? COLOURS.done : COLOURS.panel}" stroke="${complete ? COLOURS.done : active ? COLOURS.next : COLOURS.todoLine}" stroke-width="2"/>`,
  );
  out.push(
    `<text x="44" y="${rowY + BOX_HEIGHT / 2 + 5}" text-anchor="middle" font-family="${MONO}" font-size="13" font-weight="700" fill="${complete ? COLOURS.doneInk : active ? COLOURS.next : COLOURS.ink2}">${phase.id}</text>`,
  );
  out.push(
    `<text x="70" y="${rowY + 19}" font-family="${FONT}" font-size="13.5" font-weight="700" fill="${COLOURS.ink}">${escapeXml(PHASE_TITLE[phase.id] || phase.id)}</text>`,
  );
  out.push(
    `<text x="70" y="${rowY + 37}" font-family="${FONT}" font-size="11.5" fill="${COLOURS.ink3}">${phase.id === 'P' ? 'done' : `${done} of ${phase.steps.length} done`}</text>`,
  );

  phase.steps.forEach((step, stepIndex) => {
    const boxX = LEFT + stepIndex * (BOX_WIDTH + GAP);
    const fill = step.status === 'done' ? COLOURS.done : COLOURS.todoFill;
    const line =
      step.status === 'done' ? COLOURS.done : step.status === 'todo' ? COLOURS.todoLine : COLOURS.next;
    const idInk =
      step.status === 'done' ? COLOURS.doneInk : step.status === 'todo' ? COLOURS.ink2 : COLOURS.next;
    const nameInk =
      step.status === 'done' ? COLOURS.doneInk : step.status === 'todo' ? COLOURS.ink3 : COLOURS.ink;
    out.push(`<g><title>${step.id} · ${escapeXml(step.name)}</title>`);
    out.push(
      `<rect x="${boxX}" y="${rowY}" width="${BOX_WIDTH}" height="${BOX_HEIGHT}" rx="7" fill="${fill}" stroke="${line}" stroke-width="${step.status === 'todo' ? 1 : 2}"${step.status === 'doing' ? ' stroke-dasharray="4 3"' : ''}/>`,
    );
    out.push(
      `<text x="${boxX + 9}" y="${rowY + 19}" font-family="${MONO}" font-size="12" font-weight="700" fill="${idInk}">${step.id}</text>`,
    );
    if (step.status === 'done') {
      out.push(
        `<path d="M${boxX + BOX_WIDTH - 21} ${rowY + 13} l4 4 l8 -8" fill="none" stroke="${COLOURS.doneInk}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    }
    if (step.status === 'next') {
      out.push(
        `<text x="${boxX + BOX_WIDTH - 8}" y="${rowY + 18}" text-anchor="end" font-family="${FONT}" font-size="9.5" font-weight="700" letter-spacing="0.6" fill="${COLOURS.next}">NEXT</text>`,
      );
    }
    out.push(
      `<text x="${boxX + 9}" y="${rowY + 36}" font-family="${FONT}" font-size="10.5" fill="${nameInk}">${escapeXml(SHORT[step.id] || step.name.split(' ').slice(0, 2).join(' '))}</text>`,
    );
    out.push(`</g>`);
  });
});

// legend
const legendY = SVG_HEIGHT - 34;
const key = [
  ['done', 'Done'],
  ['next', 'Next'],
  ['todo', 'Planned'],
];
let legendX = 28;
for (const [status, label] of key) {
  const fill = status === 'done' ? COLOURS.done : COLOURS.todoFill;
  const line = status === 'done' ? COLOURS.done : status === 'todo' ? COLOURS.todoLine : COLOURS.next;
  out.push(
    `<rect x="${legendX}" y="${legendY - 11}" width="22" height="14" rx="4" fill="${fill}" stroke="${line}" stroke-width="${status === 'todo' ? 1 : 2}"/>`,
  );
  if (status === 'done') {
    out.push(
      `<path d="M${legendX + 6} ${legendY - 4} l3 3 l6 -6" fill="none" stroke="${COLOURS.doneInk}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
  }
  out.push(
    `<text x="${legendX + 30}" y="${legendY}" font-family="${FONT}" font-size="12" fill="${COLOURS.ink2}">${label}</text>`,
  );
  legendX += 30 + label.length * 7 + 26;
}
out.push(
  `<text x="${SVG_WIDTH - 28}" y="${legendY}" text-anchor="end" font-family="${FONT}" font-size="12" fill="${COLOURS.ink3}">Each step is one work session · details in PLAN.md</text>`,
);
out.push('</svg>');

fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs/roadmap.svg'), out.join('\n') + '\n');
console.log(`docs/roadmap.svg: ${doneCount}/${counted.length} steps done, next ${next ? next.id : 'none'}`);
