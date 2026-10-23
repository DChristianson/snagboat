import * as assert from 'assert';
import { payloadStructure } from '../../adapters/copilot/structureCapture';
import { summarize } from '../../scripts/copilotStructure';

const attr = (key: string, value: Record<string, unknown>) => ({ key, value });

// Shaped per the OTLP/JSON wire format and Copilot's documented spans, with
// content capture's text attributes present to prove they're stripped.
const TRACE = {
  resourceSpans: [
    {
      resource: { attributes: [attr('session.id', { stringValue: 'sess-secret-1' })] },
      scopeSpans: [
        {
          spans: [
            { traceId: 't1', spanId: 'a', name: 'invoke_agent', startTimeUnixNano: '1', status: { code: 1 },
              attributes: [attr('gen_ai.usage.input_tokens', { intValue: '200' }), attr('gen_ai.output.messages', { stringValue: 'the full reply text' })] },
            { traceId: 't1', spanId: 'b', parentSpanId: 'a', name: 'chat', startTimeUnixNano: '2',
              attributes: [attr('gen_ai.usage.input_tokens', { intValue: '150' }), attr('gen_ai.request.model', { stringValue: 'gpt-x' })] },
            { traceId: 't1', spanId: 'c', parentSpanId: 'a', name: 'execute_tool', startTimeUnixNano: '3',
              attributes: [attr('gen_ai.tool.name', { stringValue: 'run_in_terminal' }), attr('gen_ai.tool.call.arguments', { stringValue: '{"command":"rm -rf /secret"}' }), attr('ok', { boolValue: true })] },
          ],
        },
      ],
    },
  ],
};

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('captured structure keeps names, links, and numbers, and no text at all', () => {
    const structure: any = payloadStructure('/v1/traces', TRACE);
    const text = JSON.stringify(structure);
    for (const secret of ['sess-secret-1', 'the full reply text', 'gpt-x', 'run_in_terminal', 'rm -rf', 'secret']) {
      assert.ok(!text.includes(secret), `leaked: ${secret}`);
    }
    const spans = structure.resources[0].spans;
    assert.deepStrictEqual(spans.map((s: any) => [s.name, s.parentSpanId ?? null]), [['invoke_agent', null], ['chat', 'a'], ['execute_tool', 'a']]);
    assert.strictEqual(spans[0].attributes['gen_ai.usage.input_tokens'], 200);
    assert.strictEqual(spans[0].attributes['gen_ai.output.messages'], '<string len=19>');
    assert.strictEqual(spans[2].attributes.ok, true);
  });

  test('the summary shows the span tree and where token counts live', () => {
    const lines = summarize([{ structure: payloadStructure('/v1/traces', TRACE) }]).join('\n');
    assert.match(lines, /span "chat" ×1; parent: invoke_agent ×1/);
    assert.match(lines, /gen_ai\.usage\.input_tokens: number 150–150, on 1\/1/);
    assert.match(lines, /invoke_agent {2}\(input_tokens=200\)\n {6}chat {2}\(input_tokens=150\)\n {6}execute_tool/);
    assert.ok(!lines.includes('rm -rf'));
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
