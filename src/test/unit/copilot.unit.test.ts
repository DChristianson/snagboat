import * as assert from 'assert';
import { normalizeOtlpTraces } from '../../adapters/copilot/normalize';

// Hand-built per the OTLP/HTTP JSON wire format spec (a stable, documented
// protobuf-JSON mapping), with span/metric/attribute names doc-verified against
// Microsoft's monitoring guide and microsoft/vscode-copilot-chat's own
// agent_monitoring.md -- notably session.id lives on the RESOURCE, not per-span
// or per-datapoint, which is why it's nested under `resource.attributes` below
// rather than alongside each span's own attributes.

const TRACES_PAYLOAD = {
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
                { key: 'gen_ai.usage.output_tokens', value: { intValue: '80' } },
                { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o' } },
              ],
              status: { code: 1 },
            },
            {
              spanId: 'abc123',
              name: 'execute_tool',
              attributes: [{ key: 'gen_ai.tool.name', value: { stringValue: 'apply_patch' } }],
              status: { code: 1 },
            },
            {
              spanId: 'def456',
              name: 'execute_tool',
              attributes: [{ key: 'gen_ai.tool.name', value: { stringValue: 'run_tests' } }],
              status: { code: 2 },
            },
            {
              spanId: 'zzz999',
              name: 'chat',
              attributes: [],
            },
          ],
        },
      ],
    },
  ],
};

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('normalizeOtlpTraces maps invoke_agent spans to a turn_stop event carrying tokens directly', () => {
    const events = normalizeOtlpTraces(TRACES_PAYLOAD);
    const invokeAgentEvent = events.find((e) => e.raw.ref === 'otlp:span:agent1');
    assert.ok(invokeAgentEvent);
    assert.strictEqual(invokeAgentEvent!.kind, 'turn_stop');
    assert.deepStrictEqual(invokeAgentEvent!.tokens, { input: 200, output: 80 });
    assert.strictEqual(invokeAgentEvent!.model, 'gpt-4o');
    assert.strictEqual(invokeAgentEvent!.sessionId, 'sess-1', 'session.id must be read from the resource, not the span');
  });

  test('normalizeOtlpTraces maps execute_tool spans to tool_call events using gen_ai.tool.name', () => {
    const events = normalizeOtlpTraces(TRACES_PAYLOAD);
    const toolCalls = events.filter((e) => e.kind === 'tool_call');
    assert.strictEqual(toolCalls.length, 2, 'the unrelated "chat" span must be ignored');
    assert.strictEqual(toolCalls[0].target, 'apply_patch');
    assert.strictEqual(toolCalls[0].status, 'success');
    assert.strictEqual(toolCalls[0].sessionId, 'sess-1', 'resource-level session.id applies to every span in the resource');
    assert.strictEqual(toolCalls[1].status, 'failure');
  });

  test('normalizeOtlpTraces falls back to unknown-session when no resource session.id is present', () => {
    const events = normalizeOtlpTraces({
      resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'execute_tool', attributes: [] }] }] }],
    });
    assert.strictEqual(events[0].sessionId, 'unknown-session');
  });

  test('normalizeOtlpTraces returns an empty array for malformed/empty payloads', () => {
    assert.deepStrictEqual(normalizeOtlpTraces({}), []);
    assert.deepStrictEqual(normalizeOtlpTraces(null), []);
    assert.deepStrictEqual(normalizeOtlpTraces('not an object'), []);
  });

  test('chat <model> spans outside an agent turn become inline model calls with cache split out and the reported limit', () => {
    const events = normalizeOtlpTraces({
      resourceSpans: [{ resource: { attributes: [{ key: 'session.id', value: { stringValue: 'sess-1' } }] }, scopeSpans: [{ spans: [
        { spanId: 'n1', name: 'chat copilot-nes-x', attributes: [
          { key: 'gen_ai.usage.input_tokens', value: { intValue: '1640' } },
          { key: 'gen_ai.usage.cache_read.input_tokens', value: { intValue: '1536' } },
          { key: 'gen_ai.usage.output_tokens', value: { intValue: '10' } },
          { key: 'gen_ai.response.model', value: { stringValue: 'copilot-nes-x' } },
          { key: 'copilot_chat.request.max_prompt_tokens', value: { intValue: '12285' } },
        ] },
      ] }] }],
    });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].channel, 'inline');
    assert.deepStrictEqual(events[0].tokens, { input: 104, output: 10, cacheRead: 1536 });
    assert.strictEqual(events[0].contextLimit, 12285);
    assert.strictEqual(events[0].model, 'copilot-nes-x');
    assert.strictEqual(events[0].eventId, 'copilot-span:n1');
  });

  test('chat spans inside an invoke_agent span are skipped (the agent span carries the totals)', () => {
    const events = normalizeOtlpTraces({
      resourceSpans: [{ scopeSpans: [{ spans: [
        { spanId: 'a', name: 'invoke_agent', attributes: [{ key: 'gen_ai.usage.input_tokens', value: { intValue: '500' } }] },
        { spanId: 'c', parentSpanId: 'a', name: 'chat gpt-x', attributes: [{ key: 'gen_ai.usage.input_tokens', value: { intValue: '300' } }] },
      ] }] }],
    });
    assert.deepStrictEqual(events.map((e) => [e.kind, e.channel, e.tokens?.input]), [['turn_stop', undefined, 500]]);
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
