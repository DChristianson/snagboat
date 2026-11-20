import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readApprovals } from '../../core/advisorApprovals';
import { saveConfig } from '../../core/config';
import { CoreAdvisors } from '../../core/service/advisorModels';
import { FetchLike } from '../../advisor/providers';

// One request waits for your approval at a time (snagboat-79f.7.20). Another that needs the same approval
// waits behind it rather than failing: one Send lets both go; Don't send drops the first, and the next one
// then asks for itself. (Ask for a report now on a new advisor also answers its overdue scheduled report.)

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  const asked: string[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const messages = JSON.parse(String(init.body)).messages as Array<{ content: string }>;
    asked.push(messages[messages.length - 1].content);
    const body = { choices: [{ message: { role: 'assistant', content: '{"summary":"ok"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const fresh = () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-approval-queue-')));
    saveConfig(home, { version: 1, defaults: { advisors: [{ id: 'local', label: 'Local', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' }] }, projects: {} });
    return { home, models: new CoreAdvisors(home, fetchImpl) };
  };
  const ask = (models: CoreAdvisors, text: string) => models.ask('propose-heuristics', async () => [{ role: 'user', content: text }], { advisorId: 'local' });
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 100; i++) {
      if (ok()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`never: ${what}`);
  };

  test('two requests while one waits: one approval shown, and one Send lets both go', async () => {
    asked.length = 0;
    const { home, models } = fresh();
    const first = ask(models, 'scheduled report');
    const second = ask(models, 'asked report');
    await until(() => !!models.pendingApproval(), 'approval shown');
    const shown = models.pendingApproval()!;
    assert.match(shown.payload, /scheduled report/);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(models.pendingApproval()!.id, shown.id, 'the second waits behind it, not with an approval of its own');
    assert.ok(models.decide(shown.id, true));
    const [a, b] = await Promise.all([first, second]);
    assert.ok(a && b, 'both answered');
    assert.deepStrictEqual(asked.sort(), ['asked report', 'scheduled report']);
    assert.ok(readApprovals(home).local, 'approved once');
    assert.strictEqual(models.pendingApproval(), undefined);
  });

  test("Don't send drops the first; the one behind it then asks for itself", async () => {
    asked.length = 0;
    const { models } = fresh();
    const first = ask(models, 'scheduled report');
    const second = ask(models, 'asked report');
    await until(() => !!models.pendingApproval(), 'approval shown');
    const one = models.pendingApproval()!;
    assert.ok(models.decide(one.id, false));
    assert.strictEqual(await first, undefined, 'not sent');
    await until(() => !!models.pendingApproval() && models.pendingApproval()!.id !== one.id, 'its own approval');
    assert.match(models.pendingApproval()!.payload, /asked report/);
    assert.ok(models.decide(models.pendingApproval()!.id, true));
    assert.ok(await second);
    assert.deepStrictEqual(asked, ['asked report']);
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
