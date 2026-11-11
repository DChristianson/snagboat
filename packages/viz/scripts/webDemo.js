// Assembles the web demo under the repository's out/web (npm run build:web,
// after esbuild has written the bundle there): the page's own files from
// hosts/web/, and the package's scripts and stylesheets, copied as they are,
// the same files the detail webview and the advisor UI load. The visualizer
// script tags are written into index.html for every file under viz/ (the
// registry first), so a new visualizer needs no edit here. Nothing generated
// is committed; GitHub Pages serves out/web.
const fs = require('fs');
const path = require('path');

// The package (packages/viz), and the repository whose build writes the bundle.
const pkg = path.join(__dirname, '..');
const root = path.join(pkg, '..', '..');
const out = path.join(root, 'out', 'web');

const bundle = path.join(out, 'snagboat-web.js');
if (!fs.existsSync(bundle)) {
  console.error(`webDemo: ${path.relative(root, bundle)} is missing; run "node esbuild.js --web" first (npm run build:web does)`);
  process.exit(1);
}

fs.mkdirSync(path.join(out, 'viz'), { recursive: true });

const copies = [
  ['vizkit.js', 'vizkit.js'],
  ['explore.js', 'explore.js'],
  ['theme.css', 'theme.css'],
  ['viz.css', 'viz.css'],
  ['hosts/web/web.css', 'web.css'],
];
const viz = fs
  .readdirSync(path.join(pkg, 'viz'))
  .filter((f) => f.endsWith('.js'))
  .sort((a, b) => (a === 'registry.js' ? -1 : b === 'registry.js' ? 1 : a.localeCompare(b)));
if (viz[0] !== 'registry.js') {
  console.error('webDemo: packages/viz/viz/registry.js is missing');
  process.exit(1);
}
for (const f of viz) copies.push([`viz/${f}`, `viz/${f}`]);
// The example traces (npm run demo:traces), when they've been made and reviewed; without them the page shows only generated sessions.
const traces = fs.existsSync(path.join(pkg, 'hosts', 'web', 'demo', 'traces.js'));
if (traces) copies.push(['hosts/web/demo/traces.js', 'demo-traces.js']);
for (const [from, to] of copies) fs.copyFileSync(path.join(pkg, from), path.join(out, to));

const marker = /^[ \t]*<!-- viz-scripts:.*-->[ \t]*$/m;
const html = fs.readFileSync(path.join(pkg, 'hosts', 'web', 'index.html'), 'utf8');
if (!marker.test(html)) {
  console.error('webDemo: hosts/web/index.html has no <!-- viz-scripts --> marker');
  process.exit(1);
}
const tracesMarker = /^[ \t]*<!-- demo-traces:.*-->[ \t]*$/m;
if (!tracesMarker.test(html)) {
  console.error('webDemo: hosts/web/index.html has no <!-- demo-traces --> marker');
  process.exit(1);
}
fs.writeFileSync(
  path.join(out, 'index.html'),
  html.replace(marker, viz.map((f) => `<script src="viz/${f}"></script>`).join('\n')).replace(tracesMarker, traces ? '<script src="demo-traces.js"></script>' : '')
);

// The folder is exactly the demo: compile-tests also emits src/web's modules
// (the bundle's entry and Snagboat's findings) under out/web, and nothing but these files should be deployed.
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
