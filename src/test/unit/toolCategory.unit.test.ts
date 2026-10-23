import * as assert from 'assert';
import { classifyCommand, classifyTool, toolCategoryLabel } from '../../core/toolCategory';
import { normalizeHookPayload } from '../../adapters/claude-code/normalize';
import { normalizeOtlpTraces } from '../../adapters/copilot/normalize';

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('named tools map to their category for both Claude Code and Copilot', () => {
    const cases: Array<[string, string]> = [
      ['Read', 'file-read'], ['Edit', 'file-edit'], ['Write', 'file-edit'], ['Grep', 'search'], ['Glob', 'search'],
      ['WebFetch', 'web'], ['Task', 'subagent'], ['read_file', 'file-read'], ['apply_patch', 'file-edit'],
      ['grep_search', 'search'], ['fetch_webpage', 'web'], ['AskUserQuestion', 'other'],
    ];
    for (const [name, expected] of cases) assert.strictEqual(classifyTool(name), expected, name);
    assert.strictEqual(classifyTool(undefined), 'other');
  });

  test('MCP tools are recognized and labeled with their server', () => {
    assert.strictEqual(classifyTool('mcp__github__create_issue'), 'mcp');
    assert.strictEqual(toolCategoryLabel('mcp', 'mcp__github__create_issue'), 'MCP: github');
    assert.strictEqual(toolCategoryLabel('file-edit', 'Edit'), 'File edit');
  });

  test('scripts: local script files and code written on the spot', () => {
    for (const cmd of ['python tools/fix.py', 'python3 - <<EOF', 'python3 -c "print(1)"', 'node -e "1"', 'node scripts/x.js', './run.sh', '../tools/gen', 'bash deploy.sh', 'FOO=1 python3 x.py']) {
      assert.strictEqual(classifyCommand(cmd), 'script', cmd);
    }
  });

  test('tests and builds', () => {
    for (const cmd of ['npm test', 'npm run test:unit', 'npm run build', 'pnpm lint', 'yarn typecheck', 'pytest -q', 'python -m pytest', 'python3 -m unittest', 'cargo test', 'go build ./...', 'make', 'npx jest', 'npx tsc --noEmit', 'cd src && npm test']) {
      assert.strictEqual(classifyCommand(cmd), 'tests-builds', cmd);
    }
  });

  test('version control and plain shell commands', () => {
    assert.strictEqual(classifyCommand('git status'), 'version-control');
    assert.strictEqual(classifyCommand('gh pr checks 3'), 'version-control');
    for (const cmd of ['ls -la', 'grep -rn foo src', 'sed -n 1,5p x', 'npm install', 'python3 -m pip install x', 'python3 --version', 'cat a | head', 'curl -s url']) {
      assert.strictEqual(classifyCommand(cmd), 'shell', cmd);
    }
  });

  test('chains are classified by their first meaningful segment', () => {
    assert.strictEqual(classifyCommand('cd /repo && git log -1'), 'version-control');
    assert.strictEqual(classifyCommand('S=/tmp/x; python3 gen.py'), 'script');
    assert.strictEqual(classifyCommand('npm run build | tail -2'), 'tests-builds');
    assert.strictEqual(classifyCommand('cd x'), 'shell');
  });

  test('Claude Code hook tool calls carry the tool name and category', () => {
    const event = normalizeHookPayload({ session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: {} });
    assert.strictEqual(event?.toolName, 'Bash');
    assert.strictEqual(event?.toolCategory, 'tests-builds');
  });

  test("Copilot tool calls are classified by name (Copilot doesn't export arguments)", () => {
    const events = normalizeOtlpTraces({
      resourceSpans: [{ scopeSpans: [{ spans: [
        { spanId: 'a', name: 'execute_tool', attributes: [{ key: 'gen_ai.tool.name', value: { stringValue: 'apply_patch' } }] },
        { spanId: 'b', name: 'execute_tool', attributes: [{ key: 'gen_ai.tool.name', value: { stringValue: 'run_in_terminal' } }] },
      ] }] }],
    });
    assert.deepStrictEqual(events.map((e) => [e.toolName, e.toolCategory]), [['apply_patch', 'file-edit'], ['run_in_terminal', 'shell']]);
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
