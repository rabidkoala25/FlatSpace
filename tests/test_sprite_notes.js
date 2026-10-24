// Drawing notes (art/sprite-notes.js): every part has an entry, so sprite-guide.html covers it.
// When you add a part, add its notes in the same step.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT, check, done } = require('./lib');

global.window = global;
for (const f of ['data/parts.js', 'art/sprite-notes.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
}
const NOTES = FS.SPRITE_NOTES;
const PLANS = ['draw', 'generated', 'tank'];

for (const d of FS.DATA.parts) {
  const n = NOTES[d.id];
  const problems = [];
  if (!n) problems.push('no entry');
  else {
    if (!PLANS.includes(n.plan)) problems.push(`plan should be one of ${PLANS.join(', ')}`);
    if (!n.profile) problems.push('no profile');
    if (!Array.isArray(n.features) || !n.features.length) problems.push('no features');
    if (!Array.isArray(n.improve)) problems.push('no improve list (it can be empty)');
  }
  check(!problems.length, `${d.id} has drawing notes in art/sprite-notes.js` + (problems.length ? ': ' + problems.join(', ') : ''));
}
const ids = new Set(FS.DATA.parts.map((d) => d.id));
const stray = Object.keys(NOTES).filter((id) => !ids.has(id));
check(!stray.length, 'every entry belongs to a real part' + (stray.length ? ': ' + stray.join(', ') : ''));

done();
