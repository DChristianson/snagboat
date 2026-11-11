// Zips the built Claude Code plugin (npm run build:plugin) as snagboat-claude-plugin-<version>.zip at the
// repository root, with the plugin's files at the top of the zip (.claude-plugin/plugin.json and the
// rest), which `claude --plugin-dir <zip>` loads. The release attaches it.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const plugin = path.join(root, 'plugins', 'snagboat');
for (const f of ['dist/snagboat.js', 'dist/discoveryWorker.js', 'hooks/forward.sh']) {
  if (!fs.existsSync(path.join(plugin, f))) {
    console.error(`plugins/snagboat/${f} is missing; run npm run build:plugin first`);
    process.exit(1);
  }
}
const version = require(path.join(root, 'package.json')).version;
const out = path.join(root, `snagboat-claude-plugin-${version}.zip`);
fs.rmSync(out, { force: true });
// -X: no extra file attributes; Unix permissions are kept, so the scripts stay executable.
execFileSync('zip', ['-q', '-r', '-X', out, '.'], { cwd: plugin, stdio: 'inherit' });
console.log(`${path.basename(out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
