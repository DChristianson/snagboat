import * as assert from 'assert';
import * as vm from 'vm';
import { NormalizedEvent } from '@snagboat/schema';
import { syntheticEvents, syntheticSessionIds } from '../fixtures/synthetic';
import { buildTraceSet, flagText, reviewReport, scrubText, slimEvent, textLines, traceScript } from '../../scripts/demoTraces';

// The demo traces tool (src/scripts/demoTraces.ts). Its reviewed output is committed in the
// factory-clock repository, whose page reads window.factoryClockDemoTraces.

const at = (min: number) => new Date(Date.UTC(2026, 9, 22, 10, min)).toISOString();
let n = 0;
function e(partial: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'kind'>): NormalizedEvent {
  return { eventId: `e${n++}`, sessionId: 'S1', agent: 'claude-code', ts: at(0), status: 'unknown', raw: { adapter: 't', ref: 'n/a' }, ...partial };
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  // The demo traces tool, over synthetic events only: real traces never go in unit tests.
  test('a demo trace event keeps what the views read and drops targets and the raw reference', () => {
    const source = e({ kind: 'tool_call', target: '/Users/someone/project/src/secret.ts', toolName: 'Read', toolCategory: 'file-read', turnId: 't1', raw: { adapter: 'claude-code', ref: '/Users/someone/.claude/projects/x.jsonl:12', event: { any: 1 } } });
    const slim = slimEvent(source, 'S1-0', '/Users/someone');
    assert.strictEqual(slim.target, undefined);
    assert.deepStrictEqual(slim.raw, { adapter: 'demo', ref: 'trace' });
    assert.strictEqual(slim.eventId, 'S1-0');
    assert.strictEqual(slim.toolName, 'Read');
    assert.strictEqual(slim.turnId, 't1');
    assert.ok(!JSON.stringify(slim).includes('/Users/someone'));
  });

  test('demo trace text has the home folder replaced and secrets redacted again', () => {
    assert.strictEqual(scrubText('see /Users/someone/project/README.md', '/Users/someone'), 'see ~/project/README.md');
    assert.match(scrubText('key sk-ant-abcdefghijklmnopqrstuvwxyz', '/Users/someone'), /\[redacted Anthropic key\]/);
    const slim = slimEvent(e({ kind: 'user_prompt', promptText: 'open /Users/someone/x' }), 'a', '/Users/someone');
    assert.strictEqual(slim.promptText, 'open ~/x');
  });

  test('text worth a second look is flagged, and plain text is not', () => {
    assert.deepStrictEqual(flagText('Add the replay clock to the explorer.'), []);
    assert.ok(flagText('mail me at a.person@example.com').includes('email address'));
    assert.ok(flagText('see https://example.com/x').includes('URL'));
    assert.ok(flagText('it is in ~/notes/today.md').includes('absolute path'));
    assert.ok(flagText('rotate the API key').includes('secret word'));
    assert.ok(flagText('call 555-123-4567').includes('phone number'));
  });

  test('a trace set takes sessions by id prefix, in the order named, with ids renumbered', () => {
    const all = syntheticEvents();
    const [a, b] = syntheticSessionIds();
    const set = buildTraceSet(all, [b.slice(0, 6), a], '/nowhere');
    assert.deepStrictEqual(set.picked, [b, a]);
    assert.strictEqual(set.events.length, all.filter((x) => x.sessionId === a || x.sessionId === b).length);
    assert.strictEqual(new Set(set.events.map((x) => x.eventId)).size, set.events.length);
    assert.throws(() => buildTraceSet(all, ['no-such-session'], '/nowhere'), /matches 0 sessions/);
    assert.throws(() => buildTraceSet(all, [''], '/nowhere'), /matches \d+ sessions/);
  });

  test('the trace script loads in a page and sets the global Factory Clock reads', () => {
    const set = buildTraceSet(syntheticEvents(), syntheticSessionIds().slice(0, 2), '/nowhere');
    const sandbox = { window: {} as Record<string, unknown> };
    vm.runInNewContext(traceScript(set), sandbox);
    const read = JSON.parse(JSON.stringify(sandbox.window.factoryClockDemoTraces));
    assert.deepStrictEqual(read.picked, set.picked);
    assert.deepStrictEqual(read.events, set.events);
    assert.strictEqual(new Set(read.events.map((x: NormalizedEvent) => x.sessionId)).size, 2);
  });

  test('the review report lists every piece of text, flagged ones first', () => {
    const events = [
      e({ kind: 'session_name', sessionId: 'S1', sessionName: 'Demo session' }),
      e({ kind: 'user_prompt', sessionId: 'S1', turnId: 't', promptText: 'write to me at x@example.com' }),
      e({ kind: 'turn_stop', sessionId: 'S1', turnId: 't', textExcerpt: 'Done.' }),
    ];
    const set = buildTraceSet(events, ['S1'], '/nowhere');
    const lines = textLines(set);
    assert.strictEqual(lines.length, 3);
    const md = reviewReport(set, lines);
    assert.ok(md.indexOf('## Flagged') < md.indexOf('x@example.com'));
    assert.match(md, /3 pieces of text, 1 flagged/);
    assert.ok(md.includes('Done.'));
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
  if (failures > 0) process.exit(1);
}

main();
