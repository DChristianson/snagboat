import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { normalizeHookPayload, normalizeTranscriptChunk, SeenMessages } from '../../adapters/claude-code/normalize';
import { LiveToolCalls, normalizeTranscriptSession } from '../../adapters/claude-code/transcriptSession';
import { CopilotCliState, normalizeCopilotCliChunk } from '../../adapters/copilot/cliSessions';
import { normalizeOtlpTraces } from '../../adapters/copilot/normalize';
import { effectiveSettings, saveConfig } from '../../core/config';
import { captureLimitsFrom, capturePrompt, captureReply, hasCapturedText, withoutCapturedText } from '../../core/excerpt';
import { refsOf, shellCommands, TOOL_INPUT_MAX_CHARS, toolInputOf } from '../../core/toolInput';

// Capture for the export (bead snagboat-93b.10.2): toolInput and refs on tool calls, and the
// snagboat.capture.promptChars / replyChars caps with textTruncated.

const bash = (command: string, output?: unknown, failed = false) => refsOf('Bash', { command }, output, failed);

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('shellCommands splits chains and resolves quotes; heredocs, substitutions and comments are opaque', () => {
    assert.deepStrictEqual(shellCommands(`cd "my repo" && git checkout -b feat/x; npm test | tail -3`), [['cd', 'my repo'], ['git', 'checkout', '-b', 'feat/x'], ['npm', 'test'], ['tail', '-3']]);
    const commit = `git commit -m "$(cat <<'EOF'\nFix "quoting"; bd close snagboat-zzz\n\nCo-Authored-By: x\nEOF\n)" && git push`;
    assert.deepStrictEqual(shellCommands(commit).map((w) => w[0]), ['git', 'git'], 'the message is one word, never commands');
    assert.deepStrictEqual(shellCommands(`cat > notes.md <<EOF\nbd close snagboat-zzz\nEOF\nbd show snagboat-abc`).map((w) => w.join(' ')), ['cat > notes.md', 'bd show snagboat-abc']);
    assert.deepStrictEqual(shellCommands(`echo hi # bd close snagboat-zzz`), [['echo', 'hi']]);
    assert.deepStrictEqual(shellCommands(`echo 'git checkout -b nope' \\\n  done`), [['echo', 'git checkout -b nope', 'done']]);
  });

  test('git checkout, switch and worktree add name a branch; a bare checkout only by what git printed', () => {
    assert.deepStrictEqual(bash('git checkout -b feat/login'), { branch: 'feat/login' });
    assert.deepStrictEqual(bash('git -C /repo checkout -B fix-1 origin/main'), { branch: 'fix-1' });
    assert.strictEqual(bash('git checkout main'), undefined, 'might be restoring a file named main');
    assert.strictEqual(bash('git checkout -- src/a.ts'), undefined);
    assert.deepStrictEqual(bash('git checkout main', { stdout: '', stderr: "Switched to branch 'main'\n" }), { branch: 'main' });
    assert.deepStrictEqual(bash('git switch release/2.0'), { branch: 'release/2.0' });
    assert.deepStrictEqual(bash('git switch -c topic --track origin/topic'), { branch: 'topic' });
    assert.strictEqual(bash('git switch --detach abc1234'), undefined);
    assert.deepStrictEqual(bash('git worktree add -b export-capture ../wt export-schema'), { branch: 'export-capture' });
    assert.deepStrictEqual(bash('git worktree add ../wt', "Preparing worktree (new branch 'wt')\nHEAD is now at 48150b0 Design"), { branch: 'wt' });
    assert.strictEqual(bash('echo "git checkout -b nope"'), undefined, 'quoted text is not a command');
    assert.strictEqual(bash('git checkout -b ../evil'), undefined, 'not a branch name');
  });

  test('git commit: the SHA only from the summary line git printed', () => {
    assert.strictEqual(bash('git add -A && git commit -m "x"'), undefined, 'the command alone shows no SHA');
    assert.deepStrictEqual(bash('git add -A && git commit -m "x"', { stdout: '[export-capture 1a2b3c4] x\n 2 files changed, 10 insertions(+)\n', stderr: '' }), { commit: '1a2b3c4' });
    assert.deepStrictEqual(bash('git commit --amend --no-edit', '[main (root-commit) 0f0e0d0c] first\n'), { commit: '0f0e0d0c' });
    assert.strictEqual(bash('git log -1', '[main 1a2b3c4] looks like a summary'), undefined, 'only read for a commit');
    // A chain that committed and then failed to push: the output still shows the commit.
    assert.deepStrictEqual(bash('git commit -m x && git push', 'Error: Exit code 1\n[main 9abcdef] x\nfatal: no remote', true), { commit: '9abcdef' });
  });

  test('gh pr merge: a branch argument, the branch gh deleted, or --match-head-commit', () => {
    assert.strictEqual(bash('gh pr merge 162 --squash'), undefined, 'a number names no branch');
    assert.deepStrictEqual(bash('gh pr merge feat-x --squash --subject "Ship it"'), { branch: 'feat-x' });
    assert.deepStrictEqual(bash('gh pr merge 12 --match-head-commit 48150b0ab'), { commit: '48150b0ab' });
    assert.deepStrictEqual(bash('gh pr merge 12 -d', '✓ Squashed and merged pull request #12 (Fix)\n✓ Deleted local branch feat-y and switched to branch main\n'), { branch: 'feat-y' });
  });

  test('bd: the ids a command names, and the id bd create printed', () => {
    assert.deepStrictEqual(bash('bd close snagboat-koh snagboat-93b.10.2 --reason "done-done"'), { planItems: ['snagboat-koh', 'snagboat-93b.10.2'] });
    assert.deepStrictEqual(bash('cd repo && bd update snagboat-abc --status in_progress --append-notes=more-notes-x1 && bd show snagboat-abc'), { planItems: ['snagboat-abc'] });
    assert.deepStrictEqual(bash('bd --db /x/beads.db show snagboat-x1y'), { planItems: ['snagboat-x1y'] });
    assert.strictEqual(bash('bd list --status open'), undefined);
    assert.strictEqual(bash('bd create --title "Fix it" --parent snagboat-93b'), undefined, 'the parent is a value, and the new id is only in the output');
    assert.deepStrictEqual(bash('bd create --title "Fix it" -t bug', '✓ Created issue: snagboat-q7z\n  Title: Fix it\n'), { planItems: ['snagboat-q7z'] });
    assert.deepStrictEqual(bash('bd create --title x --json', '{"id": "snagboat-r2d", "title": "x", "dependencies": [{"id": "snagboat-93b"}]}'), { planItems: ['snagboat-r2d'] });
    assert.strictEqual(bash('bd close snagboat-koh', 'Error: no such issue', true), undefined, "a failed call's words don't count");
  });

  test('refs are only for shell tools', () => {
    assert.strictEqual(refsOf('Read', { command: 'git checkout -b x' }, undefined, false), undefined);
    assert.deepStrictEqual(refsOf('bash', { command: 'git checkout -b x' }, undefined, false), { branch: 'x' }, "the Copilot CLI's shell tool");
  });

  test('toolInputOf: the path always; command, pattern, URL and description only with capture on', () => {
    assert.deepStrictEqual(toolInputOf('Read', { file_path: '/repo/a.ts', limit: 10 }, false), { path: '/repo/a.ts' });
    assert.strictEqual(toolInputOf('Bash', { command: 'npm test', description: 'Run tests' }, false), undefined);
    assert.deepStrictEqual(toolInputOf('Bash', { command: 'npm test', description: 'Run tests' }, true), { command: 'npm test', description: 'Run tests' });
    assert.deepStrictEqual(toolInputOf('Grep', { pattern: 'TODO', path: '/repo/src', output_mode: 'content' }, true), { path: '/repo/src', pattern: 'TODO' });
    assert.deepStrictEqual(toolInputOf('WebFetch', { url: 'https://example.com/docs', prompt: 'summarize' }, true), { url: 'https://example.com/docs' });
    assert.strictEqual(toolInputOf('WebFetch', { url: 'https://example.com/docs' }, false), undefined);
    assert.deepStrictEqual(toolInputOf('WebSearch', { query: 'node 24 fetch' }, true), { pattern: 'node 24 fetch' });
    assert.deepStrictEqual(toolInputOf('Task', { description: 'Explore the repo', prompt: 'long instructions', subagent_type: 'Explore' }, true), { description: 'Explore the repo' });
    assert.deepStrictEqual(toolInputOf('NotebookEdit', { notebook_path: '/repo/n.ipynb', new_source: 'x' }, true), { path: '/repo/n.ipynb' });
    assert.deepStrictEqual(toolInputOf('str_replace_editor', { command: 'view', path: '/repo/a.ts' }, true), { path: '/repo/a.ts' }, "a non-shell tool's command isn't a command line");
    assert.strictEqual(toolInputOf('TaskCreate', { subject: 's', description: 'never kept' }, true), undefined);
    assert.strictEqual(toolInputOf('TodoWrite', { todos: [] }, true), undefined);
    const secret = toolInputOf('Bash', { command: `curl -H "Authorization: Bearer ${'a'.repeat(40)}" https://x` }, true)!;
    assert.ok(!secret.command!.includes('aaaaaaaaaa') && secret.command!.includes('[redacted]'), 'redacted');
    const long = toolInputOf('Bash', { command: 'x'.repeat(TOOL_INPUT_MAX_CHARS + 10) }, true)!;
    assert.strictEqual(long.command!.length, TOOL_INPUT_MAX_CHARS);
    assert.ok(long.command!.endsWith('…'));
  });

  test("Remove Captured Text drops toolInput's command, pattern, URL and description, and keeps its path and refs", () => {
    const base: NormalizedEvent = { eventId: 'e', sessionId: 's', agent: 'claude-code', ts: '2026-11-21T00:00:00Z', kind: 'tool_call', status: 'success', raw: { adapter: 't', ref: 'r' } };
    const withPath = { ...base, toolInput: { path: '/a', pattern: 'p' }, refs: { branch: 'b' } };
    assert.ok(hasCapturedText(withPath));
    assert.deepStrictEqual(withoutCapturedText(withPath), { ...base, toolInput: { path: '/a' }, refs: { branch: 'b' } });
    assert.deepStrictEqual(withoutCapturedText({ ...base, toolInput: { command: 'ls' } }), base);
    assert.ok(!hasCapturedText({ ...base, toolInput: { path: '/a' } }), 'a path alone is structural');
    assert.deepStrictEqual(withoutCapturedText({ ...base, promptText: 'p…', textTruncated: true }), base);
  });

  test('the caps: textTruncated when cut, secrets redacted over the whole text first, settings clamped', () => {
    assert.deepStrictEqual(captureReply(['short'], 10), { text: 'short', truncated: false });
    assert.deepStrictEqual(captureReply(['0123456789abc'], 10), { text: '012345678…', truncated: true });
    assert.deepStrictEqual(capturePrompt(['0123456789abc'], 10), { text: '0123456789… (+3 characters)', truncated: true });
    // A key that straddles the cut: redacting only what's kept would leave its first characters.
    const straddle = captureReply(['x'.repeat(490) + ` sk-ant-${'z'.repeat(30)}`], 500)!;
    assert.ok(!straddle.text.includes('sk-ant'), straddle.text);
    assert.deepStrictEqual(captureLimitsFrom({}), { promptChars: 2000, replyChars: 500 });
    assert.deepStrictEqual(captureLimitsFrom({ 'capture.promptChars': 500_000, 'capture.replyChars': 2.7 }), { promptChars: 100_000, replyChars: 2 });
    assert.deepStrictEqual(captureLimitsFrom({ 'capture.promptChars': 'lots', 'capture.replyChars': 0 }), { promptChars: 2000, replyChars: 1 });
  });

  test("a project's .snagboat.json may lower the caps, never raise them", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-caps-')));
    const home = path.join(root, 'home');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    saveConfig(home, { version: 1, defaults: { 'capture.replyChars': 4000 }, projects: {} });
    fs.writeFileSync(path.join(repo, '.snagboat.json'), JSON.stringify({ settings: { 'capture.promptChars': 50_000, 'capture.replyChars': 300 } }));
    const s = effectiveSettings(home, repo);
    assert.strictEqual(s.values['capture.replyChars'], 300, 'lowered');
    assert.strictEqual(s.values['capture.promptChars'], undefined, 'raising is ignored');
    assert.ok(s.problems.some((p) => p.includes('capture.promptChars')));
  });

  test('Claude Code hooks: PostToolUse records toolInput and refs from the response', () => {
    const payload = {
      session_id: 's1', tool_use_id: 'tu1', hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: 'git commit -m "x"', description: 'Commit' },
      tool_response: { stdout: '[main 1a2b3c4] x\n', stderr: '', interrupted: false },
    };
    const on = normalizeHookPayload(payload, undefined, '2026-11-21T00:00:00Z', true)!;
    assert.strictEqual(on.target, 'git commit -m "x"', 'target as before');
    assert.deepStrictEqual(on.toolInput, { command: 'git commit -m "x"', description: 'Commit' });
    assert.deepStrictEqual(on.refs, { commit: '1a2b3c4' });
    const off = normalizeHookPayload(payload, undefined, '2026-11-21T00:00:00Z', false)!;
    assert.strictEqual(off.toolInput, undefined);
    assert.deepStrictEqual(off.refs, { commit: '1a2b3c4' }, 'refs are ids, kept either way');
    const failed = normalizeHookPayload({ ...payload, hook_event_name: 'PostToolUseFailure', tool_input: { command: 'git checkout -b x && git push' }, tool_response: undefined, error: "Exit code 1\nSwitched to a new branch 'x'\nfatal: no upstream" })!;
    assert.strictEqual(failed.status, 'failure');
    assert.deepStrictEqual(failed.refs, { branch: 'x' }, 'what the output shows counts even for a failed call');
    const read = normalizeHookPayload({ session_id: 's1', tool_use_id: 'tu2', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/a.ts' }, tool_response: {} })!;
    assert.deepStrictEqual(read.toolInput, { path: '/repo/a.ts' });
    assert.strictEqual(read.refs, undefined);
  });

  test('Claude Code transcripts: live and rebuilt tool calls carry toolInput and refs from the tool_result', () => {
    const use = (id: string, name: string, input: unknown) => JSON.stringify({ type: 'assistant', uuid: `a-${id}`, sessionId: 's', timestamp: '2026-11-21T00:00:01Z', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 1, output_tokens: 1 } } });
    const result = (id: string, content: string, toolUseResult?: unknown) => JSON.stringify({ type: 'user', uuid: `u-${id}`, sessionId: 's', timestamp: '2026-11-21T00:00:02Z', ...(toolUseResult ? { toolUseResult } : {}), message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
    const lines = [
      use('t1', 'Bash', { command: 'bd create --title "x"', description: 'File it' }),
      result('t1', '✓ Created issue: snagboat-n3w', { stdout: '✓ Created issue: snagboat-n3w\n', stderr: '' }),
      use('t2', 'Glob', { pattern: '**/*.ts', path: '/repo' }),
      result('t2', 'a.ts'),
    ];
    const live = new LiveToolCalls();
    const liveEvents = normalizeTranscriptChunk(lines, '/t/s.jsonl', 0, { captureContent: true, seen: new SeenMessages(), toolCalls: live }).filter((e) => e.kind === 'tool_call');
    const rebuilt = normalizeTranscriptSession([{ file: '/t/s.jsonl', lines }], { captureContent: true }).filter((e) => e.kind === 'tool_call');
    for (const events of [liveEvents, rebuilt]) {
      assert.deepStrictEqual(events.map((e) => [e.toolName, e.toolInput, e.refs]), [
        ['Bash', { command: 'bd create --title "x"', description: 'File it' }, { planItems: ['snagboat-n3w'] }],
        ['Glob', { path: '/repo', pattern: '**/*.ts' }, undefined],
      ]);
    }
    const off = normalizeTranscriptSession([{ file: '/t/s.jsonl', lines }], { captureContent: false }).filter((e) => e.kind === 'tool_call');
    assert.deepStrictEqual(off.map((e) => e.toolInput), [undefined, { path: '/repo' }]);
  });

  test('Claude Code transcripts: prompts and replies follow the caps given', () => {
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 's', timestamp: '2026-11-21T00:00:00Z', promptId: 'p1', message: { content: [{ type: 'text', text: 'p'.repeat(3000) }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', sessionId: 's', timestamp: '2026-11-21T00:00:01Z', message: { id: 'm1', content: [{ type: 'text', text: 'r'.repeat(800) }], usage: { input_tokens: 1, output_tokens: 1 } } }),
    ];
    const byDefault = normalizeTranscriptSession([{ file: '/t/s.jsonl', lines }], { captureContent: true });
    assert.deepStrictEqual(byDefault.map((e) => [e.kind, (e.promptText ?? e.textExcerpt)?.length, e.textTruncated]), [['user_prompt', 2000 + '… (+1,000 characters)'.length, true], ['turn_stop', 500, true]]);
    const raised = normalizeTranscriptSession([{ file: '/t/s.jsonl', lines }], { captureContent: true, limits: { promptChars: 5000, replyChars: 1000 } });
    assert.deepStrictEqual(raised.map((e) => [(e.promptText ?? e.textExcerpt)?.length, e.textTruncated]), [[3000, undefined], [800, undefined]]);
  });

  test('Copilot: CLI tool calls carry toolInput and refs from their arguments; CLI and OTel text follows the caps', () => {
    const ev = (type: string, id: string, n: number, data: Record<string, unknown>) => JSON.stringify({ type, id, parentId: null, timestamp: `2026-11-21T00:00:0${n}Z`, data });
    const lines = [
      ev('session.start', 'e0', 0, { sessionId: 'c1', context: { cwd: '/repo' } }),
      ev('user.message', 'e1', 1, { content: 'abcdefghij', interactionId: 'I1' }),
      ev('tool.execution_start', 'e2', 2, { toolCallId: 't1', toolName: 'bash', arguments: { command: 'git switch -c topic', description: 'Branch' } }),
      ev('tool.execution_complete', 'e3', 3, { toolCallId: 't1', success: true }),
      ev('tool.execution_start', 'e4', 4, { toolCallId: 't2', toolName: 'view', arguments: { path: '/repo/README.md' } }),
      ev('tool.execution_complete', 'e5', 5, { toolCallId: 't2', success: true }),
    ];
    const events = normalizeCopilotCliChunk(lines, '/c/c1/events.jsonl', 0, new CopilotCliState(), { captureContent: true, limits: { promptChars: 4, replyChars: 500 } });
    const prompt = events.find((e) => e.kind === 'user_prompt')!;
    assert.deepStrictEqual([prompt.promptText, prompt.textTruncated], ['abcd… (+6 characters)', true]);
    assert.deepStrictEqual(events.filter((e) => e.kind === 'tool_call').map((e) => [e.toolInput, e.refs]), [
      [{ command: 'git switch -c topic', description: 'Branch' }, { branch: 'topic' }],
      [{ path: '/repo/README.md' }, undefined],
    ]);
    const otel = normalizeOtlpTraces(
      { resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'invoke_agent', spanId: 's1', attributes: [{ key: 'gen_ai.output.messages', value: { stringValue: JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: 'a long reply' }] }]) } }] }] }] }] },
      { captureContent: true, limits: { promptChars: 2000, replyChars: 5 } }
    );
    assert.deepStrictEqual([otel[0].textExcerpt, otel[0].textTruncated], ['a lo…', true]);
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
  process.exit(failures > 0 ? 1 : 0);
}

main();
