import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// The engine is everything that will become packages/core (docs/design/architecture-rfc.md,
// step 2). It must not import vscode or the VS Code front door (src/vscode, src/ui,
// src/extension.ts); it reads settings and workspace folders through core/host instead.

const ENGINE_DIRS = ['core', 'adapters', 'heuristics', 'discovery', 'review', 'nudges', 'advisor', 'backfill'];
const FRONT_DOOR = ['vscode', 'ui', 'extension'];
// Known crossings, each with the step that removes it.
const ALLOWED: Record<string, string> = {
  // review/presentation formats status text with ui/format, which is itself vscode-free; step 3 decides its home.
  'review/presentation.ts -> ui/format': 'step 3',
};

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  // Compiled to out/test/unit; the sources sit at src/ from the repo root.
  const srcDir = path.resolve(__dirname, '..', '..', '..', 'src');
  const filesUnder = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return filesUnder(full);
      return e.name.endsWith('.ts') ? [full] : [];
    });
  const engineFiles = ENGINE_DIRS.flatMap((d) => filesUnder(path.join(srcDir, d)));
  const importsOf = (file: string): string[] =>
    [...fs.readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const rel = (file: string) => path.relative(srcDir, file).split(path.sep).join('/');

  test('the engine directories exist and hold code', () => {
    assert.ok(engineFiles.length > 50, `only ${engineFiles.length} engine files found`);
  });

  test('no engine module imports vscode', () => {
    for (const file of engineFiles) {
      assert.ok(!importsOf(file).includes('vscode'), `${rel(file)} imports vscode`);
    }
  });

  test('no engine module imports the VS Code front door', () => {
    for (const file of engineFiles) {
      for (const spec of importsOf(file).filter((s) => s.startsWith('.'))) {
        const target = rel(path.resolve(path.dirname(file), spec));
        const top = target.split('/')[0];
        if (!FRONT_DOOR.includes(top)) continue;
        const key = `${rel(file)} -> ${target}`;
        assert.ok(key in ALLOWED, `${key} crosses into the front door`);
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
