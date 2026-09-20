import * as assert from 'assert';
import { normalizeOtlpTraces, normalizeOtlpMetrics } from '../../adapters/copilot/normalize';

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

const METRICS_PAYLOAD_SUM = {
  resourceMetrics: [
    {
      resource: { attributes: [{ key: 'session.id', value: { stringValue: 'sess-1' } }] },
      scopeMetrics: [
        {
          metrics: [
            {
              name: 'gen_ai.client.token.usage',
              sum: {
                dataPoints: [
                  {
                    attributes: [
                      { key: 'gen_ai.token.type', value: { stringValue: 'input' } },
                      { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o' } },
                    ],
                    asInt: '120',
                  },
                  {
                    attributes: [{ key: 'gen_ai.token.type', value: { stringValue: 'output' } }],
                    asInt: '45',
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  ],
};

const METRICS_PAYLOAD_HISTOGRAM = {
  resourceMetrics: [
    {
      scopeMetrics: [
        {
          metrics: [
            {
              name: 'gen_ai.client.token.usage',
              histogram: {
                dataPoints: [{ attributes: [{ key: 'gen_ai.token.type', value: { stringValue: 'input' } }], sum: 77 }],
              },
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

  test('normalizeOtlpMetrics maps Sum-shaped gen_ai.client.token.usage data points to turn_stop events with tokens', () => {
    const events = normalizeOtlpMetrics(METRICS_PAYLOAD_SUM);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].kind, 'turn_stop');
    assert.deepStrictEqual(events[0].tokens, { input: 120 });
    assert.strictEqual(events[0].model, 'gpt-4o');
    assert.strictEqual(events[0].sessionId, 'sess-1', 'session.id must be read from the resource, not the data point');
    assert.deepStrictEqual(events[1].tokens, { output: 45 });
  });

  test('normalizeOtlpMetrics also handles a Histogram-shaped metric via its sum field', () => {
    const events = normalizeOtlpMetrics(METRICS_PAYLOAD_HISTOGRAM);
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual(events[0].tokens, { input: 77 });
  });

  test('normalizeOtlpMetrics ignores metrics with an unrelated name', () => {
    const events = normalizeOtlpMetrics({
      resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'some.other.metric', sum: { dataPoints: [] } }] }] }],
    });
    assert.deepStrictEqual(events, []);
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
