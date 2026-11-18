import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { SetupConversation } from '@snagboat/schema';
import { saveConfig } from '../../core/config';
import { coreRequest, readCoreFile } from '../../core/service/coreFile';
import { CoreService } from '../../core/service/server';

// The + page as a chat (snagboat-79f.7.16): the routes the advisor UI calls, in the order it calls them,
// with the browser's read-only key from a one-time link; and the page's files wired to them. A stub local
// model answers; trying the page against a real local model in a browser is a manual check.

type View = { setup: SetupConversation; ask?: { state: string; approval?: { id: string; ability?: string } }; models: Array<{ id: string; label: string }>; advisor?: { id: string } };

function raw(port: number, method: string, urlPath: string, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  // A local model: a question first, then an advisor once asked to propose.
  const model = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const request = JSON.parse(body) as { model: string; messages: Array<{ role: string; content: string }> };
      const last = request.messages.filter((m) => m.role === 'user').pop()?.content ?? '';
      const answer = /propose/i.test(last)
        ? { reply: 'Here is an advisor for it.', proposal: { name: 'Tightwad', status: 'Spending fewer tokens per change', goal: 'fewer-tokens', measures: ['cache_hit_rate'], rules: [], maxPerHour: 1, period: 'weekly', color: 'teal', icon: 'coin', voice: 'You watch the spend.' } }
        : { reply: `Which matters more, cost or time? (${request.model})`, proposal: null };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(answer) } }] }));
    });
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;

  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-setup-ui-')));
  saveConfig(home, { version: 1, defaults: { advisors: [{ id: 'small', label: 'Small model', baseUrl: base, model: 'small-1' }, { id: 'big', label: 'Big model', baseUrl: base, model: 'big-1' }] }, projects: {} });
  const core = await CoreService.start({ home, version: 'test', idleMs: 0, collect: false, periodEveryMs: 0 });
  const info = readCoreFile(home)!;
  // The page's key: a one-time link swapped for a read-only session.
  const link = (await coreRequest(core.port, info.token, 'POST', '/ui-links', {})).body as { code: string };
  const reader = (JSON.parse((await raw(core.port, 'POST', '/ui-session', JSON.stringify({ code: link.code }))).text) as { token: string }).token;
  const page = (method: string, p: string, body?: unknown) => coreRequest(core.port, reader, method, p, body, 30_000);
  const until = async (id: string, turns: number): Promise<View> => {
    for (let i = 0; i < 200; i++) {
      const v = (await page('GET', `/advisor-setups/${id}`)).body as View;
      // The page shows the waiting request with Send; this is that click.
      if (v.ask?.approval) await page('POST', `/advisor-setups/${id}/approval`, { id: v.ask.approval.id, send: true });
      if (v.setup.turns.length >= turns && !v.ask) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`never ${turns} turns`);
  };

  test("the page's files: a model picker, the chat, the form kept as a fallback, and the advisor page's setup conversation", () => {
    const dir = path.join(__dirname, '..', '..', '..', 'media', 'ui');
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const js = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
    for (const id of ['setup-model', 'setup-turns', 'setup-compose', 'setup-text', 'setup-send', 'setup-form-link', 'add-form', 'add-chat', 'setup-history']) assert.match(html, new RegExp(`id="${id}"`), id);
    assert.match(html, /<form id="add-form"[^>]*hidden>/, 'the form is the fallback, hidden at first');
    assert.match(html, /<option value="">Pick a model…<\/option>/, 'no model picked at first');
    assert.ok(!/style="|<script>/.test(html), 'no inline style or script');
    for (const route of ["'/advisor-setups'", '/advisor-setups/${encodeURIComponent(setup.id)}/messages', '/advisor-setups/${encodeURIComponent(setup.id)}/proposal', '/advisor-setups/${encodeURIComponent(setup.id)}/approval', '/advisor-setups?advisor=', "api('/advisors', { method: 'POST'"]) assert.ok(js.includes(route), route);
    assert.match(js, /Pick a model first/, 'no message before a model is picked');
  });

  test('before a model is picked: the models to pick from, and nothing can be sent without one', async () => {
    const list = (await page('GET', '/advisor-setups')).body as { drafts: unknown[]; models: Array<{ id: string; label: string; model?: string }> };
    assert.deepStrictEqual(list.models, [{ id: 'small', label: 'Small model', model: 'small-1' }, { id: 'big', label: 'Big model', model: 'big-1' }]);
    assert.strictEqual((await page('POST', '/advisor-setups', { text: 'I spend too much' })).status, 400);
  });

  let made = '';
  test('a chat with the browser key: approve, switch model mid-conversation, accept, and the advisor page shows its setup conversation', async () => {
    const started = await page('POST', '/advisor-setups', { model: 'small', text: 'I spend too much on tokens.' });
    assert.strictEqual(started.status, 201);
    const id = (started.body as View).setup.id;
    let v = await until(id, 2);
    assert.match(v.setup.turns[1].text, /small-1/);
    assert.strictEqual((await page('POST', `/advisor-setups/${id}/messages`, { text: 'Cost. Please propose one.', model: 'big' })).status, 202);
    v = await until(id, 4);
    assert.deepStrictEqual(v.setup.turns.map((t) => t.model?.advisor ?? null), [null, 'small', 'big', 'big']);
    assert.strictEqual(v.setup.proposal?.spec.model, 'big');
    const accepted = await page('POST', `/advisor-setups/${id}/proposal`, { action: 'accept', turn: v.setup.proposal!.turn });
    assert.strictEqual(accepted.status, 201);
    made = (accepted.body as View).advisor!.id;
    assert.strictEqual(made, 'tightwad');
    const history = (await page('GET', `/advisor-setups?advisor=${made}`)).body as { setup: SetupConversation };
    assert.strictEqual(history.setup.id, id);
    assert.strictEqual(history.setup.status, 'accepted');
    const advisors = (await page('GET', '/advisors')).body as { advisors: Array<{ id: string; model?: string }> };
    assert.strictEqual(advisors.advisors.find((a) => a.id === made)?.model, 'big', "its page shows the model that wrote it");
  });

  test('the form fallback still adds an advisor with the browser key, filled in from a proposal', async () => {
    const form = (await page('GET', '/advisor-form')).body as { models: Array<{ id: string }> };
    assert.deepStrictEqual(form.models.map((m) => m.id), ['small', 'big']);
    const r = await page('POST', '/advisors', { name: 'Tightwad Two', status: 'Spending fewer tokens per change', goal: 'fewer-tokens', measures: ['cache_hit_rate'], rules: [], maxPerHour: 1, period: 'weekly', model: 'big', color: 'teal', icon: 'coin', voice: '' });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual((await page('GET', '/advisor-setups?advisor=tightwad-two')).status, 404, 'a form-made advisor has no setup conversation');
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
  await core.stop({ final: true }).catch(() => undefined);
  model.close();
  console.log(`\n${tests.length - failures}/${tests.length} passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
