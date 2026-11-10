// Assembles the web demo under out/web (npm run build:web, after esbuild has
// written the bundle there): the page's own files from web/, and the scripts
// and stylesheet the detail webview uses, copied as they are from media/, so
// the same visualizers run in both places. The visualizer script tags are
// written into index.html for every file under media/viz/ (the registry
// first), so a new visualizer needs no edit here. Nothing generated is
// committed; GitHub Pages serves out/web.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'out', 'web');
const media = path.join(root, 'media');

const bundle = path.join(out, 'snagboat-web.js');
if (!fs.existsSync(bundle)) {
  console.error(`webDemo: ${path.relative(root, bundle)} is missing; run "node esbuild.js --web" first (npm run build:web does)`);
  process.exit(1);
}

fs.mkdirSync(path.join(out, 'viz'), { recursive: true });

const copies = [
  ['media/vizkit.js', 'vizkit.js'],
  ['media/explore.js', 'explore.js'],
  ['media/detail.css', 'detail.css'],
  ['web/web.css', 'web.css'],
];
const viz = fs
  .readdirSync(path.join(media, 'viz'))
  .filter((f) => f.endsWith('.js'))
  .sort((a, b) => (a === 'registry.js' ? -1 : b === 'registry.js' ? 1 : a.localeCompare(b)));
if (viz[0] !== 'registry.js') {
  console.error('webDemo: media/viz/registry.js is missing');
  process.exit(1);
}
for (const f of viz) copies.push([`media/viz/${f}`, `viz/${f}`]);
// The example traces (npm run demo:traces), when they've been made and reviewed; without them the page shows only generated sessions.
const traces = fs.existsSync(path.join(root, 'web', 'demo', 'traces.js'));
if (traces) copies.push(['web/demo/traces.js', 'demo-traces.js']);
for (const [from, to] of copies) fs.copyFileSync(path.join(root, from), path.join(out, to));

const marker = /^[ \t]*<!-- viz-scripts:.*-->[ \t]*$/m;
const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
if (!marker.test(html)) {
  console.error('webDemo: web/index.html has no <!-- viz-scripts --> marker');
  process.exit(1);
}
const tracesMarker = /^[ \t]*<!-- demo-traces:.*-->[ \t]*$/m;
if (!tracesMarker.test(html)) {
  console.error('webDemo: web/index.html has no <!-- demo-traces --> marker');
  process.exit(1);
}
fs.writeFileSync(
  path.join(out, 'index.html'),
  html.replace(marker, viz.map((f) => `<script src="viz/${f}"></script>`).join('\n')).replace(tracesMarker, traces ? '<script src="demo-traces.js"></script>' : '')
);

// The folder is exactly the demo: compile-tests also emits src/web's modules
// under out/web, and nothing but these files should be deployed.
const keep = new Set(['index.html', 'snagboat-web.js', ...copies.map(([, to]) => to)]);
const prune = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(out, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (rel === 'viz') prune(full);
      else fs.rmSync(full, { recursive: true, force: true });
    } else if (!keep.has(rel)) fs.rmSync(full, { force: true });
  }
};
prune(out);

console.log(`webDemo: ${traces ? 'with' : 'without'} example traces; wrote ${copies.length + 1} files and the bundle to ${path.relative(root, out)} (visualizers: ${viz.filter((f) => f !== 'registry.js').map((f) => f.replace(/\.js$/, '')).join(', ')})`);
