import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as vscode from 'vscode';
import { SnagboatTestApi } from '../../extension';

const HOOKS_PORT = 45680;
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

  test('a synthetic Claude Code hook payload is picked up by the hooks receiver', async () => {
    const before = api.getAggregateSnapshot().perAgent['claude-code']?.eventCountByKind.tool_call ?? 0;

    // Shaped after a real PostToolUse payload captured live from this machine.
    await postJson(HOOKS_PORT, '/hook', {
      session_id: 'fixture-session',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_response: {},
    });

    await waitFor(() => (api.getAggregateSnapshot().perAgent['claude-code']?.eventCountByKind.tool_call ?? 0) > before);
    assert.strictEqual(api.getAggregateSnapshot().perAgent['claude-code'].eventCountByKind.tool_call, before + 1);
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
});
