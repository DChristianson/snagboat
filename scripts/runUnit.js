// Runs every compiled unit test file (out/test/unit/*.unit.test.js), each in
// its own process as before, but keeps going after a failure so one run shows
// every failing file. Exits 1 if any failed. `npm run test:unit` compiles first.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'out', 'test', 'unit');
const only = process.argv.slice(2);
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.unit.test.js'))
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
  .sort();

const failed = [];
for (const file of files) {
  console.log(`\n=== ${file}`);
  const result = spawnSync(process.execPath, [path.join(dir, file)], { stdio: 'inherit' });
  if (result.status !== 0) failed.push(file);
}

console.log(`\n${files.length - failed.length}/${files.length} unit test files passed`);
if (failed.length > 0) {
  console.log(`failed: ${failed.join(', ')}`);
  process.exit(1);
}
