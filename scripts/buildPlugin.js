// Builds the Claude Code plugin in plugins/snagboat (RFC step 5d) from the CLI bundle: copies
// dist/snagboat.js into the plugin, writes hooks/forward.sh (the hook forwarder VS Code installs in
// projects, printed by the CLI so the two never drift), and keeps the plugin's version in step with
// package.json. Run after `npm run build` (npm run build:plugin does both). The written files are
// ignored by git; a release zips the folder.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const plugin = path.join(root, 'plugins', 'snagboat');
const cli = path.join(root, 'dist', 'snagboat.js');
if (!fs.existsSync(cli)) {
  console.error('dist/snagboat.js is missing; run npm run build first');
  process.exit(1);
}
fs.mkdirSync(path.join(plugin, 'dist'), { recursive: true });
fs.copyFileSync(cli, path.join(plugin, 'dist', 'snagboat.js'));
const script = execFileSync(process.execPath, [cli, 'print-hook-script'], { encoding: 'utf8' });
fs.writeFileSync(path.join(plugin, 'hooks', 'forward.sh'), script, { mode: 0o755 });
const manifestFile = path.join(plugin, '.claude-plugin', 'plugin.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const version = require(path.join(root, 'package.json')).version;
if (manifest.version !== version) {
  manifest.version = version;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
}
console.log(`plugins/snagboat built (version ${version}): dist/snagboat.js, hooks/forward.sh`);
