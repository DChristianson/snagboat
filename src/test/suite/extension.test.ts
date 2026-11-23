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
    const ext = vscode.extensions.getExtension<SnagboatTestApi>('dchristianson.snagboat');
    assert.ok(ext, 'extension should be present');
    api = await ext!.activate();
  });

  test('emitting a test event flows through bus -> aggregate -> snapshot', async () => {
    const before = api.getAggregateSnapshot();
    const beforeTokens = before.totalTokens;
    const beforeEvents = before.perAgent['claude-code']?.eventCount ?? 0;

    await vscode.commands.executeCommand('snagboat._emitTestEvent');
    await vscode.commands.executeCommand('snagboat._emitTestEvent');

    // As a client of the core, the events go to the core and come back on its feed.
    await waitFor(() => api.getAggregateSnapshot().totalTokens >= beforeTokens + 2 * 35);
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

  test('events are written to the per-user store, by the core', async () => {
    const home = process.env.SNAGBOAT_HOME;
    assert.ok(home, 'SNAGBOAT_HOME must be set by runTest.ts');
    const workspacesDir = path.join(home!, 'data', 'workspaces');
    await vscode.commands.executeCommand('snagboat._emitTestEvent');
    const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const tagged = () => {
      if (!fs.existsSync(workspacesDir)) return false;
      for (const key of fs.readdirSync(workspacesDir)) {
        const eventsDir = path.join(workspacesDir, key, 'events');
        if (!fs.existsSync(eventsDir)) continue;
        for (const day of fs.readdirSync(eventsDir)) {
          const lines = fs.readFileSync(path.join(eventsDir, day), 'utf8').split('\n').filter(Boolean);
          if (lines.some((l) => JSON.parse(l).sessionId === 'dev-test-session' && JSON.parse(l).workspace === folder)) return true;
        }
      }
      return false;
    };
    await waitFor(tagged);
    // The window is a client: the core writes the folder, and the window claims nothing (3c-3c).
    const claims = fs.readdirSync(workspacesDir).map((key) => path.join(workspacesDir, key, 'writer.json')).filter((f) => fs.existsSync(f));
    assert.deepStrictEqual(claims, [], 'no claim');
    const core = JSON.parse(fs.readFileSync(path.join(home!, 'core.json'), 'utf8'));
    assert.notStrictEqual(core.pid, process.pid, 'the core runs in its own process');
  });

  test("nothing is written to VS Code's storage for the window", () => {
    const dir = api.getVsCodeStorageDir();
    assert.ok(dir, 'the test window has a folder open, so it has workspace storage');
    assert.ok(!fs.existsSync(dir!), 'no events, aggregates or checkpoints there (a fresh install has no old store to mark)');
  });

  test("the window copies Snagboat's settings into ~/.snagboat/config.json", async () => {
    const configFile = path.join(process.env.SNAGBOAT_HOME!, 'config.json');
    const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const project = () => {
      try {
        return (JSON.parse(fs.readFileSync(configFile, 'utf8')).projects ?? {})[folder] as Record<string, unknown> | undefined;
      } catch {
        return undefined;
      }
    };
    const config = vscode.workspace.getConfiguration('snagboat');
    await config.update('heuristics.stalled.minutes', 21, vscode.ConfigurationTarget.Workspace);
    try {
      await waitFor(() => project()?.['heuristics.stalled.minutes'] === 21);
    } finally {
      await config.update('heuristics.stalled.minutes', undefined, vscode.ConfigurationTarget.Workspace);
    }
    await waitFor(() => project() === undefined, 8000);
  });

  test('a setting changed in config.json outside VS Code (the advisor UI applying a threshold) comes into its settings', async () => {
    const configFile = path.join(process.env.SNAGBOAT_HOME!, 'config.json');
    const key = 'heuristics.stalled.maxMinutes';
    const user = () => vscode.workspace.getConfiguration('snagboat').inspect<number>(key)?.globalValue;
    const edit = (value: number | undefined) => {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (value === undefined) delete config.defaults[key];
      else config.defaults[key] = value;
      // As the core writes it: a temp file renamed over config.json.
      fs.writeFileSync(`${configFile}.test.tmp`, JSON.stringify(config, null, 2));
      fs.renameSync(`${configFile}.test.tmp`, configFile);
    };
    try {
      edit(123);
      await waitFor(() => user() === 123);
      // And the window's next sync keeps it rather than undoing it.
      await waitFor(() => JSON.parse(fs.readFileSync(configFile, 'utf8')).defaults[key] === 123);
    } finally {
      await vscode.workspace.getConfiguration('snagboat').update(key, undefined, vscode.ConfigurationTarget.Global);
    }
    await waitFor(() => JSON.parse(fs.readFileSync(configFile, 'utf8')).defaults[key] === undefined);
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

  test('a synthetic Claude Code transcript line is picked up by the core and reaches the window', async () => {
    const transcriptsDir = process.env.SNAGBOAT_TEST_TRANSCRIPTS_DIR;
    assert.ok(transcriptsDir, 'SNAGBOAT_TEST_TRANSCRIPTS_DIR must be set by runTest.ts');

    const beforeTokens = api.getAggregateSnapshot().perAgent['claude-code']?.tokens.input ?? 0;

    // Shaped after a real assistant transcript line captured from this
    // machine's own ~/.claude/projects/.../*.jsonl transcript.
    const line = JSON.stringify({
      type: 'assistant',
      uuid: `fixture-${Date.now()}`,
      sessionId: 'fixture-session',
      cwd: vscode.workspace.workspaceFolders![0].uri.fsPath,
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
    const transcriptsDir = process.env.SNAGBOAT_TEST_TRANSCRIPTS_DIR!;
    const before = api.getAggregateSnapshot().perAgent['claude-code']?.tokens.output ?? 0;

    // Real transcripts write one line per content block, each repeating the
    // whole message's usage (see src/test/fixtures/claude-transcript-redacted.jsonl).
    const messageId = `msg_fixture_${Date.now()}`;
    const lines = ['thinking', 'text', 'tool_use'].map((type, i) =>
      JSON.stringify({
        type: 'assistant',
        uuid: `${messageId}-${i}`,
        sessionId: 'fixture-split-session',
        cwd: vscode.workspace.workspaceFolders![0].uri.fsPath,
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

  test('a Claude Code hook reaches the core through the hook script, and only with its token', async () => {
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

    // The same payload without the token is rejected (the token check comes first). The window
    // receives no hooks itself and publishes no route: the script sends hooks to the core (core.route).
    assert.ok(!fs.existsSync(path.join(home!, 'routes')), 'no window routes');
    const [port] = fs.readFileSync(path.join(home!, 'core.route'), 'utf8').trim().split(' ');
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

  test('a Copilot agent session started in this workspace is read from its session log by the core', async () => {
    const base = process.env.SNAGBOAT_COPILOT_SESSIONS_DIR;
    assert.ok(base, 'SNAGBOAT_COPILOT_SESSIONS_DIR must be set by runTest.ts');
    const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const before = api.getAggregateSnapshot().perAgent['copilot']?.tokens.output ?? 0;
    const at = new Date().toISOString();
    const line = (type: string, id: string, parentId: string | null, data: Record<string, unknown>) => JSON.stringify({ type, id, parentId, timestamp: at, data });
    fs.mkdirSync(path.join(base!, 'it-session'), { recursive: true });
    fs.writeFileSync(
      path.join(base!, 'it-session', 'events.jsonl'),
      [
        line('session.start', 'c0', null, { sessionId: 'it-session', context: { cwd: folder } }),
        line('user.message', 'c1', 'c0', { content: 'x', interactionId: 'I1' }),
        line('session.usage_record', 'c2', 'c1', { usage: { model: 'm', inputTokens: 100, outputTokens: 17, cacheReadTokens: 60, cacheWriteTokens: 0, maxPromptTokens: 200000 } }),
      ].join('\n') + '\n'
    );
    // runTest.ts sets a 500ms discovery interval (the default is 60s).
    await waitFor(() => (api.getAggregateSnapshot().perAgent['copilot']?.tokens.output ?? 0) > before);
    assert.strictEqual(api.getAggregateSnapshot().perAgent['copilot'].tokens.output, before + 17);
  });

  test('live events reach the Sessions list and an open session view', async () => {
    const sessions = api.getSessions();
    await vscode.commands.executeCommand('snagboat._emitTestEvent');
    const today = new Date().toISOString().slice(0, 10);
    await waitFor(() => sessions.list(undefined, today).sessions.some((s) => s.sessionId === 'dev-test-session'));
    const view = await sessions.open('dev-test-session');
    assert.ok(view && view.calls.length >= 1, 'the open session has its model calls');
    const before = view!.calls.length;
    await vscode.commands.executeCommand('snagboat._emitTestEvent');
    await waitFor(() => (sessions.view()?.calls.length ?? 0) > before);
    sessions.close();
  });

  test('a rule added in settings runs like a built-in, and stops when removed', async () => {
    const config = vscode.workspace.getConfiguration('snagboat');
    const rule = {
      id: 'test:model-calls',
      title: 'Any model call',
      scope: 'session',
      measure: { type: 'count', filter: { kind: 'turn_stop', hasTokens: true } },
      when: { gte: 1 },
      severity: 'info',
      summary: '{value} model calls',
    };
    try {
      await config.update('rules', [rule], vscode.ConfigurationTarget.Global);
      // With notifications on, the nudge path runs too (a notification appears in the test window).
      await config.update('nudges.notify', 'all', vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('snagboat._emitTestEvent');
      await waitFor(() => api.getFindings().some((f) => f.heuristicId === 'test:model-calls'));
    } finally {
      await config.update('rules', undefined, vscode.ConfigurationTarget.Global);
      await config.update('nudges.notify', undefined, vscode.ConfigurationTarget.Global);
    }
    await waitFor(() => !api.getFindings().some((f) => f.heuristicId === 'test:model-calls'));
  });

  test('Discover Heuristics runs over this workspace and opens the detail view', async () => {
    await vscode.commands.executeCommand('snagboat.discover');
    await waitFor(() =>
      vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputWebview && t.label === 'Snagboat'))
    );
  });

  test('Export Project... is registered (it runs snagboat export in-process: exportCommand.unit.test.ts tests that)', async () => {
    assert.ok((await vscode.commands.getCommands(true)).includes('snagboat.exportProject'));
  });

  test('the compact findings panel opens in its own sidebar view', async () => {
    // VS Code adds a focus command for each contributed view; it fails if the view isn't registered.
    await vscode.commands.executeCommand('snagboat.findings.focus');
  });

  test("the findings view and status bar link to an advisor's waiting proposals (counts only, from the core)", async () => {
    const home = process.env.SNAGBOAT_HOME!;
    // One period report for Purser whose latest revision proposes one change you haven't marked.
    const dir = path.join(home, 'advisors', 'purser');
    fs.mkdirSync(path.join(dir, 'periods'), { recursive: true });
    const at = new Date().toISOString();
    const report = 'proposals-test';
    fs.writeFileSync(
      path.join(dir, 'periods', `${report}.json`),
      JSON.stringify({ version: 1, id: report, advisor: 'purser', advisorVersion: 'test', period: 'weekly', label: '2099-W01', from: at, to: '2099-01-08T00:00:00.000Z', trigger: 'request', createdAt: at, measures: [], workspaces: [], rules: { defaults: {}, projects: {}, saved: [] }, summary: '', revisions: [{ rev: 1, createdAt: at, summary: '', verdicts: [], proposals: ['purser-test-1'] }] })
    );
    fs.writeFileSync(
      path.join(dir, 'proposals.jsonl'),
      JSON.stringify({ version: 1, at, proposal: 'purser-test-1', advisor: 'purser', type: 'proposed', report, rev: 1, title: 'Secret title', change: { setting: 'heuristics.stalled.minutes', value: 6 }, scope: 'global', what: 'x', why: 'y', prediction: { measure: 'cache_hit_rate', text: 'z' } }) + '\n'
    );
    try {
      assert.deepStrictEqual(await api.checkWaitingProposals(), [{ advisor: 'purser', name: 'Purser', waiting: 1 }]);
      assert.deepStrictEqual(api.getFindingsViewState().proposals, [{ advisor: 'purser', name: 'Purser', waiting: 1, text: 'Purser: 1 proposal waiting' }]);
      assert.ok(!JSON.stringify(api.getFindingsViewState()).includes('Secret title'), "the window never sees the proposal's content");
    } finally {
      fs.rmSync(path.join(dir, 'periods', `${report}.json`));
      fs.rmSync(path.join(dir, 'proposals.jsonl'));
    }
    assert.deepStrictEqual(await api.checkWaitingProposals(), [], 'none waiting: nothing shows');
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
