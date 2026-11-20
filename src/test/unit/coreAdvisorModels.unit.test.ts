import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { approvalKeyBefore7_12, parseAdvisors } from '../../advisor/advisors';
import { readApprovals, writeApprovals } from '../../core/advisorApprovals';
import { saveConfig } from '../../core/config';
import { CoreAdvisors } from '../../core/service/advisorModels';
import { FetchLike } from '../../advisor/providers';

// Model advisors in the core (RFC step 5c-2b): the core asks only local models, from your user settings;
// the first request waits for you to approve its exact payload; approvals are kept in
// advisor-approvals.json, shared with VS Code. (Until snagboat-79f.7.12 the Suggestions page's Ask the
// advisor exercised this; now the performance report and setting up an advisor do.)

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  const asked: Array<{ url: string; model?: string }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.endsWith('/models')) {
      const body = { data: [{ id: 'tiny-model' }] };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }
    asked.push({ url, model: JSON.parse(String(init.body)).model });
    const body = { choices: [{ message: { role: 'assistant', content: '{"summary":"ok"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const providers = [
    { id: 'local', label: 'Test model', baseUrl: 'http://127.0.0.1:9/v1', model: '' },
    { id: 'cloud', label: 'Hosted', baseUrl: 'https://api.example.com/v1', model: 'm' },
  ];
  const fresh = () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-advise-')));
    saveConfig(home, { version: 1, defaults: { 'advisor.providers': providers }, projects: { [path.join(home, 'proj')]: { 'advisor.providers': [{ id: 'sneaky', label: 'Project', baseUrl: 'http://127.0.0.1:8/v1', model: 'm' }] } } });
    return { home, models: new CoreAdvisors(home, fetchImpl) };
  };
  const ask = (models: CoreAdvisors, advisorId?: string) => models.ask('report-on-goal', async () => [{ role: 'user', content: 'Write this period\'s report.' }], advisorId ? { advisorId } : {});
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 100; i++) {
      if (ok()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`never: ${what}`);
  };

  test("only local advisors from your user settings are offered: not hosted ones, not a project's", () => {
    const { models } = fresh();
    assert.deepStrictEqual(models.choices('report-on-goal').map((a) => a.id), ['local']);
  });

  test("the first request waits for your approval with its exact payload; Don't send sends nothing; Send keeps the approval", async () => {
    asked.length = 0;
    const { home, models } = fresh();
    const first = ask(models);
    await until(() => !!models.pendingApproval(), 'approval waiting');
    const a = models.pendingApproval()!;
    assert.deepStrictEqual([a.advisor, a.model, a.ability], ['Test model', 'tiny-model', "Report on a goal (a goal advisor's performance report)"], 'the model from the server, as none was set');
    assert.match(a.payload, /"model": "tiny-model"/);
    assert.ok(models.decide(a.id, false));
    assert.strictEqual(await first, undefined);
    assert.strictEqual(asked.length, 0, 'nothing sent');
    assert.deepStrictEqual(readApprovals(home), {});
    assert.ok(!models.decide(a.id, true), 'that request is gone');

    const second = ask(models);
    await until(() => !!models.pendingApproval(), 'approval waiting again');
    models.decide(models.pendingApproval()!.id, true);
    assert.ok(await second);
    assert.strictEqual(asked.length, 1);
    assert.ok(readApprovals(home).local, 'approval kept');
    assert.ok(await ask(models), 'approved once, the next request goes straight out');
    assert.strictEqual(asked.length, 2);
  });

  test('an approval given before snagboat-79f.7.12 retired abilities still counts', async () => {
    asked.length = 0;
    const { home, models } = fresh();
    const local = parseAdvisors(undefined, providers).advisors.find((x) => x.id === 'local')!;
    writeApprovals(home, { local: approvalKeyBefore7_12(local)! });
    assert.ok(await ask(models), 'sent without asking');
    assert.strictEqual(models.pendingApproval(), undefined);
    assert.strictEqual(asked.length, 1);
  });

  test('a hosted or unknown advisor is refused, in plain words', async () => {
    const { models } = fresh();
    await assert.rejects(ask(models, 'cloud'), /no local advisor "cloud"/);
    await assert.rejects(ask(models, 'sneaky'), /no local advisor "sneaky"/);
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
