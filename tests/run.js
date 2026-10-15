// tests/run.js — runs every test in this folder. Usage: node tests/run.js
// Each test runs in its own Node process. The page test needs jsdom (npm install);
// without it, that test is skipped rather than failed.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => /^test_.*\.js$/.test(f)).sort();
let failed = 0;
const started = Date.now();

for (const f of files) {
  console.log('\n' + f);
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit', timeout: 180000 });
  if (r.status !== 0) failed++;
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${files.length - failed} of ${files.length} test files passed in ${secs} s.`);
process.exit(failed ? 1 : 0);
