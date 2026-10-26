// tests/run.js — runs every test in this folder. Usage: node tests/run.js
// Each test runs in its own Node process. The page test needs jsdom (npm install);
// without it, that test is skipped rather than failed.
const { spawnSync } = require('child_process');
const fileSystem = require('fs');
const path = require('path');

const testFolder = __dirname;
const files = fileSystem
  .readdirSync(testFolder)
  .filter((fileName) => /^test_.*\.js$/.test(fileName))
  .sort();
let failed = 0;
const started = Date.now();

for (const fileName of files) {
  console.log('\n' + fileName);
  const result = spawnSync(process.execPath, [path.join(testFolder, fileName)], {
    stdio: 'inherit',
    timeout: 180000,
  });
  if (result.status !== 0) {
    failed++;
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${files.length - failed} of ${files.length} test files passed in ${seconds} s.`);
process.exit(failed ? 1 : 0);
