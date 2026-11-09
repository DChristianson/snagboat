import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// src/schema is the future schema package (docs/design/architecture-rfc.md, step 1):
// the event types and the session-view builder that Snagboat and Factory Clock share.
// It must stay self-contained and browser-safe, so it can move into packages/schema
// and be bundled for the web page without pulling in the rest of Snagboat.

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  // Compiled to out/test/unit; the sources sit at src/schema from the repo root.
  const schemaDir = path.resolve(__dirname, '..', '..', '..', 'src', 'schema');
  const files = fs.readdirSync(schemaDir).filter((f) => f.endsWith('.ts'));
  const importsOf = (file: string): string[] => {
    const text = fs.readFileSync(path.join(schemaDir, file), 'utf8');
    return [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  };

  test('src/schema has the moved modules', () => {
    for (const f of ['types.ts', 'toolCategory.ts', 'eventDay.ts', 'sessions.ts', 'contextMarks.ts', 'sessionModel.ts']) {
      assert.ok(files.includes(f), `missing src/schema/${f}`);
    }
  });

  test('src/schema imports only from itself', () => {
    for (const file of files) {
      for (const spec of importsOf(file)) {
        assert.ok(spec.startsWith('./') && !spec.slice(2).includes('/'), `${file} imports ${spec}, outside src/schema`);
      }
    }
  });

  test('src/schema uses no Node builtins or vscode', () => {
    for (const file of files) {
      for (const spec of importsOf(file)) {
        assert.ok(!spec.startsWith('node:') && spec !== 'vscode', `${file} imports ${spec}`);
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
