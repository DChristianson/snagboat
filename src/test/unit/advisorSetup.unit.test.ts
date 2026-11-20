import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { SetupConversation } from '@snagboat/schema';
import { checkNewAdvisor } from '../../advisor/newAdvisor';
import { parseSetupAnswer, SetupCatalog, setupMessages } from '../../advisor/setupConversation';
import { readApprovals } from '../../core/advisorApprovals';
import { saveConfig } from '../../core/config';
import { coreRequest, readCoreFile } from '../../core/service/coreFile';
import { CoreService } from '../../core/service/server';

// Setting up an advisor by conversation, in the core (snagboat-79f.7.15): a stub local model over HTTP
// asks a question, then proposes an advisor; you switch models, revise with a note, accept (persona.md,
// with the answering model as its model, and the conversation moved to the advisor's folder), or discard.

type Approval = { id: string; advisor: string; model: string; ability?: string; payload: string };
type View = { setup: SetupConversation; ask?: { state: string; error?: string; approval?: Approval }; models: Array<{ id: string }>; advisor?: { id: string; name: string } };

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  // A local model shaped like Ollama's OpenAI-compatible API. Until you say "propose" it asks a question;
  // then it proposes an advisor from the measures it was sent (plus one that doesn't exist), and answers a
  // revise note with a new status line.
  const asked: Array<{ model: string; messages: Array<{ role: string; content: string }>; response_format?: unknown }> = [];
  const model = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const request = JSON.parse(body) as (typeof asked)[number];
      asked.push(request);
      const users = request.messages.filter((m) => m.role === 'user');
      const last = users[users.length - 1]?.content ?? '';
      const catalog = JSON.parse(request.messages[0].content.split('What you may choose from:\n')[1]) as { measures: Array<{ id: string }>; rules: Array<{ id: string }> };
      let answer: unknown;
      if (/^\(From Snagboat, not the person\.\) Your proposal couldn't be used/.test(last)) {
        // The repair: it picks from the lists it was given again, and a name not taken.
        answer = { reply: 'Fixed: Context Watch speaks for context-pressure.', proposal: { name: 'Context Watch', status: 'Know before a session compacts', goal: 'context-headroom', measures: ['useful_share'], rules: ['context-pressure'], maxPerHour: 2, period: 'weekly', color: 'blue', icon: 'compass', voice: 'You watch the context window.' } };
      } else if (/rules and objectives/.test(last)) {
        // llama3.1's answer on 2026-11-19: an invented measure (none left once it's dropped) and a built-in's name.
        answer = { reply: "Based on what you've told me, I propose the 'Navigator' advisor. Here's the proposal:", proposal: { name: 'Navigator', status: 'Notify halfway to compaction', goal: 'compaction-halfway', measures: ['compaction-progress'], rules: [], maxPerHour: 2, period: 'weekly', voice: 'You watch the context.' } };
      } else if (/note on your last proposal/.test(last)) {
        answer = { reply: 'Revised: it watches the cache too.', proposal: { name: 'Cache Keeper', status: 'Keeping the cache warm and cost down', goal: 'cache-warm', measures: [catalog.measures[0].id, catalog.measures[1].id], rules: [catalog.rules[0].id], maxPerHour: 1, period: 'daily', color: 'teal', icon: 'anchor', voice: 'You watch the cache.' } };
      } else if (/propose/i.test(last)) {
        answer = { reply: 'I propose Cache Keeper.', proposal: { name: 'Cache Keeper', status: 'Keeping token cost down', goal: 'token-cost-down', measures: [catalog.measures[0].id, 'made_up_measure'], rules: [], maxPerHour: 2, period: 'weekly', color: 'amber', icon: 'coin', voice: 'You watch what the work costs.' } };
      } else {
        answer = { reply: `What matters most to you? (${request.model})`, proposal: null };
      }
      const content = JSON.stringify(answer);
      // Streamed, as the core asks for.
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;

  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-setup-')));
  saveConfig(home, {
    version: 1,
    defaults: {
      advisors: [
        { id: 'local', label: 'Model A', baseUrl: base, model: 'model-a' },
        { id: 'other', label: 'Model B', baseUrl: base, model: 'model-b' },
        { id: 'no-setup', label: 'Not for setup', baseUrl: base, model: 'model-c', abilities: { 'summarize-session': true } },
        { id: 'cloud', label: 'Hosted', baseUrl: 'https://api.example.com/v1', model: 'm' },
      ],
    },
    projects: {},
  });
  const core = await CoreService.start({ home, version: 'test', idleMs: 0, collect: false, periodEveryMs: 0 });
  const info = readCoreFile(home)!;
  const call = (method: string, p: string, body?: unknown) => coreRequest(core.port, info.token, method, p, body, 30_000);
  const view = async (id: string) => (await call('GET', `/advisor-setups/${id}`)).body as View;
  const until = async (id: string, ok: (v: View) => boolean, what: string): Promise<View> => {
    for (let i = 0; i < 200; i++) {
      const v = await view(id);
      if (ok(v)) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`never: ${what}`);
  };
  /** Waits for the model's answer, approving the request when it waits for that. */
  const answered = async (id: string, turns: number): Promise<View> =>
    until(
      id,
      (v) => {
        if (v.ask?.approval) void call('POST', `/advisor-setups/${id}/approval`, { id: v.ask.approval.id, send: true });
        return v.setup.turns.length >= turns && !v.ask;
      },
      `${turns} turns`
    );

  let setupId = '';

  test('no model, an unknown one, or one not offering setup: refused', async () => {
    assert.strictEqual((await call('POST', '/advisor-setups', { text: 'hello' })).status, 400);
    for (const m of ['nope', 'no-setup', 'cloud']) {
      const r = await call('POST', '/advisor-setups', { model: m });
      assert.strictEqual(r.status, 400, m);
      assert.match((r.body as { error: string }).error, /no local model advisor/);
    }
    const list = (await call('GET', '/advisor-setups')).body as { drafts: unknown[]; models: Array<{ id: string }> };
    assert.deepStrictEqual(list.models.map((m) => m.id), ['local', 'other'], 'local ones offering the ability only');
    assert.deepStrictEqual(list.drafts, [], 'nothing was started');
  });

  test('a workspace token cannot use setup conversations', async () => {
    const minted = (await call('POST', '/tokens', { workspaces: [path.join(home, 'w')] })).body as { token: string };
    const r = await coreRequest(core.port, minted.token, 'GET', '/advisor-setups');
    assert.strictEqual(r.status, 403);
  });

  test('your first turn waits for approval under the setup ability, then the model answers', async () => {
    const r = await call('POST', '/advisor-setups', { model: 'local', text: 'I want to spend less on tokens.' });
    assert.strictEqual(r.status, 201);
    const started = r.body as View;
    setupId = started.setup.id;
    assert.match(setupId, /^s-\d{8}-[0-9a-f]{6}$/);
    assert.strictEqual(started.ask?.state, 'asking');
    const waiting = await until(setupId, (v) => !!v.ask?.approval, 'approval shown');
    assert.match(waiting.ask!.approval!.ability ?? '', /Set up an advisor/);
    assert.match(waiting.ask!.approval!.payload, /I want to spend less on tokens/);
    assert.strictEqual(asked.length, 0, 'nothing sent before you approve');
    const v = await answered(setupId, 2);
    assert.deepStrictEqual(v.setup.turns.map((t) => t.from), ['you', 'model']);
    assert.deepStrictEqual(v.setup.turns[1].model, { advisor: 'local', model: 'model-a' });
    assert.match(v.setup.turns[1].text, /What matters most/);
    assert.ok(!v.setup.proposal);
    const approvals = readApprovals(home);
    assert.ok(approvals['local#set-up-advisor'], 'its own approval');
    assert.ok(!approvals.local, "the advisor's other abilities are not approved by it");
    // Only what you typed and Snagboat's lists are sent: one system message, then the conversation.
    const sent = asked[0];
    assert.deepStrictEqual(sent.messages.map((m) => m.role), ['system', 'user']);
    assert.strictEqual(sent.messages[1].content, 'I want to spend less on tokens.');
    assert.deepStrictEqual(sent.response_format, { type: 'json_object' });
  });

  test('switching models mid-conversation is recorded per turn, and the proposal passes the + form checks', async () => {
    assert.strictEqual((await call('POST', `/advisor-setups/${setupId}/messages`, { text: 'Per milestone. Please propose one.', model: 'nope' })).status, 400, 'an unknown model is refused');
    const r = await call('POST', `/advisor-setups/${setupId}/messages`, { text: 'Per milestone. Please propose one.', model: 'other' });
    assert.strictEqual(r.status, 202);
    assert.strictEqual((await call('POST', `/advisor-setups/${setupId}/messages`, { text: 'again' })).status, 409, 'one turn at a time');
    const v = await answered(setupId, 4);
    assert.deepStrictEqual(v.setup.turns[2].model, { advisor: 'other', model: 'model-b' }, 'your turn records the switch');
    assert.deepStrictEqual(v.setup.turns[3].model, { advisor: 'other', model: 'model-b' }, 'the answer records the model that gave it');
    assert.deepStrictEqual(v.setup.model, { advisor: 'other', model: 'model-b' });
    assert.strictEqual(asked[asked.length - 1].model, 'model-b');
    assert.ok(asked[asked.length - 1].messages.some((m) => m.role === 'assistant' && /What matters most/.test(m.content)), 'the earlier answer is in the conversation sent');
    const p = v.setup.proposal!;
    assert.strictEqual(p.turn, 3);
    assert.strictEqual(p.spec.model, 'other', 'the model that wrote it');
    assert.ok(!p.spec.measures.includes('made_up_measure'));
    assert.ok(v.setup.turns[3].problems?.some((x) => /made_up_measure/.test(x)));
    const rules = (await call('GET', '/advisor-form')).body as { rules: Array<{ id: string }> };
    const checked = checkNewAdvisor(p.spec, rules.rules.map((x) => x.id), ['local', 'other']);
    assert.deepStrictEqual(checked.problems, []);
  });

  test('revise with a note continues the conversation and answers with a new proposal', async () => {
    assert.strictEqual((await call('POST', `/advisor-setups/${setupId}/proposal`, { action: 'revise' })).status, 400, 'a note is needed');
    const r = await call('POST', `/advisor-setups/${setupId}/proposal`, { action: 'revise', note: 'Watch the cache too, and report daily.' });
    assert.strictEqual(r.status, 202);
    const v = await answered(setupId, 6);
    assert.deepStrictEqual(v.setup.turns[4], { ...v.setup.turns[4], from: 'you', revise: true, text: 'Watch the cache too, and report daily.' });
    assert.strictEqual(v.setup.proposal!.turn, 5);
    assert.strictEqual(v.setup.proposal!.spec.period, 'daily');
    assert.strictEqual(v.setup.proposal!.spec.status, 'Keeping the cache warm and cost down');
    assert.strictEqual(v.setup.status, 'open');
  });

  test('accept writes persona.md with the answering model and moves the conversation to the advisor', async () => {
    assert.strictEqual((await call('POST', `/advisor-setups/${setupId}/proposal`, { action: 'accept', turn: 3 })).status, 409, 'not the latest proposal');
    const r = await call('POST', `/advisor-setups/${setupId}/proposal`, { action: 'accept', turn: 5 });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const v = r.body as View;
    assert.deepStrictEqual(v.advisor, { id: 'cache-keeper', name: 'Cache Keeper' });
    assert.strictEqual(v.setup.status, 'accepted');
    assert.strictEqual(v.setup.advisor, 'cache-keeper');
    const persona = fs.readFileSync(path.join(home, 'advisors', 'cache-keeper', 'persona.md'), 'utf8');
    assert.match(persona, /^model: other$/m);
    assert.match(persona, /^period: daily$/m);
    assert.match(persona, /^goal: cache-warm$/m);
    assert.ok(fs.existsSync(path.join(home, 'advisors', 'cache-keeper', 'setup.jsonl')));
    assert.ok(!fs.existsSync(path.join(home, 'advisor-drafts', setupId)), 'no longer a draft');
    const lines = fs.readFileSync(path.join(home, 'advisors', 'cache-keeper', 'setup.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string });
    assert.deepStrictEqual(lines.map((l) => l.type), ['started', 'said', 'answered', 'said', 'answered', 'revised', 'answered', 'accepted']);
    assert.strictEqual((await view(setupId)).setup.status, 'accepted', 'still found by its id');
    const byAdvisor = (await call('GET', '/advisor-setups?advisor=cache-keeper')).body as { setup: SetupConversation };
    assert.strictEqual(byAdvisor.setup.id, setupId);
    assert.strictEqual((await call('GET', '/advisor-setups?advisor=purser')).status, 404, 'a built-in has none');
    const advisors = (await call('GET', '/advisors')).body as { advisors: Array<{ id: string }> };
    assert.ok(advisors.advisors.some((a) => a.id === 'cache-keeper'), 'the new advisor is listed');
    assert.strictEqual((await call('POST', `/advisor-setups/${setupId}/messages`, { text: 'more' })).status, 409, 'an accepted conversation is closed');
  });

  test('discard keeps the draft and its record', async () => {
    const v = (await call('POST', '/advisor-setups', { model: 'local' })).body as View;
    assert.ok(!v.ask, 'nothing asked without a first turn');
    assert.strictEqual((await call('POST', `/advisor-setups/${v.setup.id}/proposal`, { action: 'accept' })).status, 409, 'nothing to accept yet');
    const r = await call('POST', `/advisor-setups/${v.setup.id}/proposal`, { action: 'discard' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((r.body as View).setup.status, 'discarded');
    const file = path.join(home, 'advisor-drafts', v.setup.id, 'setup.jsonl');
    assert.deepStrictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { type: string }).type), ['started', 'discarded']);
    const list = (await call('GET', '/advisor-setups')).body as { drafts: SetupConversation[] };
    assert.deepStrictEqual(list.drafts.map((d) => [d.id, d.status]), [[v.setup.id, 'discarded']]);
    assert.strictEqual((await call('POST', `/advisor-setups/${v.setup.id}/messages`, { text: 'hi' })).status, 409);
    assert.strictEqual((await call('GET', '/advisor-setups/../../etc')).status, 404);
    assert.strictEqual((await call('GET', '/advisor-setups/s-20260101-zzzzzz')).status, 404);
  });

  test("a proposal that fails the checks goes straight back to the model once, with the lists, and you see the fixed one", async () => {
    const v = (await call('POST', '/advisor-setups', { model: 'local' })).body as View;
    const before = asked.length;
    assert.strictEqual((await call('POST', `/advisor-setups/${v.setup.id}/messages`, { text: 'could you propose the rules and objectives for that' })).status, 202);
    const after = await answered(v.setup.id, 3);
    assert.deepStrictEqual(after.setup.turns.map((t) => t.from), ['you', 'model', 'model'], 'one turn of yours, answered twice');
    assert.ok(!after.setup.turns[1].proposal);
    assert.ok(after.setup.turns[1].problems!.some((x) => /compaction-progress/.test(x)), after.setup.turns[1].problems!.join(" | "));
    assert.strictEqual(after.setup.proposal!.turn, 2);
    assert.deepStrictEqual(after.setup.proposal!.spec.rules, ['context-pressure']);
    assert.strictEqual(asked.length - before, 2, 'asked once more, not again and again');
    const repair = asked[asked.length - 1].messages[asked[asked.length - 1].messages.length - 1].content;
    assert.match(repair, /measures must come from exactly these ids: .*useful_share/);
    assert.match(repair, /must not be any of: .*navigator/);
    const sent = JSON.parse(asked[asked.length - 1].messages[0].content.split('What you may choose from:\n')[1]) as { rules: Array<{ id: string; title?: string }> };
    assert.match(sent.rules.find((r) => r.id === 'context-pressure')!.title!, /compacted/, 'built-in rules go with what they report');
    await call('POST', `/advisor-setups/${v.setup.id}/proposal`, { action: 'discard' });
  });

  const catalog: SetupCatalog = { measures: [{ id: 'cache_hit_rate', label: 'cache hit rate', unit: '%' }], rules: [{ id: 'cache-thrash' }], taken: ['purser'] };

  test("an answer that isn't JSON is kept as a reply; a proposal that fails the checks is kept out, with reasons", () => {
    assert.deepStrictEqual(parseSetupAnswer('Tell me more.', catalog, 'local', ['local']), { reply: 'Tell me more.', problems: ['the answer was not the JSON asked for; kept as a reply'] });
    const fenced = parseSetupAnswer('```json\n{"reply": "Here.", "proposal": {"name": "Purser", "status": "Cost", "goal": "cost", "measures": ["cache_hit_rate"], "rules": []}}\n```', catalog, 'local', ['local']);
    assert.ok(!fenced.proposal);
    assert.ok(fenced.problems.some((p) => /purser already exists/.test(p)), fenced.problems.join(' | '));
    const ok = parseSetupAnswer('{"reply": "", "proposal": {"name": "Saver", "status": "Cost", "goal": "cost", "measures": ["cache_hit_rate"], "rules": ["cache-thrash", "nope"]}}', catalog, 'local', ['local']);
    assert.deepStrictEqual(ok.proposal, { name: 'Saver', status: 'Cost', goal: 'cost', measures: ['cache_hit_rate'], rules: ['cache-thrash'], maxPerHour: 2, period: 'weekly', model: 'local', color: 'blue', icon: 'compass', voice: '' });
    assert.match(ok.reply, /I propose Saver/);
    const none = parseSetupAnswer('{"reply": "Hi", "proposal": {"name": "Saver", "status": "Cost", "goal": "cost", "measures": []}}', catalog, 'local', ['local']);
    assert.ok(!none.proposal && none.problems.includes('Pick at least one measure.'));
  });

  test('a turn whose proposal was kept out is followed by why, so the next answer can fix it', () => {
    const at = '2026-11-18T09:00:00.000Z';
    const messages = setupMessages(
      [
        { at, from: 'you', text: 'Hi' },
        { at, from: 'model', text: 'Bad one.', problems: ['Pick at least one measure.'] },
        { at, from: 'you', text: '', model: { advisor: 'other' } },
      ],
      catalog
    );
    assert.deepStrictEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
    assert.match(messages[3].content, /From Snagboat, not the person.*Pick at least one measure.*exactly these ids: cache_hit_rate/);
    assert.match(messages[0].content, /"taken":\["purser"\]/);
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
