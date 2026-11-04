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
 * The web demo's bundle: the session model (src/core, src/ui, src/heuristics)
 * and the page under src/web, for the browser. Nothing in it may import fs,
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

const builds = webOnly ? [web] : [extension, web];

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
