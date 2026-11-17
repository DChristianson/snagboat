import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { approvalKey } from '../../advisor/advisors';
import { DEFAULT_PERSONAS } from '../../advisor/goals';
import { FetchLike } from '../../advisor/providers';
import { handleMcp, McpReads } from '../../cli/mcp';
import { writeApprovals } from '../../core/advisorApprovals';
import { loadConfig, saveConfig } from '../../core/config';
import { CoreAdvisors } from '../../core/service/advisorModels';
import { coreRequest, readCoreFile } from '../../core/service/coreFile';
import { CoreService } from '../../core/service/server';
import { StoreWriter } from '../../core/service/storeWriter';

// The review in an agent session (docs/design/goal-tracking-lifecycle.md, snagboat-79f.7.6): the design's
// W46 flow done entirely through the MCP tools, as Claude Code would call them.

const base = { scope: 'global', what: 'What it does.', why: 'Why, with numbers.' };
const cache = { ...base, title: 'Catch smaller cache rewrites', change: { setting: 'heuristics.cacheThrash.minTokens', value: 30000 }, prediction: { measure: 'cache_hit_rate', text: 'Back above 66%.' } };
const context = { ...base, title: 'Warn earlier on context', change: { setting: 'heuristics.contextPressure.percent', value: 80 }, prediction: { measure: 'tokens_per_milestone', text: 'Below 41.2k.' } };
const budget = { ...base, title: "Cap a session's spend", change: { setting: 'tokenBudget.session', value: 600000 }, prediction: { measure: 'tokens_per_milestone', text: 'Below 41.2k.' } };

async function main() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-mcp-review-')));
  const w = path.join(home, 'snagboat');
  fs.mkdirSync(w);
  await new StoreWriter(home).write([{ eventId: 'e1', sessionId: 's1', agent: 'claude-code', ts: new Date(2026, 10, 11, 10).toISOString(), kind: 'turn_stop', status: 'success', turnId: 't1', tokens: { input: 100, output: 0, cacheRead: 300, cacheCreation: 0 }, raw: { adapter: 'test', ref: 'r1' }, workspace: w }]);
  saveConfig(home, { version: 1, defaults: { 'advisor.providers': [{ id: 'local', label: 'Test model', baseUrl: 'http://127.0.0.1:9/v1', model: 'tiny' }] }, projects: {} });
  fs.mkdirSync(path.join(home, 'advisors', 'purser'), { recursive: true });
  fs.writeFileSync(path.join(home, 'advisors', 'purser', 'persona.md'), DEFAULT_PERSONAS.purser.replace('may_change: [rules]', 'may_change: [rules]\nmodel: local'));
  const fetchImpl: FetchLike = async (_url, init) => {
    const data = String(JSON.parse(init.body!).messages[1].content);
    const notes = /"reviseNotes":\[\{"proposal":"([^"]+)"/.exec(data);
    const answer = notes ? { summary: '', verdicts: [], proposals: [{ ...budget, replaces: notes[1] }] } : { summary: 'Cache hits fell 7 points.', verdicts: [], proposals: [cache, context] };
    const body = { choices: [{ message: { role: 'assistant', content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  writeApprovals(home, { local: approvalKey(new CoreAdvisors(home).advisors()[0]) });
  const core = await CoreService.start({ home, version: 'test', idleMs: 0, collect: false, periodEveryMs: 0, fetchImpl, now: () => new Date(2026, 10, 11, 12) });
  const info = readCoreFile(home)!;
  const reads = async (): Promise<McpReads> => ({ workspace: w, get: (p) => coreRequest(info.port, info.token, 'GET', p, undefined, 30_000), post: (p, b) => coreRequest(info.port, info.token, 'POST', p, b, 30_000) });
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, reads, 't')) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    return { text: r.result.content[0].text, error: r.result.isError === true };
  };
  const until = async (re: RegExp) => {
    for (let i = 0; i < 100; i++) {
      const t = (await tool('snagboat_proposals', { advisor: 'purser' })).text;
      if (re.test(t)) return t;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`never: ${re}`);
  };

  let failures = 0;
  try {
    assert.strictEqual((await coreRequest(info.port, info.token, 'POST', '/advisors/purser/report')).status, 201);
    const first = await until(/revision 1/);
    assert.match(first, /Cache hits fell 7 points\./);
    assert.match(first, /\[not marked\] Catch smaller cache rewrites\n    heuristics\.cacheThrash\.minTokens: 50000 → 30000, in every workspace/);
    assert.match(first, /Mark each proposal accept, discard or revise \(with a note\); 2 left\./);
    const [p1, p2] = [...first.matchAll(/(purser-\S+-p\d) \[/g)].map((m) => m[1]);
    assert.match((await tool('snagboat_proposals')).text, /purser \(Purser\): report \S+, revision 1: 2 of 2 proposals to mark\nnavigator \(Navigator\): report \S+, revision 0: numbers only/);

    assert.match((await tool('snagboat_mark_proposal', { id: p1, mark: 'accept' })).text, /Catch smaller cache rewrites: marked accepted/);
    const noNote = await tool('snagboat_mark_proposal', { id: p2, mark: 'revise' });
    assert.deepStrictEqual([noNote.error, noNote.text], [true, 'say what to change: Revise needs a note']);
    await tool('snagboat_mark_proposal', { id: p2, mark: 'revise', note: 'Try a session budget.' });
    assert.match((await tool('snagboat_proposals', { advisor: 'purser' })).text, /sending revision 1 is Revise report/);
    assert.match((await tool('snagboat_send_report', { advisor: 'purser', rev: 1 })).text, /^Sent back to revise\./);

    const second = await until(/revision 2/);
    const p3 = /(purser-\S+-r2-p1) \[not marked\] Cap a session's spend/.exec(second)![1];
    await tool('snagboat_mark_proposal', { id: p3, mark: 'accept' });
    const sent = await tool('snagboat_send_report', { advisor: 'purser', rev: 2 });
    assert.strictEqual(sent.text, "Report accepted. Applied and now tracked as experiments: Catch smaller cache rewrites; Cap a session's spend.");
    assert.strictEqual(loadConfig(home).config.defaults['tokenBudget.session'], 600000);
    const again = await tool('snagboat_send_report', { advisor: 'purser', rev: 2 });
    assert.deepStrictEqual([again.error, again.text], [true, 'this report was already accepted']);
    const readOnly = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'snagboat_mark_proposal', arguments: { id: p3, mark: 'discard' } } }, async () => ({ workspace: w, get: async () => ({ status: 200, body: {} }) }), 't');
    assert.match(JSON.stringify(readOnly), /this Snagboat MCP server reads only/);
    console.log('PASS  the W46 review, entirely through the MCP tools');
  } catch (err) {
    failures += 1;
    console.error('FAIL  the W46 review, entirely through the MCP tools');
    console.error(err);
  } finally {
    await core.stop();
  }
  console.log(`\n${1 - failures}/1 passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
