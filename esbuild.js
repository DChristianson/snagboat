const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const webOnly = process.argv.includes('--web');

/** @type {import('esbuild').BuildOptions} */
const extension = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: false,
};

/**
 * The web demo's bundle: Factory Clock's page and session model
 * (@snagboat/viz/web, packages/viz/src/web, built by `npm run build:viz`) with
 * Snagboat's heuristics for findings (src/web, src/heuristics), for the
 * browser. Nothing in it may import fs,
 * path, crypto, or vscode; esbuild refuses to resolve a node builtin for the
 * browser, so a node import creeping into the model fails this build (and
 * `npm run build`, which CI runs) rather than the deployed page.
 */
/** @type {import('esbuild').BuildOptions} */
const web = {
  entryPoints: ['src/web/main.ts'],
  bundle: true,
  outfile: 'out/web/snagboat-web.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: false,
  minify: false,
};

/**
 * The snagboat CLI (src/cli): reads the extension's event stores from a
 * terminal or an agent. Node only, no vscode; run as `node dist/snagboat.js`
 * or through package.json's bin.
 */
/** @type {import('esbuild').BuildOptions} */
const cli = {
  entryPoints: ['src/cli/main.ts'],
  bundle: true,
  outfile: 'dist/snagboat.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: false,
  minify: false,
  banner: { js: '#!/usr/bin/env node' },
  define: { SNAGBOAT_VERSION: JSON.stringify(require('./package.json').version) },
};

/**
 * The core's discovery worker (src/discovery/discoveryWorker.ts): a worker thread
 * the core runs discovery in, so its event loop keeps answering meanwhile. It
 * must sit beside dist/snagboat.js (offThread.ts finds it there), in the VSIX
 * and in the Claude Code plugin.
 */
/** @type {import('esbuild').BuildOptions} */
const discoveryWorker = {
  entryPoints: ['src/discovery/discoveryWorker.ts'],
  bundle: true,
  outfile: 'dist/discoveryWorker.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: false,
  minify: false,
};

const builds = webOnly ? [web] : [extension, web, cli, discoveryWorker];

async function run() {
  if (watch) {
    for (const options of builds) {
      const ctx = await esbuild.context(options);
      await ctx.watch();
    }
    console.log('esbuild watching...');
  } else {
    for (const options of builds) await esbuild.build(options);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
