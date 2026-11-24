import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  BranchRecord,
  CheckoutRecord,
  CommitRecord,
  FindingRecord,
  LinkRecord,
  NormalizedEvent,
  PlanItemRecord,
  SessionRecord,
  TransitionRecord,
} from '@snagboat/schema';
import {
  ensureExportKey,
  exportKeyPath,
  ExportInput,
  finalCheck,
  isAgentIdentity,
  readExportKey,
  RULES_VERSION,
  SanitizeContext,
  SanitizedExport,
  sanitizeExport,
} from '../../core/export';

// Every planted value is assembled here, so none of them appears whole in the repository
// (factory-clock#31's tests do the same): a scan of the repo for them finds only this export.
const j = (...parts: string[]) => parts.join('');
const USER = j('qz', 'user');
const HOST = j('qz', '-laptop', '.local');
const HOME = j('/home/', USER);
const PROJECT = j(HOME, '/work/', 'acme-app');
const WT_INSIDE = j(PROJECT, '/.claude/worktrees/', 'agent-1');
const WT_OUTSIDE = j(HOME, '/work/', 'acme-app-wt2');
const MATCH = j('/workspaces/', 'acme-app');
const PERSON_NAME = j('Robin', ' Exampleton');
const PERSON_EMAIL = j('robin', '@', 'example.org');
const LOGIN = j('rex', 'ampleton');
const LOGIN_EMAIL = j('12345+', LOGIN, '@users.noreply.github.com');
const OTHER_EMAIL = j('someone.else', '@', 'mail.example.net');
const AWS = j('AKIA', 'QZQZQZQZ', 'QZQZQZQZ');
const GH_TOKEN = j('ghp_', 'Ab1'.repeat(12));
const PRIVATE_KEY = j('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIqz', '\n-----END RSA PRIVATE KEY-----');
const IPV4 = j('10.', '20.', '30.', '40');
const IPV6 = j('2001:db8:', ':42');
const MAC = j('3c:22:', 'fb:01:', '9a:7e');
const PHONE_INTL = j('+44 20 ', '7946 0958');
const PHONE_NA = j('(555) ', '010-0199');
const CARD = j('4111 1111 ', '1111 1111');
const ENV_VALUE = j('hunter', '-two');
const CONN_PW = j('S3cret', 'pw');
const PG_PW = j('pg', 'pass99x');
const SSH_PUB = j('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5', 'AAAAIqzqzqzqzqzqzqz', ' ', USER, '@', 'qz-laptop');
const DENY = j('Blue', 'fin');
const REMOTE = j('git@github.com:', 'acme/acme-app.git');
const INTERNAL_URL = j('http://build-box', '.internal:8080/jobs/7');
const UNC = j('\\\\fileserver', '\\share\\plan.docx');
const WIN = j('C:\\Users\\', USER, '\\notes.txt');
const HIGH_ENTROPY = crypto.createHash('sha512').update('made-up seed').digest('base64').replace(/[+/=]/g, 'x').slice(0, 48);
const UNKNOWN_SHA = j('deadbeef', '12');
const SHA1 = crypto.createHash('sha1').update('commit one').digest('hex');
const SHA2 = crypto.createHash('sha1').update('commit two').digest('hex');

/** Every value the rules say must not survive, with the name a failure should report. */
const PLANTED: Array<[string, string]> = [
  ['home', HOME], ['project', PROJECT], ['worktree', WT_INSIDE], ['outside worktree', WT_OUTSIDE], ['match path', MATCH],
  ['user', USER], ['host', HOST], ['person name', PERSON_NAME], ['person email', PERSON_EMAIL], ['login', LOGIN],
  ['login email', LOGIN_EMAIL], ['other email', OTHER_EMAIL], ['aws', AWS], ['github token', GH_TOKEN], ['private key', 'MIIqz'],
  ['ipv4', IPV4], ['ipv6', IPV6], ['mac', MAC], ['phone intl', PHONE_INTL], ['phone na', PHONE_NA], ['card', CARD],
  ['env', ENV_VALUE], ['connection', CONN_PW], ['postgres password', PG_PW], ['ssh key', 'AAAAIqzqzqz'], ['deny', DENY],
  ['remote', 'acme/acme-app'], ['internal url', 'build-box'], ['unc', 'fileserver'], ['windows path', 'notes.txt'],
  ['high entropy', HIGH_ENTROPY], ['unknown sha', UNKNOWN_SHA], ['sha1', SHA1], ['sha2', SHA2], ['sha1 short', SHA1.slice(0, 9)],
  ['+0500 offset', '+05:00'],
];

const KEY = Buffer.alloc(32, 7);
const KEY2 = Buffer.alloc(32, 9);

function ctx(over: Partial<SanitizeContext> = {}): SanitizeContext {
  return {
    projectRoot: PROJECT,
    worktreeRoots: [WT_INSIDE, WT_OUTSIDE],
    matchPaths: [MATCH],
    homeDir: HOME,
    userName: USER,
    hostName: HOST,
    privacy: 'private',
    key: KEY,
    deny: [DENY],
    remotes: [REMOTE],
    ...over,
  };
}

const ev = (o: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'eventId' | 'kind'>): NormalizedEvent => ({
  sessionId: 'sess-1',
  agent: 'claude-code',
  ts: '2026-11-20T10:00:00.000Z',
  status: 'unknown',
  workspace: PROJECT,
  raw: { adapter: 'claude-code', ref: j(HOME, '/.claude/projects/x.jsonl#L4') },
  ...o,
});

function fixture(): ExportInput {
  const prompt = [
    `Read ${PROJECT}/src/app.ts and ${WT_INSIDE}/src/wt.ts and ${WT_OUTSIDE}/lib/x.py, then ${HOME}/Downloads/dump.csv, /tmp/run/out.log and ~/notes/todo.md.`,
    `Also ${MATCH}/src/in-container.ts, ${WIN}, ${UNC} and file://${HOME}/Desktop/a.png.`,
    `My keys: ${AWS} and ${GH_TOKEN}.\n${PRIVATE_KEY}`,
    `Mail ${PERSON_EMAIL} or ${OTHER_EMAIL}; ${PERSON_NAME} said @${LOGIN} and @stranger-dev should look. Robin agreed.`,
    `Box ${IPV4} / ${IPV6} / ${MAC}; loopback 127.0.0.1 and ::1 are fine. Call ${PHONE_INTL} or ${PHONE_NA}. Card ${CARD}.`,
    `DB_PASSWORD=${ENV_VALUE}\nServer=db;Database=app;Password=${CONN_PW};\npostgres://admin:${PG_PW}@db.example.com/app`,
    `${SSH_PUB}\nThe ${DENY} client, on ${USER}@${HOST}. Remote ${REMOTE}. CI at ${INTERNAL_URL} and http://localhost:3000/ok.`,
    `Commit ${SHA1.slice(0, 9)} fixed it; ${UNKNOWN_SHA} is unknown. Blob ${HIGH_ENTROPY}.`,
  ].join('\n');
  const events: NormalizedEvent[] = [
    ev({ eventId: 'u-1', kind: 'user_prompt', promptText: prompt, turnId: 't-1' }),
    ev({ eventId: j('claude-code:', HOME, '/.claude/projects/s.jsonl:123'), kind: 'turn_stop', textExcerpt: `Emailing ${OTHER_EMAIL} again.`, ts: '2026-11-20T15:00:00+05:00' }),
    ev({
      eventId: 'tool:toolu_1',
      kind: 'tool_call',
      toolName: 'Bash',
      toolCategory: 'version-control',
      target: `cd ${PROJECT} && git show ${SHA2}`,
      toolInput: { command: `cd ${PROJECT} && git show ${SHA2}`, path: `${PROJECT}/src/app.ts`, url: INTERNAL_URL },
      refs: { commit: SHA2.slice(0, 7), branch: `${USER}/fix`, planItems: ['acme-1'] },
      status: 'success',
    }),
    ev({ eventId: `outcome:milestone:${SHA1}`, kind: 'outcome', outcome: { type: 'milestone', commit: SHA1, refs: [j('claude-code:', HOME, '/.claude/projects/s.jsonl:123')] } }),
    ev({ eventId: 'todo-1', kind: 'tool_call', todos: { pending: 1, inProgress: 0, completed: 0, items: [{ text: `Ask ${PERSON_EMAIL}`, status: 'pending' }] } }),
  ];
  const commit: CommitRecord = {
    record: 'commit', version: 1, sha: SHA2, parents: [SHA1], kind: 'commit',
    authoredAt: '2026-11-20T09:00:00-05:00', committedAt: '2026-11-20T09:01:00-05:00',
    author: `${PERSON_NAME} <${PERSON_EMAIL}>`, committer: `${PERSON_NAME} <${PERSON_EMAIL}>`,
    coAuthors: ['Claude Opus 5.5 <noreply@anthropic.com>', `${LOGIN} <${LOGIN_EMAIL}>`],
    subject: `Fix ${DENY} path in ${PROJECT}/src/app.ts (#12)`,
    body: `Reverts ${SHA1.slice(0, 7)}.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nCo-Authored-By: ${LOGIN} <${LOGIN_EMAIL}>`,
    files: [{ path: 'src/app.ts', status: 'M', added: 3, deleted: 1 }], pr: 12, reverts: SHA1, onBranches: [`${USER}/fix`, 'main'],
  };
  const commit1: CommitRecord = { ...commit, sha: SHA1, parents: [], coAuthors: [], subject: 'First', body: undefined, reverts: undefined, pr: undefined };
  delete commit1.body;
  delete commit1.reverts;
  delete commit1.pr;
  const branch: BranchRecord = {
    record: 'branch', version: 1, id: `${USER}/fix@2026-11-20T08:00:00.000Z`, name: `${USER}/fix`, firstSeenAt: '2026-11-20T08:00:00.000Z',
    head: SHA2, from: SHA1, merged: { into: 'main', at: '2026-11-21T08:00:00.000Z', via: 'squash', commit: SHA2, pr: 12 },
  };
  const checkout: CheckoutRecord = {
    record: 'checkout', version: 1, id: 'checkout-0123456789abcdef', at: '2026-11-20T08:00:00.000Z', from: 'main', to: `${USER}/fix`, commit: SHA1, where: WT_INSIDE,
  };
  const item: PlanItemRecord = {
    record: 'item', version: 1, id: 'acme-1', kind: 'task', title: `Fix ${DENY} for ${PERSON_EMAIL}`, status: 'done', labels: [], created: '2026-11-19T10:00:00Z',
    updated: '2026-11-20T10:00:00Z', assignee: LOGIN, text: { description: `See ${HOME}/spec.md`, notes: `Ping ${IPV4}` }, source: 'beads', confidence: 'observed',
  };
  const transition: TransitionRecord = {
    record: 'transition', version: 1, id: 'ev-1', item: 'acme-1', at: '2026-11-20T10:00:00Z', type: 'closed', actor: PERSON_NAME, confidence: 'observed',
  };
  const link = (o: Partial<LinkRecord>): LinkRecord => ({
    record: 'link', version: 1, id: 'link-00112233aabbccdd', from: { type: 'session', id: 'sess-1' }, to: { type: 'commit', id: SHA2 }, kind: 'made',
    confidence: 'observed', evidence: [{ rule: 'git-commit-tool-call', refs: ['tool:toolu_1', SHA2, 'checkout-0123456789abcdef'] }], ...o,
  });
  const finding: FindingRecord = {
    record: 'finding', version: 1, id: 'finding-0011223344556677', heuristicId: 'retry-loop', heuristicVersion: '0.9.0', sessionId: 'sess-1',
    severity: 'warn', summary: `Retried ${PROJECT}/src/app.ts 5 times`, firstTs: '2026-11-20T10:00:00Z', lastTs: '2026-11-20T10:05:00Z',
    eventRefs: ['tool:toolu_1', j('claude-code:', HOME, '/.claude/projects/s.jsonl:123')], earlyWarning: false, response: 'useful',
  };
  const session: SessionRecord = {
    sessionId: 'sess-1', agent: 'claude-code', firstTs: '2026-11-20T10:00:00Z', lastTs: '2026-11-20T11:00:00Z', models: ['claude-opus-5-5'],
    prompts: 1, modelCalls: 1, toolCalls: 1, tokens: 100, subagents: 0, days: ['2026-11-20'], name: `Fix for ${PERSON_NAME}`,
    subagentIds: [], where: WT_INSIDE, branches: [`${USER}/fix`], commits: [{ sha: SHA2, confidence: 'observed' }], planItems: [{ id: 'acme-1', how: 'closed', confidence: 'observed' }],
  };
  return {
    events,
    sessions: [session],
    git: [commit1, commit, branch, checkout],
    plan: [item, transition],
    links: [link({}), link({ id: 'link-99887766aabbccdd', to: { type: 'branch', id: branch.id }, kind: 'worked-on' }), link({ id: 'link-dead', supersededBy: 'link-00112233aabbccdd' }), link({ id: 'link-withdrawn', kind: 'made-in', supersededBy: 'withdrawn' })],
    findings: [finding],
  };
}

/** The export as the command would write it: one JSON line per record. */
function files(out: SanitizedExport): Array<{ file: string; text: string }> {
  const lines = (rs: unknown[]) => rs.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const recs = <T>(xs: Array<{ record: T }>) => xs.map((x) => x.record);
  return [
    { file: 'events/2026-11-20.jsonl', text: lines(out.events) },
    { file: 'sessions.jsonl', text: lines(recs(out.sessions)) },
    { file: 'git/commits.jsonl', text: lines(recs(out.commits)) },
    { file: 'git/branches.jsonl', text: lines(recs(out.branches)) },
    { file: 'git/checkouts.jsonl', text: lines(recs(out.checkouts)) },
    { file: 'plan/items.jsonl', text: lines(recs(out.planItems)) },
    { file: 'plan/transitions.jsonl', text: lines(recs(out.transitions)) },
    { file: 'links.jsonl', text: lines(recs(out.links)) },
    { file: 'findings.jsonl', text: lines(recs(out.findings)) },
    { file: 'manifest.json', text: JSON.stringify({ redactions: out.summary.redactions, flags: out.summary.flags, rulesVersion: out.summary.rulesVersion }, null, 2) },
  ];
}

const all = (out: SanitizedExport) => files(out).map((f) => f.text).join('\n');

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('no planted value survives, and the final check finds nothing', () => {
    const out = sanitizeExport(fixture(), ctx());
    const text = all(out);
    for (const [what, value] of PLANTED) {
      assert.ok(!text.toLowerCase().includes(value.toLowerCase()), `${what} survived`);
      assert.ok(!text.includes(JSON.stringify(value).slice(1, -1)), `${what} survived (escaped)`);
    }
    assert.deepStrictEqual(finalCheck(files(out), out.summary.finalCheck), []);
    assert.strictEqual(out.summary.rulesVersion, RULES_VERSION);
  });

  test('workspace and raw are dropped, and times are UTC', () => {
    const out = sanitizeExport(fixture(), ctx());
    for (const e of out.events) {
      assert.ok(!('workspace' in e) && !('raw' in e));
    }
    assert.strictEqual(out.events[1].ts, '2026-11-20T10:00:00.000Z');
    assert.strictEqual(out.commits[1].record.authoredAt, '2026-11-20T14:00:00.000Z');
  });

  test('paths: relative in the project, [worktree-N], [match-N], ~ and [path] keeping the extension', () => {
    const out = sanitizeExport(fixture(), ctx());
    const p = out.events[0].promptText!;
    assert.ok(p.includes('Read src/app.ts and [worktree-1]/src/wt.ts and [worktree-2]/lib/x.py'), p);
    assert.ok(p.includes('then ~/[path].csv, [path].log and ~/[path].md.'), p);
    assert.ok(p.includes('Also [match-1]/src/in-container.ts, [path].txt,'), p);
    assert.ok(p.includes('~/[path].png'), p);
    assert.strictEqual(out.events[2].toolInput?.path, 'src/app.ts');
    assert.ok(out.events[2].toolInput?.command?.startsWith('cd . && git show '));
    assert.strictEqual(out.checkouts[0].record.where, '[worktree-1]');
    assert.strictEqual(out.sessions[0].record.where, '[worktree-1]');
    assert.strictEqual(out.commits[1].record.subject.includes('src/app.ts'), true);
  });

  test('rule 2: typed placeholders, numbered and stable for the same value', () => {
    const out = sanitizeExport(fixture(), ctx());
    const p = out.events[0].promptText!;
    for (const s of ['[redacted AWS key]', '[redacted GitHub token]', '[redacted private key]', '[ip-1]', '[ip-2]', '[mac]', '[phone]', '[card]', '[public key]', '[denied-1]', '[remote]']) {
      assert.ok(p.includes(s), `${s} missing in ${p}`);
    }
    assert.ok(p.includes('DB_PASSWORD=[redacted]'), p);
    assert.ok(p.includes('Password=[redacted];'), p);
    assert.ok(p.includes('postgres://admin:[redacted]@db.example.com/app'), p);
    assert.ok(p.includes('127.0.0.1') && p.includes('::1'), 'loopback is kept');
    assert.ok(p.includes('http://localhost:3000/ok'), 'localhost is fine');
    // The other email is [email-2] in the prompt and again in the reply; the person's is [email-1] in the todo too.
    const email2 = /Mail (\[email-\d\]) or (\[email-\d\])/.exec(p)!;
    assert.ok(out.events[1].textExcerpt!.includes(email2[2]));
    assert.ok(out.events[4].todos!.items![0].text.includes(email2[1]));
    assert.notStrictEqual(email2[1], email2[2]);
    assert.ok(out.planItems[0].record.title.includes('[denied-1]') && out.planItems[0].record.text!.notes!.includes('[ip-1]'));
    const pr = out.events[0].redactions!.filter((r) => r.field === 'promptText');
    assert.ok(pr.some((r) => r.rule === 'secret' && r.count >= 3), JSON.stringify(pr));
    assert.ok(out.summary.redactions.email >= 4);
  });

  test('people are pseudonyms, agents keep their names, and bd actors join git idents by name', () => {
    const out = sanitizeExport(fixture(), ctx());
    const c = out.commits[1].record;
    assert.match(c.author, /^person-[0-9a-f]{8}$/);
    assert.strictEqual(c.author, c.committer);
    assert.deepStrictEqual(c.coAuthors[0], 'Claude Opus 5.5');
    assert.match(c.coAuthors[1], /^person-[0-9a-f]{8}$/);
    assert.notStrictEqual(c.coAuthors[1], c.author);
    assert.ok(c.body!.includes('Co-Authored-By: Claude Opus 5.5\n'), c.body);
    assert.ok(c.body!.includes(`Co-Authored-By: ${c.coAuthors[1]}`), c.body);
    assert.strictEqual(out.transitions[0].record.actor, c.author, 'the bd actor by name is the same person');
    assert.strictEqual(out.planItems[0].record.assignee, c.coAuthors[1], 'the login is the noreply email\'s person');
    const p = out.events[0].promptText!;
    assert.ok(p.includes(`${c.author} said @${c.coAuthors[1]}`), p);
    assert.ok(isAgentIdentity('Copilot', '175728472+Copilot@users.noreply.github.com'));
    assert.ok(isAgentIdentity('dependabot[bot]', '49699333+dependabot[bot]@users.noreply.github.com'));
    assert.ok(isAgentIdentity('dependabot[bot]', 'support@github.com'), "a [bot] name is an app's, whatever the email");
    assert.ok(!isAgentIdentity('Claude Person', 'claude.person@example.com'), 'a human named Claude is a person');
  });

  test("a plan item's owner and createdBy are pseudonyms: a bare email joins the git ident, an agent keeps its name", () => {
    const input = fixture();
    const item = input.plan![0] as PlanItemRecord;
    item.owner = PERSON_EMAIL;
    item.createdBy = PERSON_NAME;
    const agentItem: PlanItemRecord = { ...item, id: 'acme-2', owner: OTHER_EMAIL, createdBy: 'claude-code' };
    input.plan!.push(agentItem);
    const out = sanitizeExport(input, ctx());
    const author = out.commits[1].record.author;
    assert.strictEqual(out.planItems[0].record.owner, author, 'the owner email is the git ident with that email');
    assert.strictEqual(out.planItems[0].record.createdBy, author, 'createdBy by name is the same person');
    assert.match(out.planItems[1].record.owner!, /^person-[0-9a-f]{8}$/);
    assert.notStrictEqual(out.planItems[1].record.owner, author);
    assert.strictEqual(out.planItems[1].record.createdBy, 'claude-code');
    const text = all(out);
    for (const v of [PERSON_EMAIL, OTHER_EMAIL, PERSON_NAME]) assert.ok(!text.includes(v), `${v} survived`);
    assert.deepStrictEqual(finalCheck(files(out), out.summary.finalCheck), []);
  });

  test('flags: replaced with [flagged-N], values only in the review list', () => {
    const out = sanitizeExport(fixture(), ctx());
    const text = all(out);
    const rules = new Set(out.summary.review.map((r) => r.rule));
    for (const rule of ['internal-url', 'unresolved-path', 'unknown-sha', 'high-entropy', 'mention', 'name']) assert.ok(rules.has(rule as never), `no ${rule} flag`);
    for (const r of out.summary.review) {
      assert.ok(!r.allowed);
      assert.ok(text.includes(`[${r.id}]`), `${r.id} not in the export`);
      assert.ok(!text.includes(r.value), `${r.rule} value in the export`);
      assert.ok(r.before.length <= 80 && r.after.length <= 80);
      assert.ok(r.record.length > 0 && r.field.length > 0);
    }
    const url = out.summary.review.find((r) => r.rule === 'internal-url' && r.field === 'promptText')!;
    assert.strictEqual(url.value, INTERNAL_URL);
    assert.strictEqual(url.record, 'event:u-1');
    // The same value has the same id wherever it is (the prompt and toolInput.url).
    const again = out.summary.review.find((r) => r.rule === 'internal-url' && r.field === 'toolInput.url')!;
    assert.strictEqual(again.id, url.id);
    assert.strictEqual(out.events[2].toolInput?.url, `[${url.id}]`);
    assert.strictEqual(out.summary.flags, out.summary.review.length);
    assert.ok(out.events[0].redactions!.some((r) => r.rule === 'internal-url'));
  });

  test('--allow and --allow-rule put values back, and the final check accepts them', () => {
    const first = sanitizeExport(fixture(), ctx());
    const url = first.summary.review.find((r) => r.rule === 'internal-url')!;
    const out = sanitizeExport(fixture(), ctx({ allow: [url.id], allowRules: ['ip'] }));
    const text = all(out);
    assert.ok(text.includes(INTERNAL_URL), 'allowed URL is back');
    assert.ok(text.includes(IPV4) && text.includes(IPV6), 'allowed rule ip is back');
    assert.ok(out.summary.review.some((r) => r.id === url.id && r.allowed));
    assert.ok(out.summary.review.some((r) => r.rule === 'ip' && r.allowed && r.value === IPV4));
    assert.ok(out.summary.flags < first.summary.flags);
    assert.ok(!text.includes(UNKNOWN_SHA), 'other flags stay');
    assert.deepStrictEqual(finalCheck(files(out), out.summary.finalCheck), []);
    assert.throws(() => sanitizeExport(fixture(), ctx({ allowRules: ['secret'] })), /--allow-rule/);
    assert.throws(() => sanitizeExport(fixture(), ctx({ allow: ['3'] })), /--allow/);
  });

  test('private repository: SHAs re-keyed everywhere, consistently', () => {
    const out = sanitizeExport(fixture(), ctx());
    const c = out.commits[1].record;
    const one = out.commits[0].record.sha;
    assert.match(c.sha, /^[0-9a-f]{40}$/);
    assert.notStrictEqual(c.sha, SHA2);
    assert.deepStrictEqual(c.parents, [one]);
    assert.strictEqual(c.reverts, one);
    assert.ok(c.body!.startsWith(`Reverts ${one.slice(0, 7)}.`), c.body);
    assert.ok(out.events[0].promptText!.includes(`Commit ${one.slice(0, 9)} fixed it`));
    assert.ok(out.events[2].toolInput!.command!.endsWith(`git show ${c.sha}`));
    assert.strictEqual(out.events[2].refs!.commit, c.sha.slice(0, 7));
    assert.strictEqual(out.events[3].eventId, `outcome:milestone:${one}`);
    assert.strictEqual(out.events[3].outcome!.commit, one);
    assert.strictEqual(out.branches[0].record.head, c.sha);
    assert.strictEqual(out.branches[0].record.merged!.commit, c.sha);
    assert.strictEqual(out.checkouts[0].record.commit, one);
    assert.strictEqual(out.sessions[0].record.commits[0].sha, c.sha);
    assert.strictEqual(out.links[0].record.to.id, c.sha);
    assert.ok(out.links[0].record.evidence[0].refs.includes(c.sha));
  });

  test('ids: path-embedding event ids, checkout and link ids re-keyed and joined; superseded links dropped', () => {
    const out = sanitizeExport(fixture(), ctx());
    const rekeyed = out.events[1].eventId;
    assert.match(rekeyed, /^claude-code:k-[0-9a-f]{16}$/);
    assert.deepStrictEqual(out.events[3].outcome!.refs, [rekeyed]);
    assert.ok(out.findings[0].record.eventRefs.includes(rekeyed));
    const checkoutId = out.checkouts[0].record.id;
    assert.match(checkoutId, /^checkout-[0-9a-f]{16}$/);
    assert.notStrictEqual(checkoutId, 'checkout-0123456789abcdef');
    assert.ok(out.links[0].record.evidence[0].refs.includes(checkoutId));
    assert.notStrictEqual(out.links[0].record.id, 'link-00112233aabbccdd');
    assert.strictEqual(out.links.length, 2);
    assert.strictEqual(out.links[1].record.to.id, out.branches[0].record.id, 'a branch link joins its branch');
    assert.ok(out.branches[0].record.id.startsWith('[user]/fix@'));
    assert.ok(!('supersededBy' in out.links[0].record));
  });

  test('public repository: known SHAs kept as written, unknown SHA-like hex flagged', () => {
    const CONTAINER = j('3f4e9a', '1b2c7d');
    const STORAGE = crypto.createHash('md5').update('workspace storage').digest('hex');
    const UUID = j('6f1c2a9e-', '4b7d-4e2a-', '9c3f-1a2b3c4d5e6f');
    const text = `Commit ${SHA1} and ${SHA1.slice(0, 9)} and ${SHA2.slice(0, 7)}; container ${CONTAINER}, storage ${STORAGE}, run ${UUID}, ${UNKNOWN_SHA}.`;
    const input = fixture();
    input.events!.push(ev({ eventId: 'hex', kind: 'user_prompt', promptText: text }));
    const out = sanitizeExport(input, ctx({ privacy: 'public' }));
    assert.strictEqual(out.commits[1].record.sha, SHA2);
    const got = out.events[out.events.length - 1].promptText!;
    assert.ok(got.startsWith(`Commit ${SHA1} and ${SHA1.slice(0, 9)} and ${SHA2.slice(0, 7)}; container [flagged-`), got);
    assert.ok(got.includes(`, run ${UUID}, [flagged-`), 'a UUID is untouched');
    for (const v of [CONTAINER, STORAGE, UNKNOWN_SHA]) {
      assert.ok(!got.includes(v), `${v} survived`);
      const flags = out.summary.review.filter((r) => r.value === v && r.record === 'event:hex');
      assert.deepStrictEqual(flags.map((r) => r.rule), ['unknown-sha'], `one unknown-sha flag for ${v}`);
    }
    assert.ok(!out.summary.review.some((r) => r.value.includes(SHA1.slice(0, 7)) || r.value.includes(SHA2.slice(0, 7))), 'a known SHA is not flagged');
    assert.ok(!out.events[out.events.length - 1].redactions!.some((r) => r.rule === 'sha'), 'a kept SHA is not counted');
    assert.ok(!out.summary.finalCheck.literals.some((l) => l.rule === 'sha'));
    assert.deepStrictEqual(finalCheck(files(out), out.summary.finalCheck), []);
    // Private: the same text, known SHAs re-keyed, the rest flagged as before, the UUID untouched.
    const priv = sanitizeExport(input, ctx());
    const p = priv.events[priv.events.length - 1].promptText!;
    assert.ok(!p.includes(SHA1.slice(0, 7)) && p.includes(`, run ${UUID}, [flagged-`), p);
    for (const v of [CONTAINER, STORAGE, UNKNOWN_SHA]) assert.deepStrictEqual(priv.summary.review.filter((r) => r.value === v && r.record === 'event:hex').map((r) => r.rule), ['unknown-sha']);
    // A 64-character hex run is key material to the high-entropy rule, flagged once, not as a SHA.
    const long = crypto.createHash('sha256').update('x').digest('hex');
    const h = sanitizeExport({ events: [ev({ eventId: 'e', kind: 'user_prompt', promptText: `digest ${long}` })] }, ctx({ privacy: 'public', deny: [], remotes: [] }));
    assert.deepStrictEqual(h.summary.review.map((r) => r.rule), ['high-entropy']);
  });

  test('a dotted quad that reads as a version is kept; an address is still replaced', () => {
    const kept = [
      j('pkg@', '1.2.3.4'),
      j('@scope/pkg@', '4.3.2.1'),
      j('Chrome/', '120.0.61.109'),
      j('version ', '10.0.19.1'),
      j('Version: ', '2.0.0.1'),
      j('ver=', '1.0.0.4'),
      j('v. ', '5.6.7.8'),
      j('build number ', '4.3.2.1'),
      j('release ', '3.0.0.12'),
      j('', '1.2.3.4', '-beta'),
      j('', '1.2.3.4', '-rc.1'),
      j('', '1.2.3.4', '+build.5'),
      j('v', '1.2.3.4'),
    ];
    const replaced = [
      IPV4,
      j('ip ', IPV4),
      j('host ', '192.168.', '1.5'),
      j('root@', '10.0.0.7'),
      j('ssh deploy-bot@', '10.0.0.8'),
      j('build server ', '10.0.0.9'),
      j('version check at ', '10.0.0.10'),
      j('ip/', '10.0.0.11'),
      j('', '10.0.0.12', '-eth0'),
    ];
    const events = [...kept, ...replaced].map((t, n) => ev({ eventId: `e${n}`, kind: 'user_prompt', promptText: `see ${t} now` }));
    const out = sanitizeExport({ events }, ctx({ deny: [], remotes: [] }));
    kept.forEach((t, n) => {
      assert.strictEqual(out.events[n].promptText, `see ${t} now`, t);
      assert.strictEqual(out.events[n].redactions, undefined, `${t} counted`);
    });
    replaced.forEach((t, n) => {
      const e = out.events[kept.length + n];
      assert.match(e.promptText!, /\[ip-\d+\]/, t);
      assert.ok(!e.promptText!.includes(t.match(/\d+(?:\.\d+){3}/)![0]), t);
      assert.ok(e.redactions!.some((r) => r.rule === 'ip'), t);
    });
    assert.strictEqual(out.summary.redactions.ip, replaced.length);
    // The final check reads a kept version the same way: no hit.
    assert.deepStrictEqual(finalCheck(files(out), out.summary.finalCheck), []);
    // And it still finds a planted address.
    const hits = finalCheck([{ file: 'x.jsonl', text: JSON.stringify({ t: `host ${IPV4}` }) }], out.summary.finalCheck);
    assert.deepStrictEqual(hits.map((h) => h.rule), ['ip']);
  });

  test('pseudonyms and re-keyed SHAs are stable across runs with the same key, and differ with another', () => {
    const a = sanitizeExport(fixture(), ctx());
    // A second export that sees only the plan (bd actor first, no commits) names the person the same.
    const b = sanitizeExport({ plan: fixture().plan }, ctx());
    assert.strictEqual(b.transitions[0].record.actor, a.commits[1].record.author);
    assert.strictEqual(sanitizeExport(fixture(), ctx()).commits[1].record.sha, a.commits[1].record.sha);
    const c = sanitizeExport(fixture(), ctx({ key: KEY2 }));
    assert.notStrictEqual(c.commits[1].record.author, a.commits[1].record.author);
    assert.notStrictEqual(c.commits[1].record.sha, a.commits[1].record.sha);
    assert.deepStrictEqual(a.summary.review.map((r) => r.id), sanitizeExport(fixture(), ctx()).summary.review.map((r) => r.id), 'flag numbers repeat');
  });

  test('--text none keeps structure only', () => {
    const out = sanitizeExport(fixture(), ctx({ text: 'none' }));
    assert.strictEqual(out.events[0].promptText, undefined);
    assert.strictEqual(out.events[1].textExcerpt, undefined);
    assert.strictEqual(out.events[4].todos!.items, undefined);
    assert.strictEqual(out.events[4].todos!.pending, 1);
    assert.strictEqual(out.events[2].target, undefined);
    assert.deepStrictEqual(out.events[2].toolInput, { path: 'src/app.ts' });
    assert.strictEqual(out.commits[1].record.subject, '');
    assert.strictEqual(out.commits[1].record.body, undefined);
    assert.strictEqual(out.commits[1].record.files[0].path, 'src/app.ts');
    assert.strictEqual(out.planItems[0].record.title, '');
    assert.strictEqual(out.planItems[0].record.text, undefined);
    assert.strictEqual(out.sessions[0].record.name, undefined);
    assert.strictEqual(out.findings[0].record.summary, undefined);
    assert.strictEqual(out.links.length, 2);
  });

  test('the final check catches a planted leak, by rule and file, without the value', () => {
    const out = sanitizeExport(fixture(), ctx());
    const written = files(out);
    written.push({ file: 'events/2026-11-21.jsonl', text: JSON.stringify({ eventId: 'x', promptText: `see ${HOME}/a and ${AWS} and ${OTHER_EMAIL} and ${PERSON_NAME} on ${IPV4} ${SHA1}` }) + '\n' });
    written.push({ file: 'git/odd.txt', text: `not json ${WIN.replace(/\\/g, '\\\\')} ${HOST}` });
    const hits = finalCheck(written, out.summary.finalCheck);
    const by = (file: string) => hits.filter((h) => h.file === file).map((h) => h.rule).sort();
    assert.deepStrictEqual(by('events/2026-11-21.jsonl'), ['email', 'ip', 'path', 'person', 'secret', 'sha', 'user'].sort());
    assert.deepStrictEqual(by('git/odd.txt'), ['host', 'user']);
    const shown = JSON.stringify(hits);
    for (const [, value] of PLANTED) assert.ok(!shown.includes(value), 'a hit shows its value');
    // A value hidden by JSON escaping is still found.
    const escaped = finalCheck([{ file: 'f.jsonl', text: JSON.stringify({ t: HOME }).replace('/', '\\u002f') }], out.summary.finalCheck);
    assert.ok(escaped.some((h) => h.rule === 'path'));
  });

  test('keys: the repository key is named by its first commit, made once, owner-only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-export-keys-'));
    try {
      const file = exportKeyPath(dir, 'private', SHA1);
      assert.strictEqual(path.dirname(file), path.join(dir, 'export-keys'));
      assert.strictEqual(path.basename(file), `${crypto.createHash('sha256').update(SHA1).digest('hex')}.key`);
      assert.strictEqual(exportKeyPath(dir, 'public'), path.join(dir, 'export.key'));
      assert.throws(() => exportKeyPath(dir, 'private'));
      const k1 = ensureExportKey(file);
      assert.strictEqual(k1.length, 32);
      if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
      assert.deepStrictEqual(ensureExportKey(file), k1);
      assert.deepStrictEqual(readExportKey(file), k1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a stack trace with frames from another project is flagged; one from this project is made relative', () => {
    const frames = (root: string) => [1, 2, 3].map((n) => `    at f${n} (${root}/src/m${n}.ts:${n}:1)`).join('\n');
    const other = j(HOME, '/work/', 'other-proj');
    const out = sanitizeExport(
      { events: [ev({ eventId: 'a', kind: 'user_prompt', promptText: `Error: x\n${frames(other)}\nthen` }), ev({ eventId: 'b', kind: 'user_prompt', promptText: `Error: y\n${frames(PROJECT)}` })] },
      ctx(),
    );
    assert.match(out.events[0].promptText!, /^Error: x\n\[flagged-1\]\nthen$/);
    assert.strictEqual(out.summary.review[0].rule, 'foreign-trace');
    assert.ok(out.events[1].promptText!.includes('    at f1 (src/m1.ts:1:1)'), out.events[1].promptText);
  });

  test('ordinary text is left alone', () => {
    const text = 'Run npm test in src/core, then git log --oneline -5. Version 1.2.3 is fine; see https://github.com/microsoft/vscode/issues/123 and @types/node.';
    const out = sanitizeExport({ events: [ev({ eventId: 'e', kind: 'user_prompt', promptText: text })] }, ctx({ deny: [], remotes: [] }));
    assert.strictEqual(out.events[0].promptText, text);
    assert.strictEqual(out.events[0].redactions, undefined);
    assert.strictEqual(out.summary.flags, 0);
  });

  test('a rewritten URL never reads as a link: [repo <what>] for the project, [url-N host] otherwise', () => {
    const repo = path.basename(PROJECT);
    const text = [
      `PR https://github.com/${LOGIN}/${repo}/pull/158).`,
      `doc https://github.com/${LOGIN}/${repo}/blob/main/docs/cli.md#export and git+https://github.com/${LOGIN}/${repo}.git`,
      `other https://github.com/${LOGIN}/other-repo/pull/31 and github.com/${LOGIN}/other-repo`,
      'public https://github.com/microsoft/vscode/issues/123 stays',
      `session https://claude.ai/code/${HIGH_ENTROPY}`,
    ].join('\n');
    const out = sanitizeExport({ events: [ev({ eventId: 'e', kind: 'user_prompt', promptText: text })] }, ctx({ deny: [], remotes: [], people: [`${LOGIN} <${LOGIN_EMAIL}>`] }));
    const lines = out.events[0].promptText!.split('\n');
    assert.strictEqual(lines[0], 'PR [repo pull/158]).');
    assert.strictEqual(lines[1], 'doc [repo blob/main/docs/cli.md#export] and [repo]');
    assert.strictEqual(lines[2], 'other [url-1 github.com] and [url-2 github.com]');
    assert.strictEqual(lines[3], 'public https://github.com/microsoft/vscode/issues/123 stays');
    assert.strictEqual(lines[4], 'session [url-3 claude.ai]');
    // Nothing rewritten is left as a URL: every URL in the output is one that was kept as written.
    for (const url of out.events[0].promptText!.match(/(?:https?:\/\/|github\.com\/)\S+/g) ?? []) assert.ok(url.includes('microsoft/vscode'), url);
    const rules = new Map(out.events[0].redactions!.map((r) => [r.rule, r.count]));
    assert.strictEqual(rules.get('remote'), 3);
    assert.strictEqual(rules.get('url'), 3);
    // Allowing the session token puts the whole URL back as written.
    const allowed = sanitizeExport({ events: [ev({ eventId: 'e', kind: 'user_prompt', promptText: `x https://claude.ai/code/${HIGH_ENTROPY}` })] }, ctx({ deny: [], remotes: [], allowRules: ['high-entropy'] }));
    assert.strictEqual(allowed.events[0].promptText, `x https://claude.ai/code/${HIGH_ENTROPY}`);
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
