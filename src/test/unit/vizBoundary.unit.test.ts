import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Factory Clock moved to its own repository, https://github.com/DChristianson/factory-clock
// (docs/design/factory-clock-plan.md, step 8). Snagboat keeps its own copy of the two session
// drawings it uses (media/drawings), and the unit tests keep their own copy of the synthetic
// sessions (src/test/fixtures/synthetic.ts). So nothing in Snagboat imports or loads Factory Clock.

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  // Compiled to out/test/unit; the repo root is three levels up.
  const root = path.resolve(__dirname, '..', '..', '..');

  test('packages/viz is gone; the workspace holds only the schema package', () => {
    assert.ok(!fs.existsSync(path.join(root, 'packages', 'viz')), 'packages/viz still exists');
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'packages')), ['schema']);
  });

  test('nothing in src/, media/, package.json, esbuild.js or .vscodeignore uses packages/viz or factory-clock', () => {
    const self = path.join(root, 'src', 'test', 'unit', 'vizBoundary.unit.test.ts');
    const under = (dir: string, ext: RegExp): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return under(full, ext);
        return ext.test(e.name) ? [full] : [];
      });
    const files = [
      ...under(path.join(root, 'src'), /\.ts$/).filter((f) => f !== self),
      ...under(path.join(root, 'media'), /\.(js|css|html)$/),
      ...['package.json', 'esbuild.js', '.vscodeignore'].map((f) => path.join(root, f)),
    ];
    assert.ok(files.length > 50, 'found the sources');
    const banned = /['"]factory-clock(?:\/[\w/]*)?['"]|packages\/viz|factoryClock(?:Kit|Explore)?\b/;
    // Comments may say where a copy came from; code may not reach for it. The demo traces tool
    // writes window.factoryClockDemoTraces, the global Factory Clock's page reads.
    const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*(\/\/|#).*$/gm, '');
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const hit = banned.exec(file.endsWith('.json') ? text : code(text));
      assert.ok(!hit, `${path.relative(root, file)} mentions ${hit?.[0]}`);
    }
  });

  let failures = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failures += 1;
      console.error(`FAIL  ${name}`);
      console.error(err);
    }
  }

  console.log(`\n${tests.length - failures}/${tests.length} passed`);
  if (failures > 0) process.exit(1);
}

main();
