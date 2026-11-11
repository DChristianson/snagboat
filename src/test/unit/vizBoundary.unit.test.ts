import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// packages/viz is @snagboat/viz, Factory Clock (docs/design/factory-clock-plan.md, step 4):
// the visualizers, the explorer, their theme and styles, the catalog, and the web page.
// Its TypeScript may import only itself and @snagboat/schema, so it can leave Snagboat;
// a host plugs in what it adds (Snagboat's web build passes its heuristics' findings).

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  // Compiled to out/test/unit; the package sits at packages/viz from the repo root.
  const pkgDir = path.resolve(__dirname, '..', '..', '..', 'packages', 'viz');
  const srcDir = path.join(pkgDir, 'src');
  const filesUnder = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return filesUnder(full);
      return e.name.endsWith('.ts') ? [full] : [];
    });
  const files = filesUnder(srcDir);
  const importsOf = (file: string): string[] =>
    [...fs.readFileSync(file, 'utf8').matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const rel = (file: string) => path.relative(pkgDir, file).split(path.sep).join('/');

  test('packages/viz has the moved files', () => {
    for (const f of ['src/catalog.ts', 'src/explorerModel.ts', 'src/web/eventSet.ts', 'src/web/page.ts', 'src/web/synthetic.ts', 'viz/registry.js', 'vizkit.js', 'explore.js', 'viz.css', 'theme.css', 'hosts/web/index.html', 'hosts/web/web.css', 'scripts/webDemo.js']) {
      assert.ok(fs.existsSync(path.join(pkgDir, f)), `missing packages/viz/${f}`);
    }
  });

  test('the package imports only itself and @snagboat/schema', () => {
    for (const file of files) {
      for (const spec of importsOf(file)) {
        if (spec === '@snagboat/schema') continue;
        assert.ok(spec.startsWith('.'), `${rel(file)} imports ${spec}, outside the package`);
        const target = path.resolve(path.dirname(file), spec);
        assert.ok(target.startsWith(srcDir + path.sep), `${rel(file)} imports ${spec}, outside the package`);
      }
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
