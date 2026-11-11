import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadAdvisorGoals } from '../../advisor/goals';
import { advisorId, checkNewAdvisor, personaText, writeNewAdvisor } from '../../advisor/newAdvisor';
import { coreRequest, readCoreFile } from '../../core/service/coreFile';
import { CoreService } from '../../core/service/server';

// Adding an advisor from the advisor UI's + (RFC step 5c): the form is checked, written as a
// new persona.md that reads back as the advisor it describes, and never overwrites one.

const form = {
  name: 'Quartermaster',
  status: 'Keeping "retries" rare: #1 priority',
  goal: 'fewer-retries',
  measures: ['minutes_to_green', 'stall_minutes'],
  rules: ['stalled'],
  maxPerHour: 1,
  color: 'teal',
  icon: 'anchor',
  voice: 'You watch retries.\n\nSay which turn.',
};
const rules = ['stalled', 'tool-churn'];

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('a name becomes a folder id', () => {
    assert.strictEqual(advisorId('Quarter Master!'), 'quarter-master');
    assert.strictEqual(advisorId('  42 Ledger '), 'ledger');
    assert.strictEqual(advisorId('Ünïcode Söul'), 'unicode-soul');
  });

  test('the form is checked, in plain words', () => {
    assert.deepStrictEqual(checkNewAdvisor(form, rules).problems, []);
    const bad = checkNewAdvisor({ ...form, name: '', goal: 'Fewer Retries', measures: ['nope'], rules: ['x'], maxPerHour: 99, color: 'pink', voice: 'a\n---\nb' }, rules).problems;
    for (const re of [/name/, /goal is an id/, /No such measure: nope/, /No such heuristic or rule: x/, /0 to 20/, /color/, /---/]) assert.ok(bad.some((p) => re.test(p)), `${re} in ${bad.join(' | ')}`);
    assert.ok(checkNewAdvisor(null, rules).problems.length > 0);
  });

  test('persona.md reads back as the advisor the form describes, quotes and # included', () => {
    const spec = checkNewAdvisor(form, rules).spec!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-add-'));
    const written = writeNewAdvisor(dir, spec);
    const { advisors, problems } = loadAdvisorGoals(dir);
    assert.deepStrictEqual(problems, []);
    const a = advisors.find((x) => x.id === 'quartermaster')!;
    assert.ok(a, 'loaded beside the built-ins');
    assert.strictEqual(advisors.length, 5);
    assert.deepStrictEqual([a.name, a.status, a.goal, a.measures, a.notify, [a.cue?.icon, a.cue?.color], a.voice], ['Quartermaster', 'Keeping "retries" rare: #1 priority', 'fewer-retries', form.measures, { rules: ['stalled'], maxPerHour: 1 }, ['anchor', 'teal'], form.voice]);
    assert.strictEqual(written.version, a.version);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(dir, 'quartermaster', 'persona.md')).mode & 0o777, 0o600);
    assert.throws(() => writeNewAdvisor(dir, spec), /already exists/);
    assert.throws(() => writeNewAdvisor(dir, { ...spec, name: 'Purser' }), /built-in/);
    assert.match(personaText({ ...spec, voice: '' }), /You watch this project for keeping "retries" rare/);
  });

  test('the core offers the choices and writes the advisor; any token may, a reader key included', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-add-core-')));
    const core = await CoreService.start({ home, version: 'test', idleMs: 0, collect: false });
    try {
      const info = readCoreFile(home)!;
      const choices = (await coreRequest(core.port, info.token, 'GET', '/advisor-form')).body as { measures: Array<{ id: string }>; rules: Array<{ id: string }>; templates: Array<{ from: string }> };
      assert.ok(choices.measures.some((m) => m.id === 'cache_hit_rate'));
      assert.ok(choices.rules.some((r) => r.id === 'stalled'));
      assert.deepStrictEqual(choices.templates.map((t) => t.from), ['purser', 'navigator', 'bosun', 'lookout']);
      // A browser's reader key, through a one-time link.
      const link = (await coreRequest(core.port, info.token, 'POST', '/ui-links', {})).body as { code: string };
      const reader = ((await coreRequest(core.port, '', 'POST', '/ui-session', { code: link.code })).body as { token: string }).token;
      const made = await coreRequest(core.port, reader, 'POST', '/advisors', form);
      assert.strictEqual(made.status, 201, JSON.stringify(made.body));
      assert.deepStrictEqual(made.body, { advisor: { id: 'quartermaster', name: 'Quartermaster' } });
      assert.ok(fs.existsSync(path.join(home, 'advisors', 'quartermaster', 'persona.md')));
      assert.strictEqual((await coreRequest(core.port, reader, 'POST', '/advisors', form)).status, 409, 'never overwritten');
      assert.strictEqual((await coreRequest(core.port, reader, 'POST', '/advisors', { ...form, name: 'Bosun' })).status, 409);
      const bad = await coreRequest(core.port, reader, 'POST', '/advisors', { ...form, name: 'Other', measures: [] });
      assert.strictEqual(bad.status, 400);
      assert.match((bad.body as { error: string }).error, /at least one measure/);
      const listed = (await coreRequest(core.port, info.token, 'GET', '/advisors')).body as { advisors: Array<{ id: string }> };
      assert.ok(listed.advisors.some((a) => a.id === 'quartermaster'), 'GET /advisors has it');
    } finally {
      await core.stop();
    }
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
