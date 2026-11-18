import * as assert from 'assert';
import { complete, DEFAULT_PROVIDERS, FetchLike, parseProviders, ProviderConfig } from '../../advisor/providers';
import { parseAdvisors } from '../../advisor/advisors';

// A context window for local models (2026-11-18): Ollama's OpenAI-compatible endpoint can't set one per
// request, so a provider with contextWindow on Ollama's port is asked through /api/chat with num_ctx.

async function main() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const ndjson = ['{"message":{"role":"assistant","content":"{\\"summary\\":"},"done":false}', '{"message":{"role":"assistant","content":"\\"ok\\"}"},"done":false}', '{"message":{"content":""},"done":true,"prompt_eval_count":1200,"eval_count":40}'].join('\n') + '\n';
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body ?? '{}') });
    const sse = url.endsWith('/chat/completions');
    const text = sse ? JSON.stringify({ choices: [{ message: { content: 'plain' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) : ndjson;
    return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
  };
  let failures = 0;
  const test = async (name: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failures += 1;
      console.error(`FAIL  ${name}`);
      console.error(err);
    }
  };

  await test('the default local advisor is Llama 3.1 with a 32k context window', () => {
    const { providers, problems } = parseProviders(undefined);
    assert.deepStrictEqual(problems, []);
    assert.deepStrictEqual([providers[0].model, providers[0].contextWindow], ['llama3.1:latest', 32768]);
    assert.deepStrictEqual(DEFAULT_PROVIDERS[0].contextWindow, 32768);
    const bad = parseProviders([{ id: 'x', baseUrl: 'http://localhost:11434/v1', contextWindow: 10 }]);
    assert.match(bad.problems[0], /contextWindow is a whole number/);
    const advisors = parseAdvisors([{ id: 'big', kind: 'model', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1:latest', contextWindow: 65536 }], undefined);
    assert.strictEqual(advisors.advisors[0].contextWindow, 65536, 'snagboat.advisors entries take it too');
  });

  await test("Ollama with a context window is asked through /api/chat with num_ctx; its streamed answer and token counts are read", async () => {
    const p: ProviderConfig = { ...parseProviders(undefined).providers[0] };
    const c = await complete(p, [{ role: 'user', content: 'hi' }], undefined, fetchImpl);
    assert.strictEqual(calls[0].url, 'http://localhost:11434/api/chat');
    assert.deepStrictEqual([calls[0].body.model, (calls[0].body.options as { num_ctx: number }).num_ctx, calls[0].body.stream], ['llama3.1:latest', 32768, true]);
    assert.deepStrictEqual(c, { text: '{"summary":"ok"}', promptTokens: 1200, completionTokens: 40 });
  });

  await test('without a context window, or on another server, the OpenAI-compatible endpoint is used as before', async () => {
    calls.length = 0;
    const base = parseProviders(undefined).providers[0];
    await complete({ ...base, contextWindow: undefined }, [{ role: 'user', content: 'hi' }], undefined, fetchImpl);
    await complete({ ...base, baseUrl: 'http://localhost:1234/v1' }, [{ role: 'user', content: 'hi' }], undefined, fetchImpl);
    assert.deepStrictEqual(calls.map((c) => c.url), ['http://localhost:11434/v1/chat/completions', 'http://localhost:1234/v1/chat/completions']);
  });

  console.log(`\n${3 - failures}/3 passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
