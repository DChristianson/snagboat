import * as assert from 'assert';
import { EXCERPT_MAX_CHARS, makeExcerpt } from '../../core/excerpt';
import { normalizeTranscriptLine } from '../../adapters/claude-code/normalize';
import { normalizeOtlpTraces } from '../../adapters/copilot/normalize';
import { findHedges, verbalHedgeHeuristic } from '../../heuristics/verbalHedge';
import { ReadonlyEventStore } from '../../core/eventStore';
import { NormalizedEvent } from '../../core/types';

// Real transcript assistant lines carry message.content as an array of blocks;
// only `text` blocks are the agent's reply.
function transcriptLine(content: unknown): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: 'line-1',
    sessionId: 'session-123',
    timestamp: '2026-09-17T10:00:00.000Z',
    message: { model: 'claude-sonnet-5', content, usage: { input_tokens: 2, output_tokens: 10 } },
  });
}

// Shape per the OpenTelemetry GenAI output-messages schema's own reference case
// (semantic-conventions-genai: output-messages-assistant-text.yaml).
function invokeAgentPayload(outputMessages: unknown): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'session.id', value: { stringValue: 'sess-1' } }] },
        scopeSpans: [
          {
            spans: [
              {
                spanId: 'agent1',
                name: 'invoke_agent',
                attributes: [
                  { key: 'gen_ai.usage.input_tokens', value: { intValue: '200' } },
                  { key: 'gen_ai.output.messages', value: { stringValue: JSON.stringify(outputMessages) } },
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

function turn(eventId: string, sessionId: string, textExcerpt: string | undefined): NormalizedEvent {
  return { eventId, sessionId, agent: 'claude-code', ts: '2026-01-01T00:05:00.000Z', kind: 'turn_stop', status: 'unknown', textExcerpt, raw: { adapter: 'test', ref: 'n/a' } };
}

function toolCall(eventId: string, sessionId: string, target: string, status: NormalizedEvent['status'] = 'success'): NormalizedEvent {
  return { eventId, sessionId, agent: 'claude-code', ts: '2026-01-01T00:05:00.000Z', kind: 'tool_call', target, status, raw: { adapter: 'test', ref: 'n/a' } };
}

function storeOf(events: NormalizedEvent[]): ReadonlyEventStore {
  return {
    query: () => events,
    lastN: () => events,
    latestTs: () => undefined,
    cumulativeTokens: () => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }),
  };
}

const evaluate = (events: NormalizedEvent[], settings: Record<string, unknown> = {}) =>
  verbalHedgeHeuristic.evaluate({ now: '2026-01-01T00:10:00.000Z', store: storeOf(events), settings });

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('makeExcerpt joins non-blank fragments and truncates with an ellipsis', () => {
    assert.strictEqual(makeExcerpt([' first ', undefined, '', 'second']), 'first\n\nsecond');
    assert.strictEqual(makeExcerpt([undefined, '   ']), undefined);
    const long = makeExcerpt(['x'.repeat(EXCERPT_MAX_CHARS + 50)])!;
    assert.strictEqual(long.length, EXCERPT_MAX_CHARS);
    assert.ok(long.endsWith('…'));
  });

  test('makeExcerpt never splits a surrogate pair at the cut', () => {
    const text = 'x'.repeat(EXCERPT_MAX_CHARS - 2) + '\u{1F600}' + 'tail';
    const excerpt = makeExcerpt([text])!;
    assert.ok(!/[\uD800-\uDBFF]…$/.test(excerpt), 'no lone high surrogate before the ellipsis');
  });

  test('transcript: text blocks become textExcerpt only when capture is on', () => {
    const line = transcriptLine([
      { type: 'thinking', thinking: 'private reasoning' },
      { type: 'text', text: 'Actually, let me try a different fix.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
    ]);
    assert.strictEqual(normalizeTranscriptLine(line, 'f', 0)?.textExcerpt, undefined, 'off by default');
    assert.strictEqual(normalizeTranscriptLine(line, 'f', 0, { captureContent: false })?.textExcerpt, undefined);
    assert.strictEqual(normalizeTranscriptLine(line, 'f', 0, { captureContent: true })?.textExcerpt, 'Actually, let me try a different fix.');
  });

  test('transcript: lines with only thinking/tool_use blocks carry no excerpt', () => {
    const line = transcriptLine([{ type: 'tool_use', name: 'Read', input: { file_path: '/a' } }]);
    const event = normalizeTranscriptLine(line, 'f', 0, { captureContent: true });
    assert.ok(event, 'still a token-bearing turn_stop');
    assert.strictEqual(event!.textExcerpt, undefined);
  });

  test('copilot: assistant text parts of gen_ai.output.messages become textExcerpt only when capture is on', () => {
    const payload = invokeAgentPayload([
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', content: 'private reasoning' },
          { type: 'text', content: 'I think this should work now.' },
        ],
        finish_reason: 'stop',
      },
    ]);
    assert.strictEqual(normalizeOtlpTraces(payload)[0].textExcerpt, undefined, 'off by default');
    assert.strictEqual(normalizeOtlpTraces(payload, { captureContent: true })[0].textExcerpt, 'I think this should work now.');
  });

  test('copilot: malformed or non-assistant output messages are ignored without dropping the event', () => {
    const notJson = invokeAgentPayload('placeholder');
    // Overwrite the attribute with a non-JSON string.
    (notJson as any).resourceSpans[0].scopeSpans[0].spans[0].attributes[1].value.stringValue = 'not json{';
    const events = normalizeOtlpTraces(notJson, { captureContent: true });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].textExcerpt, undefined);

    const userOnly = normalizeOtlpTraces(invokeAgentPayload([{ role: 'user', parts: [{ type: 'text', content: 'my prompt' }] }]), { captureContent: true });
    assert.strictEqual(userOnly[0].textExcerpt, undefined, 'never captures user messages');
  });

  test('findHedges matches hedges and self-corrections but not ordinary prose', () => {
    assert.deepStrictEqual(findHedges('Actually, I think that should work.'), ['I think', 'should work', 'actually,']);
    assert.deepStrictEqual(findHedges("My mistake, that didn't work. Let me try again."), ['let me try', 'try again', 'my mistake', "that didn't work"]);
    assert.deepStrictEqual(findHedges('I updated the parser and all tests pass.'), []);
    assert.deepStrictEqual(findHedges('This is actually the main entry point.'), [], 'bare "actually" is not a self-correction');
  });

  test('verbal-hedge is silent without excerpts (capture off)', () => {
    assert.deepStrictEqual(evaluate([turn('a', 's1', undefined), turn('b', 's1', undefined)]), []);
  });

  test('verbal-hedge needs minTurns hedged replies in one session', () => {
    assert.deepStrictEqual(evaluate([turn('a', 's1', 'I think so.'), turn('b', 's2', 'Sorry about that.')]), [], 'one per session is not enough');
    const findings = evaluate([turn('a', 's1', 'I think so.'), turn('b', 's1', 'Sorry, let me try again.'), turn('c', 's1', 'Done.')]);
    assert.strictEqual(findings.length, 1);
    assert.deepStrictEqual(findings[0].eventRefs, ['a', 'b']);
    assert.strictEqual(evaluate([turn('a', 's1', 'I think so.'), turn('b', 's1', 'Sorry.')], { minTurns: 3 }).length, 0);
  });

  test('verbal-hedge stays info alone and escalates to warn only with a behavioral signal in the same session', () => {
    const hedged = [turn('a', 's1', 'I think so.'), turn('b', 's1', 'Sorry, let me try again.')];
    assert.strictEqual(evaluate(hedged)[0].severity, 'info');

    const looping = [toolCall('t1', 's1', 'a.ts'), toolCall('t2', 's1', 'a.ts'), toolCall('t3', 's1', 'a.ts')];
    assert.strictEqual(evaluate([...hedged, ...looping])[0].severity, 'warn', 'repeated target');
    assert.strictEqual(evaluate([...hedged, toolCall('t4', 's1', 'npm test', 'failure')])[0].severity, 'warn', 'failed tool call');
    assert.strictEqual(
      evaluate([...hedged, toolCall('t5', 's2', 'npm test', 'failure')])[0].severity,
      'info',
      "another session's failure does not escalate this one"
    );
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
