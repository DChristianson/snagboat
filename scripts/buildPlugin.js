// Builds the Claude Code plugin in plugins/snagboat (RFC step 5d) from the CLI bundle: copies
// dist/snagboat.js and the core's discovery worker (dist/discoveryWorker.js) into the plugin, writes hooks/forward.sh (the hook forwarder VS Code installs in
// projects, printed by the CLI so the two never drift), and keeps the plugin's version in step with
// package.json. Run after `npm run build` (npm run build:plugin does both). The written files are
// ignored by git; a release zips the folder.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const plugin = path.join(root, 'plugins', 'snagboat');
const cli = path.join(root, 'dist', 'snagboat.js');
const bundles = ['snagboat.js', 'discoveryWorker.js'];
for (const file of bundles) {
  if (!fs.existsSync(path.join(root, 'dist', file))) {
    console.error(`dist/${file} is missing; run npm run build first`);
    process.exit(1);
  }
}
fs.mkdirSync(path.join(plugin, 'dist'), { recursive: true });
for (const file of bundles) fs.copyFileSync(path.join(root, 'dist', file), path.join(plugin, 'dist', file));
const script = execFileSync(process.execPath, [cli, 'print-hook-script'], { encoding: 'utf8' });
fs.writeFileSync(path.join(plugin, 'hooks', 'forward.sh'), script, { mode: 0o755 });
const manifestFile = path.join(plugin, '.claude-plugin', 'plugin.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const version = require(path.join(root, 'package.json')).version;
if (manifest.version !== version) {
  manifest.version = version;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
}
console.log(`plugins/snagboat built (version ${version}): dist/snagboat.js, dist/discoveryWorker.js, hooks/forward.sh`);
