import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as childProcess from 'child_process';
import * as vscode from 'vscode';
import { SnagboatTestApi } from '../../extension';

const OTLP_PORT = 4319;

function waitFor(predicate: () => boolean, timeoutMs = 8000, intervalMs = 100): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('waitFor: timed out waiting for condition'));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function postJsonStatus(port: number, urlPath: string, body: unknown, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

function postJson(port: number, urlPath: string, body: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

suite('Snagboat core plumbing', () => {
  let api: SnagboatTestApi;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension<SnagboatTestApi>('snagboat.snagboat');
    assert.ok(ext, 'extension should be present');
    api = await ext!.activate();
  });

  test('emitting a test event flows through bus -> aggregate -> snapshot', async () => {
    const before = api.getAggregateSnapshot();
    const beforeTokens = before.totalTokens;
    const beforeEvents = before.perAgent['claude-code']?.eventCount ?? 0;

    await vscode.commands.executeCommand('snagboat._emitTestEvent');
    await vscode.commands.executeCommand('snagboat._emitTestEvent');

    const after = api.getAggregateSnapshot();
    assert.strictEqual(after.totalTokens, beforeTokens + 2 * 35, 'total tokens should include both emitted events');
    assert.strictEqual(
      after.perAgent['claude-code'].eventCount,
      beforeEvents + 2,
      'claude-code event count should increase by 2'
    );

    const storeCount = api.getEventStore().query({ agents: ['claude-code'] }).length;
    assert.ok(storeCount >= 2, 'EventStore should also have ingested both emitted events');

    // Recent activity means "stalled" shouldn't be firing; this mainly proves
    // the real vscode.workspace.getConfiguration() wiring in heuristicSettings()
    // doesn't throw in a live host, not the heuristic's own logic (unit-tested).
    assert.ok(!api.getFindings().some((f) => f.heuristicId === 'stalled'), 'stalled should not fire right after recent activity');
  });

  test('saving a real file triggers the edit-tracker adapter', async () => {
    const before = api.getAggregateSnapshot().localEditCount;

    const fileUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'edit-tracker-smoke.txt');
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from('initial\n', 'utf8'));
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(fileUri, new vscode.Position(0, 0), 'more text\n');
    await vscode.workspace.applyEdit(edit);
    await doc.save();

    await waitFor(() => api.getAggregateSnapshot().localEditCount > before);
    assert.strictEqual(api.getAggregateSnapshot().localEditCount, before + 1);
  });

  test('a synthetic Claude Code transcript line is picked up by the transcript-tail path', async () => {
    const transcriptsDir = process.env.SNAGBOAT_CLAUDE_TRANSCRIPTS_DIR;
    assert.ok(transcriptsDir, 'SNAGBOAT_CLAUDE_TRANSCRIPTS_DIR must be set by runTest.ts');

    const beforeTokens = api.getAggregateSnapshot().perAgent['claude-code']?.tokens.input ?? 0;

    // Shaped after a real assistant transcript line captured from this
    // machine's own ~/.claude/projects/.../*.jsonl transcript.
    const line = JSON.stringify({
      type: 'assistant',
      uuid: `fixture-${Date.now()}`,
      sessionId: 'fixture-session',
      timestamp: new Date().toISOString(),
      message: {
        model: 'claude-sonnet-5',
        usage: { input_tokens: 7, output_tokens: 13, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    fs.writeFileSync(path.join(transcriptsDir!, 'fixture-session.jsonl'), line + '\n');

    await waitFor(() => (api.getAggregateSnapshot().perAgent['claude-code']?.tokens.input ?? 0) > beforeTokens);
    assert.strictEqual(api.getAggregateSnapshot().perAgent['claude-code'].tokens.input, beforeTokens + 7);
  });

  test('a Claude Code message split across transcript lines is counted once', async () => {
    const transcriptsDir = process.env.SNAGBOAT_CLAUDE_TRANSCRIPTS_DIR!;
    const before = api.getAggregateSnapshot().perAgent['claude-code']?.tokens.output ?? 0;

    // Real transcripts write one line per content block, each repeating the
    // whole message's usage (see src/test/fixtures/claude-transcript-redacted.jsonl).
    const messageId = `msg_fixture_${Date.now()}`;
    const lines = ['thinking', 'text', 'tool_use'].map((type, i) =>
      JSON.stringify({
        type: 'assistant',
        uuid: `${messageId}-${i}`,
        sessionId: 'fixture-split-session',
        timestamp: new Date().toISOString(),
        message: {
          id: messageId,
          model: 'claude-sonnet-5',
          content: [type === 'text' ? { type, text: 'ok' } : { type }],
          usage: { input_tokens: 1, output_tokens: 11, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      })
    );
    fs.writeFileSync(path.join(transcriptsDir, 'fixture-split-session.jsonl'), lines.join('\n') + '\n');

    await waitFor(() => (api.getAggregateSnapshot().perAgent['claude-code']?.tokens.output ?? 0) > before);
    // Give any (wrongly) separate events for the other two lines time to land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.strictEqual(api.getAggregateSnapshot().perAgent['claude-code'].tokens.output, before + 11);
  });

  test('a Claude Code hook reaches this window through the routing script, and only with its token', async () => {
    const home = process.env.SNAGBOAT_HOME;
    assert.ok(home, 'SNAGBOAT_HOME must be set by runTest.ts');
    const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const toolCalls = () => api.getAggregateSnapshot().perAgent['claude-code']?.eventCountByKind.tool_call ?? 0;
    const before = toolCalls();

    // Shaped after a real PostToolUse payload captured live from this machine,
    // sent the way Claude Code does: piped into the command from settings.json.
    const payload = {
      session_id: 'fixture-session',
      cwd: folder,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_response: {},
    };
    const run = childProcess.spawnSync('sh', [path.join(home!, 'bin', 'snagboat-hook')], {
      input: JSON.stringify(payload),
      env: { ...process.env, SNAGBOAT_HOME: home, CLAUDE_PROJECT_DIR: path.join(folder, 'some', 'subdir') },
    });
    assert.strictEqual(run.status, 0);
    await waitFor(() => toolCalls() > before);
    assert.strictEqual(toolCalls(), before + 1);

    // The same payload without the token is rejected (the token check comes first).
    const routeFile = path.join(home!, 'routes', folder.replace(/\//g, '-'));
    const [port] = fs.readFileSync(routeFile, 'utf8').trim().split(' ');
    const status = await postJsonStatus(Number(port), '/hook', payload);
    assert.strictEqual(status, 401);

    const settings = JSON.parse(fs.readFileSync(path.join(folder, '.claude', 'settings.json'), 'utf8'));
    assert.ok(settings.hooks.PostToolUse.some((m: any) => m.hooks.some((h: any) => h.command.includes('snagboat-hook'))));
  });

  test('a synthetic Copilot OTLP invoke_agent span is picked up by the OTel receiver', async () => {
    const before = api.getAggregateSnapshot().perAgent['copilot']?.tokens.input ?? 0;

    // Shaped per Microsoft's own OTel monitoring docs, confirmed live earlier.
    await postJson(OTLP_PORT, '/v1/traces', {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'session.id', value: { stringValue: 'fixture-session' } }] },
          scopeSpans: [
            {
              spans: [
                {
                  spanId: 'fixture-span',
                  name: 'invoke_agent',
                  attributes: [
                    { key: 'gen_ai.usage.input_tokens', value: { intValue: '9' } },
                    { key: 'gen_ai.usage.output_tokens', value: { intValue: '4' } },
                  ],
                  status: { code: 1 },
                },
              ],
            },
          ],
        },
      ],
    });

    await waitFor(() => (api.getAggregateSnapshot().perAgent['copilot']?.tokens.input ?? 0) > before);
    assert.strictEqual(api.getAggregateSnapshot().perAgent['copilot'].tokens.input, before + 9);
  });

  test('the detail view opens as a webview tab and the today snapshot tracks new events', async () => {
    const beforeToday = api.getTodaySnapshot().totalTokens;
    await vscode.commands.executeCommand('snagboat._emitTestEvent');
    await waitFor(() => api.getTodaySnapshot().totalTokens > beforeToday);
    assert.strictEqual(api.getTodaySnapshot().totalTokens, beforeToday + 35);

    await vscode.commands.executeCommand('snagboat.openDetail');
    await waitFor(() =>
      vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputWebview && t.label === 'Snagboat'))
    );
  });
});
