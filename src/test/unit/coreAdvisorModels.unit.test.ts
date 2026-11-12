import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { readApprovals } from '../../core/advisorApprovals';
import { saveConfig } from '../../core/config';
import { coreRequest, readCoreFile } from '../../core/service/coreFile';
import { CoreService } from '../../core/service/server';
import { StoreWriter } from '../../core/service/storeWriter';
import { syntheticEvents } from 'factory-clock/web';

// Advisor proposals in the advisor UI (RFC step 5c-2b): the core asks only local models, from your user
// settings; the first request waits for you to approve its exact payload in the page; approvals are
// kept in advisor-approvals.json, shared with VS Code; answers land in the Suggestions view.

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  // A local model server shaped like Ollama's OpenAI-compatible API: names the first candidate it's sent.
  const asked: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
  const model = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'tiny-model' }] }));
      const request = JSON.parse(body) as { model: string; messages: Array<{ role: string; content: string }> };
      asked.push(request);
      const id = /"(discovery:[a-z0-9-]+)"/.exec(request.messages.map((m) => m.content).join('\n'))?.[1] ?? 'none';
      const answer = { names: [{ id, title: 'Named by the model', summary: 'A summary from the model.', suggestedAction: 'Do less.' }], rules: [], categories: [] };
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(answer) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    });
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  const modelPort = (model.address() as { port: number }).port;

  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-advise-')));
  const ws = path.join(home, 'proj');
  fs.mkdirSync(ws);
  const base = syntheticEvents();
  const latest = Math.max(...base.map((e) => Date.parse(e.ts)));
  const shift = Date.now() - 3_600_000 - latest;
  await new StoreWriter(home).write(
    [0, 1, 2, 3].flatMap((k) => base.map((e) => ({ ...e, eventId: `${e.eventId}-${k}`, sessionId: `${e.sessionId}-${k}`, ...(e.turnId ? { turnId: `${e.turnId}-${k}` } : {}), ts: new Date(Date.parse(e.ts) + shift - k * 86_400_000).toISOString(), workspace: ws })))
  );
  const providers = (extra: unknown[] = []) => [{ id: 'local', label: 'Test model', baseUrl: `http://127.0.0.1:${modelPort}/v1`, model: '' }, ...extra];
  saveConfig(home, { version: 1, defaults: { 'advisor.providers': providers([{ id: 'cloud', label: 'Hosted', baseUrl: 'https://api.example.com/v1', model: 'm' }]) }, projects: { [ws]: { 'advisor.providers': [{ id: 'sneaky', label: 'Project', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' }] } } });
  const core = await CoreService.start({ home, version: 'test', idleMs: 0, collect: false });
  const info = readCoreFile(home)!;
  type View = { status: string; advisor: { status: string; available: boolean }; candidates: Array<{ id: string; named: boolean; title: string }>; core: { advisors: Array<{ id: string }>; approval?: { id: string; advisor: string; model: string; payload: string }; error?: string } };
  const get = async () => (await coreRequest(core.port, info.token, 'GET', `/suggestions?workspace=${encodeURIComponent(ws)}`, undefined, 60_000)).body as View;
  const act = async (body: Record<string, unknown>) => coreRequest(core.port, info.token, 'POST', '/suggestions', { workspace: ws, ...body }, 60_000);
  const until = async (ok: (v: View) => boolean, what: string): Promise<View> => {
    for (let i = 0; i < 150; i++) {
      const v = await get();
      if (ok(v)) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`never: ${what}`);
  };

  test('only local advisors from your user settings are offered: not hosted ones, not a project\'s', async () => {
    const v = await until((x) => x.status === 'ready', 'discovery ready');
    assert.deepStrictEqual(v.core.advisors.map((a) => a.id), ['local']);
    assert.ok(v.advisor.available, "VS Code's Ask the advisor button shows");
  });

  test("the first request waits for your approval with its exact payload; Don't send sends nothing", async () => {
    const first = (await act({ action: 'askAdvisor' })).body as View;
    assert.strictEqual(first.advisor.status, 'asking', 'the view returned says it is asking, so the page keeps looking');
    const v = await until((x) => !!x.core.approval, 'approval shown');
    const a = v.core.approval!;
    assert.deepStrictEqual([a.advisor, a.model], ['Test model', 'tiny-model'], 'the model from the server, as none was set');
    assert.match(a.payload, /"model": "tiny-model"/);
    assert.match(a.payload, /"messages"/);
    assert.strictEqual(asked.length, 0, 'nothing sent yet');
    await act({ action: 'approve', id: a.id, send: false });
    await until((x) => !x.core.approval && x.advisor.status !== 'asking', 'request dropped');
    assert.strictEqual(asked.length, 0);
    assert.deepStrictEqual(readApprovals(home), {});
    assert.strictEqual((await act({ action: 'approve', id: a.id, send: true })).status, 409, 'that request is gone');
  });

  test('Send: the request goes out, the approval is kept for VS Code too, and the answer names a candidate', async () => {
    await act({ action: 'askAdvisor' });
    const pending = await until((x) => !!x.core.approval, 'approval shown');
    const sent = (await act({ action: 'approve', id: pending.core.approval!.id, send: true })).body as View;
    assert.strictEqual(sent.core.approval, undefined, 'no longer waiting in the reply, so the page looks for the answer');
    const v = await until((x) => x.advisor.status === 'done', 'answered');
    assert.strictEqual(asked.length, 1);
    assert.ok(readApprovals(home).local, 'approval kept');
    assert.ok(v.candidates.some((c) => c.named && c.title === 'Named by the model'), JSON.stringify(v.candidates.map((c) => [c.id, c.named, c.title])));
  });

  test('approved once, the next request goes straight out', async () => {
    await act({ action: 'askAdvisor' });
    await until((x) => x.advisor.status === 'done' && asked.length === 2, 'second answer');
    const v = await get();
    assert.strictEqual(v.core.approval, undefined);
  });

  test("a failure says what's wrong in the page; a hosted or unknown advisor is refused", async () => {
    assert.strictEqual((await act({ action: 'askAdvisor', advisorId: 'cloud' })).status, 200);
    const v = await until((x) => !!x.core.error, 'error shown');
    assert.match(v.core.error!, /no local advisor "cloud"/);
    assert.strictEqual(asked.length, 2);
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
  await core.stop();
  model.close();
  console.log(`\n${tests.length - failures}/${tests.length} passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
