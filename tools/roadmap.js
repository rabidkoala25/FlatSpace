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
  A0: 'Prep', A1: 'Part tree', A2: 'Drag & drop', A3: 'Editor tools', A4: 'Staging',
  B1: 'WebGL', B2: 'Part sprites', B3: 'World art', B4: 'Effects', B5: 'UI reskin',
  C1: 'Rigid body', C2: 'Joints', C3: 'Ropes', C4: 'Aero', C5: 'Orbits',
  D1: 'Legs', D2: 'RCS', D3: 'Space Center', D4: 'Planning', D5: 'Structure', D6: 'Engines', D7: 'Pods',
  E1: 'Solar system', E2: 'Planet art', E3: 'Science', E4: 'Tech tree', E5: 'Power, heat',
  E6: 'Docking', E7: 'EVA', E8: 'Autopilot', E9: 'Sound', E10: 'Terrain', E11: 'Tech, deals',
  F1: 'Funds', F2: 'Contracts', F3: 'Facilities', F4: 'CommNet', F5: 'Resources',
  F6: 'Spaceplanes', F7: 'Plane parts', F8: 'Rovers', F9: 'Asteroids', F10: 'Planner', F11: 'Tech, deals',
  G1: 'Packs', G2: 'Missions', G3: 'Robotics', G4: 'Realism', G5: 'Scripting',
  G6: 'Near Future', G7: 'Bases', G8: 'Classics', G9: 'Tech, deals',
  H1: 'Astronauts', H2: 'Interiors', H3: 'Hands-on', H4: 'Repairs', H5: 'Life aboard',
  H6: 'Self-landing', H7: 'Launch sites', H8: 'Tethers', H9: 'Replays', H10: 'Tech, deals',
};
const PHASE_TITLE = {
  P: 'Prototype', A: 'Builder', B: 'Pixel art', C: 'Physics', D: 'Sandbox',
  E: 'Planets & science', F: 'Career', G: 'Modded', H: 'Beyond KSP',
};

// ---- Read the status table ----
const start = plan.indexOf('### 4.5 Status');
const table = plan.slice(start, plan.indexOf('### Prototype (done)', start));
const rows = table.split('\n').filter((l) => /^\| (\*\*)?[A-Z]\d*(\*\*)? \|/.test(l));
const phases = [];
for (const line of rows) {
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  const id = cells[0].replace(/\*/g, '');
  if (/^[A-Z]$/.test(id) && cells[0].startsWith('**')) { phases.push({ id, steps: [] }); continue; }
  const status = cells[2].includes('✅') ? 'done' : cells[2].includes('◐') ? 'doing' : 'todo';
  const step = { id, name: cells[1], status };
  if (id === 'P') phases.push({ id: 'P', steps: [step] });
  else phases[phases.length - 1].steps.push(step);
}
const all = phases.flatMap((p) => p.steps);
const next = all.find((s) => s.status !== 'done');
if (next && next.status === 'todo') next.status = 'next';
const counted = all.filter((s) => s.id !== 'P');
const doneCount = counted.filter((s) => s.status === 'done').length;
const version = (fs.readFileSync(path.join(ROOT, 'js/util.js'), 'utf8').match(/FS\.VERSION = '([^']+)'/) || [])[1] || '';

// ---- Draw ----
const C = {
  bg: '#0b1222', panel: '#111a2f', rail: '#26324d',
  ink: '#e6edf7', ink2: '#9aa8c2', ink3: '#6c7a96',
  done: '#3fb68b', doneInk: '#062317', next: '#ffb547', todoFill: '#141d33', todoLine: '#2c3a5a',
};
const FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace";
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const LEFT = 204, BW = 80, GAP = 6, BH = 46, ROW = 62, TOP = 112;
const W = Math.max(1100, LEFT + Math.max(...phases.map((p) => p.steps.length)) * (BW + GAP) + 22);
const H = TOP + phases.length * ROW + 64;
const out = [];
out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">`);
out.push(`<title id="t">Flatspace Program roadmap</title>`);
out.push(`<desc id="d">${doneCount} of ${counted.length} roadmap steps done${next ? '. Next: ' + next.id + ' ' + esc(next.name) : ''}.</desc>`);
out.push(`<rect width="${W}" height="${H}" rx="14" fill="${C.bg}"/>`);

// header
out.push(`<text x="28" y="44" font-family="${FONT}" font-size="22" font-weight="700" fill="${C.ink}">Flatspace Program roadmap</text>`);
out.push(`<text x="28" y="70" font-family="${FONT}" font-size="13" fill="${C.ink2}">${version ? 'v' + version + ' · ' : ''}${doneCount} of ${counted.length} steps done${next ? ' · next: ' + next.id + ' ' + esc(next.name) : ''}</text>`);
const barW = 352, barX = W - 28 - barW, barY = 52;
out.push(`<rect x="${barX}" y="${barY}" width="${barW}" height="8" rx="4" fill="${C.todoFill}" stroke="${C.todoLine}"/>`);
out.push(`<rect x="${barX}" y="${barY}" width="${Math.max(8, (barW * doneCount) / counted.length).toFixed(1)}" height="8" rx="4" fill="${C.done}"/>`);
out.push(`<text x="${barX + barW}" y="${barY - 8}" text-anchor="end" font-family="${MONO}" font-size="12" fill="${C.ink2}">${Math.round((100 * doneCount) / counted.length)}%</text>`);

// rail linking the phases, top to bottom
out.push(`<line x1="44" y1="${TOP + BH / 2}" x2="44" y2="${TOP + (phases.length - 1) * ROW + BH / 2}" stroke="${C.rail}" stroke-width="2"/>`);

phases.forEach((ph, i) => {
  const y = TOP + i * ROW;
  const done = ph.steps.filter((s) => s.status === 'done').length;
  const complete = done === ph.steps.length;
  const active = ph.steps.some((s) => s.status === 'next' || s.status === 'doing');
  // phase badge
  out.push(`<circle cx="44" cy="${y + BH / 2}" r="15" fill="${complete ? C.done : C.panel}" stroke="${complete ? C.done : active ? C.next : C.todoLine}" stroke-width="2"/>`);
  out.push(`<text x="44" y="${y + BH / 2 + 5}" text-anchor="middle" font-family="${MONO}" font-size="13" font-weight="700" fill="${complete ? C.doneInk : active ? C.next : C.ink2}">${ph.id}</text>`);
  out.push(`<text x="70" y="${y + 19}" font-family="${FONT}" font-size="13.5" font-weight="700" fill="${C.ink}">${esc(PHASE_TITLE[ph.id] || ph.id)}</text>`);
  out.push(`<text x="70" y="${y + 37}" font-family="${FONT}" font-size="11.5" fill="${C.ink3}">${ph.id === 'P' ? 'done' : `${done} of ${ph.steps.length} done`}</text>`);

  ph.steps.forEach((s, k) => {
    const x = LEFT + k * (BW + GAP);
    const fill = s.status === 'done' ? C.done : C.todoFill;
    const line = s.status === 'done' ? C.done : s.status === 'todo' ? C.todoLine : C.next;
    const idInk = s.status === 'done' ? C.doneInk : s.status === 'todo' ? C.ink2 : C.next;
    const nameInk = s.status === 'done' ? C.doneInk : s.status === 'todo' ? C.ink3 : C.ink;
    out.push(`<g><title>${s.id} · ${esc(s.name)}</title>`);
    out.push(`<rect x="${x}" y="${y}" width="${BW}" height="${BH}" rx="7" fill="${fill}" stroke="${line}" stroke-width="${s.status === 'todo' ? 1 : 2}"${s.status === 'doing' ? ' stroke-dasharray="4 3"' : ''}/>`);
    out.push(`<text x="${x + 9}" y="${y + 19}" font-family="${MONO}" font-size="12" font-weight="700" fill="${idInk}">${s.id}</text>`);
    if (s.status === 'done') out.push(`<path d="M${x + BW - 21} ${y + 13} l4 4 l8 -8" fill="none" stroke="${C.doneInk}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`);
    if (s.status === 'next') out.push(`<text x="${x + BW - 8}" y="${y + 18}" text-anchor="end" font-family="${FONT}" font-size="9.5" font-weight="700" letter-spacing="0.6" fill="${C.next}">NEXT</text>`);
    out.push(`<text x="${x + 9}" y="${y + 36}" font-family="${FONT}" font-size="10.5" fill="${nameInk}">${esc(SHORT[s.id] || s.name.split(' ').slice(0, 2).join(' '))}</text>`);
    out.push(`</g>`);
  });
});

// legend
const ly = H - 34;
const key = [
  ['done', 'Done'], ['next', 'Next'], ['todo', 'Planned'],
];
let lx = 28;
for (const [st, label] of key) {
  const fill = st === 'done' ? C.done : C.todoFill;
  const line = st === 'done' ? C.done : st === 'todo' ? C.todoLine : C.next;
  out.push(`<rect x="${lx}" y="${ly - 11}" width="22" height="14" rx="4" fill="${fill}" stroke="${line}" stroke-width="${st === 'todo' ? 1 : 2}"/>`);
  if (st === 'done') out.push(`<path d="M${lx + 6} ${ly - 4} l3 3 l6 -6" fill="none" stroke="${C.doneInk}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`);
  out.push(`<text x="${lx + 30}" y="${ly}" font-family="${FONT}" font-size="12" fill="${C.ink2}">${label}</text>`);
  lx += 30 + label.length * 7 + 26;
}
out.push(`<text x="${W - 28}" y="${ly}" text-anchor="end" font-family="${FONT}" font-size="12" fill="${C.ink3}">Each step is one work session · details in PLAN.md</text>`);
out.push('</svg>');

fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs/roadmap.svg'), out.join('\n') + '\n');
console.log(`docs/roadmap.svg: ${doneCount}/${counted.length} steps done, next ${next ? next.id : 'none'}`);
