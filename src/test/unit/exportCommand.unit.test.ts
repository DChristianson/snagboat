import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import type { CommitRecord, ExportManifest, FindingRecord, GitRecord, LinkRecord, NormalizedEvent, PlanRecord, StoreRecord } from '@snagboat/schema';
import { runCli } from '../../cli/main';
import { saveConfig } from '../../core/config';
import { ExportOptions, exportProject, ExportResult } from '../../core/exportProject';
import { decisionId, DECISIONS_FILE, REVIEW_FILE, ReviewFile } from '../../core/filter';
import { workspaceStoreDir } from '../../core/userStore';
import { Schema, validate } from './schemaValidate';

// snagboat export end to end (snagboat-93b.10.7, the filter snagboat-93b.11): a made-up store with
// planted values, two worktrees, a --match path, a separate clone and an unrelated project,
// exported to a folder. Each filter rule's own cases are in filterRule-<id>.unit.test.ts.
// Planted values are assembled, so none appears whole in the repository.
const j = (...parts: string[]) => parts.join('');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-export-')));
const USER = j('qz', 'user');
const HOST = j('qz', '-laptop', '.local');
const HOME = path.join(ROOT, 'home', USER);
const SNAGBOAT_HOME = path.join(HOME, '.snagboat');
const PROJECT = path.join(HOME, 'work', 'acme-app');
const WT_INSIDE = path.join(PROJECT, '.claude', 'worktrees', 'agent-1');
const WT_OUTSIDE = path.join(HOME, 'work', 'acme-app-wt2');
const CLONE = path.join(HOME, 'work', 'acme-clone');
const OTHER = path.join(HOME, 'work', 'other-project');
const MATCH = j('/workspaces/', 'acme-app');
const PERSON_NAME = j('Robin', ' Exampleton');
const PERSON_EMAIL = j('robin', '@', 'example.org');
const OWNER_EMAIL = j('owner.person', '@', 'example.net');
const AWS = j('AKIA', 'QZQZQZQZ', 'QZQZQZQZ');
const IPV4 = j('10.', '20.', '30.', '40');
const PHONE = j('(555) ', '010-0199');
const DENY = j('Blue', 'fin');
const INTERNAL_URL = j('http://build-box', '.internal:8080/jobs/7');
const SHA1 = crypto.createHash('sha1').update('root commit').digest('hex');
const SHA2 = crypto.createHash('sha1').update('second commit').digest('hex');
const OTHER_SHA = crypto.createHash('sha1').update('another repository').digest('hex');
const CLONE_ONLY = j('clone', '-only-session');
const OTHER_ONLY = j('other', '-only-session');

const PLANTED: Array<[string, string]> = [
  ['root', ROOT], ['home', HOME], ['project', PROJECT], ['worktree', WT_INSIDE], ['outside worktree', WT_OUTSIDE], ['match', MATCH],
  ['user', USER], ['host', HOST], ['person', PERSON_NAME], ['email', PERSON_EMAIL], ['owner email', OWNER_EMAIL], ['aws', AWS],
  ['ip', IPV4], ['phone', PHONE], ['deny', DENY], ['internal url', 'build-box'], ['sha1', SHA1], ['sha2', SHA2], ['short sha', SHA2.slice(0, 8)],
  ['clone session', CLONE_ONLY], ['other session', OTHER_ONLY], ['clone path', CLONE], ['other path', OTHER],
];

const NOW = new Date('2026-11-23T12:00:00.000Z');

const ev = (workspace: string, o: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'eventId' | 'kind' | 'sessionId'>): NormalizedEvent => ({
  agent: 'claude-code',
  ts: '2026-11-20T10:00:00.000Z',
  status: 'unknown',
  workspace,
  raw: { adapter: 'claude-code', ref: path.join(HOME, '.claude', 'projects', 'x.jsonl#L4') },
  ...o,
});

function writeStore(folder: string, events: NormalizedEvent[], records: { git?: GitRecord[]; plan?: PlanRecord[]; links?: LinkRecord[]; findings?: FindingRecord[] } = {}): void {
  const dir = workspaceStoreDir(SNAGBOAT_HOME, folder);
  fs.mkdirSync(path.join(dir, 'events'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ workspace: folder, folder }));
  const byDay = new Map<string, string[]>();
  for (const e of events) {
    const day = new Date(e.ts).toISOString().slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), JSON.stringify(e)]);
  }
  for (const [day, lines] of byDay) fs.writeFileSync(path.join(dir, 'events', `${day}.jsonl`), lines.join('\n') + '\n');
  const lines = (rs: StoreRecord[] | undefined) => (rs ?? []).map((r) => JSON.stringify(r) + '\n').join('');
  if (records.git) fs.writeFileSync(path.join(dir, 'git.jsonl'), lines(records.git));
  if (records.plan) fs.writeFileSync(path.join(dir, 'plan.jsonl'), lines(records.plan));
  if (records.links) fs.writeFileSync(path.join(dir, 'links.jsonl'), lines(records.links));
  if (records.findings) fs.writeFileSync(path.join(dir, 'findings.jsonl'), lines(records.findings));
}

const commit = (sha: string, parents: string[], o: Partial<CommitRecord> = {}): CommitRecord => ({
  record: 'commit', version: 1, sha, parents, kind: 'commit', authoredAt: '2026-11-19T09:00:00-05:00', committedAt: '2026-11-19T09:00:00-05:00',
  author: `${PERSON_NAME} <${PERSON_EMAIL}>`, committer: `${PERSON_NAME} <${PERSON_EMAIL}>`, coAuthors: [], subject: 'First', files: [], onBranches: ['main'], ...o,
});

function setUp(): void {
  fs.rmSync(HOME, { recursive: true, force: true });
  // On disk: the project's repository, a worktree inside it, one outside it, and a separate clone.
  fs.mkdirSync(path.join(PROJECT, '.git', 'worktrees', 'agent-1'), { recursive: true });
  fs.mkdirSync(path.join(PROJECT, '.git', 'worktrees', 'wt2'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT, '.git', 'worktrees', 'wt2', 'commondir'), '../..\n');
  fs.mkdirSync(WT_INSIDE, { recursive: true });
  fs.writeFileSync(path.join(WT_INSIDE, '.git'), `gitdir: ${path.join(PROJECT, '.git', 'worktrees', 'agent-1')}\n`);
  fs.mkdirSync(WT_OUTSIDE, { recursive: true });
  fs.writeFileSync(path.join(WT_OUTSIDE, '.git'), `gitdir: ${path.join(PROJECT, '.git', 'worktrees', 'wt2')}\n`);
  fs.mkdirSync(path.join(CLONE, '.git'), { recursive: true });
  fs.mkdirSync(path.join(OTHER, '.git'), { recursive: true });
  saveConfig(SNAGBOAT_HOME, { version: 1, defaults: { 'export.deny': [DENY] }, projects: {} });

  const c1 = commit(SHA1, []);
  const c2 = commit(SHA2, [SHA1], {
    committedAt: '2026-11-20T10:30:00Z', authoredAt: '2026-11-20T10:30:00Z', subject: `Fix ${DENY} in ${PROJECT}/src/app.ts (#12)`,
    body: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, files: [{ path: 'src/app.ts', status: 'M', added: 3, deleted: 1 }], pr: 12, onBranches: ['fix', 'main'],
  });
  const branch: GitRecord = { record: 'branch', version: 1, id: 'fix@2026-11-20T08:00:00.000Z', name: 'fix', firstSeenAt: '2026-11-20T08:00:00.000Z', head: SHA2, from: SHA1 };
  const checkout = (where: string, id: string, atTime: string): GitRecord => ({ record: 'checkout', version: 1, id, at: atTime, from: 'main', to: 'fix', commit: SHA1, where });
  const shared = [c1, c2, branch];

  writeStore(
    PROJECT,
    [
      ev(PROJECT, {
        eventId: 'u-1', sessionId: 'sess-1', kind: 'user_prompt', turnId: 't-1',
        promptText: `Fix ${PROJECT}/src/app.ts for ${PERSON_NAME} (${PERSON_EMAIL}); key ${AWS}; box ${IPV4}; call ${PHONE}; the ${DENY} client on ${USER}@${HOST}; CI ${INTERNAL_URL}; see ${SHA2.slice(0, 8)} and ${WT_OUTSIDE}/lib/x.py`,
      }),
      ev(PROJECT, {
        eventId: 'tool:toolu_1', sessionId: 'sess-1', kind: 'tool_call', toolName: 'Bash', toolCategory: 'version-control', status: 'success', ts: '2026-11-20T10:29:30.000Z',
        target: `cd ${PROJECT} && git commit -m fix`, toolInput: { command: `cd ${PROJECT} && git commit -m fix`, path: `${HOME}/notes/todo.md` },
      }),
      // 23:30 at -05:00 is the next day in UTC.
      ev(PROJECT, { eventId: 'stop-1', sessionId: 'sess-1', kind: 'turn_stop', ts: '2026-11-21T23:30:00-05:00', textExcerpt: `Done; mailed ${PERSON_EMAIL}.` }),
    ],
    {
      git: [...shared, checkout(PROJECT, 'checkout-00000000000000aa', '2026-11-20T08:00:00.000Z')],
      plan: [
        {
          record: 'item', version: 1, id: 'acme-1', kind: 'task', title: `Fix ${DENY}`, status: 'done', labels: [], created: '2026-11-19T10:00:00Z', updated: '2026-11-20T10:00:00Z',
          closed: '2026-11-20T11:00:00Z', owner: OWNER_EMAIL, createdBy: PERSON_NAME, assignee: PERSON_NAME, text: { description: `See ${HOME}/spec.md` }, source: 'beads', confidence: 'observed',
        },
        { record: 'transition', version: 1, id: 'ev-1', item: 'acme-1', at: '2026-11-20T11:00:00Z', type: 'closed', actor: PERSON_NAME, confidence: 'observed' },
      ],
      links: [
        { record: 'link', version: 1, id: 'link-00112233aabbccdd', from: { type: 'session', id: 'sess-1' }, to: { type: 'commit', id: SHA2 }, kind: 'made', confidence: 'observed', evidence: [{ rule: 'git-commit-tool-call', refs: ['tool:toolu_1', SHA2] }], at: '2026-11-20T10:30:00Z' },
        { record: 'link', version: 1, id: 'link-99887766aabbccdd', from: { type: 'session', id: 'sess-1' }, to: { type: 'plan-item', id: 'acme-1' }, kind: 'touched', how: 'closed', confidence: 'inferred', evidence: [{ rule: 'id-in-text', refs: ['u-1'] }], at: '2026-11-20T10:00:00Z' },
      ],
      findings: [
        {
          record: 'finding', version: 1, id: 'finding-0011223344556677', heuristicId: 'retry-loop', heuristicVersion: '0.9.0', sessionId: 'sess-1', severity: 'warn',
          summary: `Retried ${PROJECT}/src/app.ts 5 times`, firstTs: '2026-11-20T10:00:00Z', lastTs: '2026-11-20T10:05:00Z', eventRefs: ['tool:toolu_1'], earlyWarning: false, response: 'useful',
        },
      ],
    }
  );
  writeStore(WT_INSIDE, [ev(WT_INSIDE, { eventId: 'u-in', sessionId: 'sess-in', kind: 'user_prompt', promptText: `Edit ${WT_INSIDE}/src/wt.ts`, ts: '2026-11-21T09:00:00Z' })], {
    git: [...shared, checkout(WT_INSIDE, 'checkout-00000000000000bb', '2026-11-21T08:00:00.000Z')],
  });
  writeStore(WT_OUTSIDE, [ev(WT_OUTSIDE, { eventId: 'u-2', sessionId: 'sess-2', kind: 'user_prompt', promptText: `Edit ${WT_OUTSIDE}/lib/x.py`, ts: '2026-11-21T09:00:00Z' })], {
    git: [...shared, checkout(WT_OUTSIDE, 'checkout-00000000000000cc', '2026-11-21T08:00:00.000Z')],
  });
  writeStore(MATCH, [ev(MATCH, { eventId: 'u-3', sessionId: 'sess-3', kind: 'user_prompt', promptText: `In the container: ${MATCH}/src/c.ts`, ts: '2026-11-21T10:00:00Z' })]);
  // A separate clone of the same repository (its own .git folder) and an unrelated project: never exported.
  writeStore(CLONE, [ev(CLONE, { eventId: 'u-9', sessionId: CLONE_ONLY, kind: 'user_prompt', promptText: 'clone', ts: '2026-11-21T10:00:00Z' })], { git: shared });
  writeStore(OTHER, [ev(OTHER, { eventId: 'u-8', sessionId: OTHER_ONLY, kind: 'user_prompt', promptText: 'other', ts: '2026-11-21T10:00:00Z' })], { git: [commit(OTHER_SHA, [])] });
}

const OUT = path.join(ROOT, 'exports', 'acme');

const opts = (over: Partial<ExportOptions> = {}): ExportOptions => ({
  home: SNAGBOAT_HOME, project: PROJECT, out: OUT, match: [MATCH], version: 'test', now: NOW, homeDir: HOME, ...over,
});

/** --rewrite-all: every value found rewritten, so nothing waits for review. */
const all = (over: Partial<ExportOptions> = {}) => opts({ rewriteAll: true, ...over });

/** The project's folder of the store, which keeps the filter's decisions and review file. */
const STATE = () => workspaceStoreDir(SNAGBOAT_HOME, PROJECT);

/** Every file under dir, relative, sorted. */
function walk(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name), base) : [path.relative(base, path.join(dir, d.name)).split(path.sep).join('/')])).sort();
}

const read = (file: string) => fs.readFileSync(path.join(OUT, file), 'utf8');
const lines = <T>(file: string): T[] => read(file).split('\n').filter((l) => l).map((l) => JSON.parse(l) as T);

function ok(r: ExportResult): Extract<ExportResult, { ok: true }> {
  assert.ok(r.ok, r.ok ? '' : `${r.reason}: ${r.message}`);
  return r as Extract<ExportResult, { ok: true }>;
}

/** A zip's entries, by name, from its central directory: enough to read back what zipFiles writes. */
function unzip(buf: Buffer): Map<string, string> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    assert.strictEqual(buf.readUInt32LE(at), 0x02014b50);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30);
    const comment = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + size);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.strictEqual(zlib.crc32(data) >>> 0, crc, `crc of ${name}`);
    out.set(name, data.toString('utf8'));
    at += 46 + nameLen + extra + comment;
  }
  return out;
}

/** The schema manifest.schemas gives a file, matching its patterns (events/*.jsonl). */
function schemaFor(schemas: Record<string, string>, file: string): string | undefined {
  for (const [pattern, schema] of Object.entries(schemas)) {
    const re = new RegExp(`^${pattern.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]+')}$`);
    if (re.test(file)) return schema;
  }
  return undefined;
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('layout and counts: the project, its worktrees and the --match path; not the clone or the other project', async () => {
    setUp();
    const r = ok(await exportProject(all()));
    assert.deepStrictEqual(walk(OUT), [
      'README.md', 'events/2026-11-20.jsonl', 'events/2026-11-21.jsonl', 'events/2026-11-22.jsonl', 'findings.jsonl',
      'git/branches.jsonl', 'git/checkouts.jsonl', 'git/commits.jsonl', 'links.jsonl', 'manifest.json',
      'plan/items.jsonl', 'plan/transitions.jsonl',
      'schema/exportManifest.v2.schema.json', 'schema/exportedEvent.v5.schema.json', 'schema/findingRecord.v1.schema.json',
      'schema/gitRecord.v1.schema.json', 'schema/linkRecord.v1.schema.json', 'schema/planRecord.v1.schema.json',
      'schema/sessionRecord.v1.schema.json', 'sessions.jsonl',
    ]);
    assert.deepStrictEqual([...r.selection.workspaces].sort(), [MATCH, PROJECT, WT_INSIDE, WT_OUTSIDE].sort());
    assert.deepStrictEqual(r.selection.worktrees, [WT_INSIDE, WT_OUTSIDE].sort());
    assert.strictEqual(r.selection.firstCommit, SHA1);
    const m = JSON.parse(read('manifest.json')) as ExportManifest;
    assert.deepStrictEqual(m, r.manifest);
    assert.strictEqual(m.format, 'snagboat-export');
    assert.strictEqual(m.version, 2);
    assert.strictEqual(m.project, 'acme-app');
    assert.deepStrictEqual(m.counts, { days: 3, events: 6, sessions: 4, findings: 1, commits: 2, branches: 1, checkouts: 3, planItems: 1, transitions: 1, links: 2 });
    assert.deepStrictEqual(m.range, { first: '2026-11-20T10:00:00.000Z', last: '2026-11-22T04:30:00.000Z' });
    assert.strictEqual(m.filter, 'rewrite-all');
    for (const rule of ['project-path', 'home-path', 'email', 'person', 'deny', 'secret', 'ip', 'phone', 'internal-host', 'sha']) {
      assert.ok(m.rules[rule]?.rewritten > 0 && m.rules[rule].kept === 0, `${rule}: ${JSON.stringify(m.rules)}`);
    }
    const sessions = lines<{ sessionId: string; where: string; commits: Array<{ sha: string }> }>('sessions.jsonl');
    // POSIX paths: on Windows (not supported, its CI job a signal only) the roots are C:\ paths.
    const posix = process.platform !== 'win32';
    if (posix) assert.deepStrictEqual(Object.fromEntries(sessions.map((s) => [s.sessionId, s.where])), {
      'sess-1': '.',
      'sess-in': `[worktree-${r.selection.worktrees.indexOf(WT_INSIDE) + 1}]`,
      'sess-2': `[worktree-${r.selection.worktrees.indexOf(WT_OUTSIDE) + 1}]`,
      'sess-3': '[match-1]',
    });
    const commits = lines<CommitRecord>('git/commits.jsonl');
    assert.strictEqual(sessions.find((s) => s.sessionId === 'sess-1')!.commits[0].sha, commits[1].sha, 'ids join across files');
    assert.strictEqual(lines<{ to: { id: string } }>('links.jsonl').find((l) => l.to.id.startsWith('[commit-'))!.to.id, commits[1].sha);
    const checkouts = lines<{ where: string }>('git/checkouts.jsonl').map((c) => c.where).sort();
    if (posix) assert.deepStrictEqual(checkouts, ['.', '[worktree-1]', '[worktree-2]']);
    const events = lines<{ eventId: string }>('events/2026-11-22.jsonl');
    assert.deepStrictEqual(events.map((e) => e.eventId), ['stop-1'], 'UTC days');
    assert.ok(read('events/2026-11-20.jsonl').includes('./src/app.ts'), 'paths in the project relative to it');
  });

  test('--rewrite-all: nothing planted survives in any file, and nothing is written beside the export', async () => {
    setUp();
    ok(await exportProject(all()));
    for (const file of walk(OUT)) {
      const text = read(file).toLowerCase();
      for (const [what, value] of PLANTED) assert.ok(!text.includes(value.toLowerCase()), `${what} survived in ${file}`);
      assert.ok(!text.includes('"workspace"') && !text.includes('"raw"') && !text.includes('"redactions"'), `workspace, raw or redactions in ${file}`);
    }
    assert.deepStrictEqual(fs.readdirSync(path.dirname(OUT)), ['acme'], 'no review folder beside the export');
    const items = lines<{ owner: string; createdBy: string; assignee: string }>('plan/items.jsonl');
    assert.match(items[0].owner, /^\[person-\d+\]$/);
    assert.notStrictEqual(items[0].owner, items[0].createdBy);
    assert.strictEqual(items[0].createdBy, items[0].assignee);
    const commits = lines<CommitRecord>('git/commits.jsonl');
    assert.strictEqual(items[0].createdBy, commits[0].author, 'a bd actor by name is the git ident of that name');
    assert.strictEqual(commits[1].coAuthors.length, 0);
    assert.ok(commits[1].body!.includes('Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'), 'an agent is no person: its trailer stays');
  });

  test('writes nothing while values are undecided: a review file in the store, and a rerun with decisions writes', async () => {
    setUp();
    ok(await exportProject(all()));
    const before = walk(OUT).map((f) => read(f)).join('\n');
    const r = await exportProject(opts({ now: new Date('2026-12-01T00:00:00Z') }));
    assert.ok(!r.ok && r.reason === 'review', JSON.stringify(r).slice(0, 300));
    assert.strictEqual(walk(OUT).map((f) => read(f)).join('\n'), before, 'an earlier export is left as it was');
    assert.strictEqual(r.reviewFile, path.join(STATE(), REVIEW_FILE), 'in the project\'s folder of the store, never the project');
    assert.ok(r.pendingByRule.email >= 1 && r.pendingByRule['project-path'] >= 1 && !('deny' in r.pendingByRule) && !('sha' in r.pendingByRule), JSON.stringify(r.pendingByRule));
    const review = JSON.parse(fs.readFileSync(r.reviewFile, 'utf8')) as ReviewFile;
    assert.strictEqual(review.project, PROJECT);
    assert.strictEqual(review.items.length, r.pending.length);
    const email = review.items.find((i) => i.rule === 'email' && i.value === PERSON_EMAIL)!;
    assert.ok(email && email.count >= 2 && email.snippets.length >= 1 && email.decision === null && email.becomes === '[email-N]', JSON.stringify(email));
    assert.strictEqual(email.id, decisionId('email', PERSON_EMAIL));

    // Decide all but one: still nothing written, and only the undecided one is asked again.
    // Robin is kept; the email inside "Robin <email>" is still rewritten (nested, decided apart).
    const robin = review.items.find((i) => i.rule === 'person' && i.value === PERSON_NAME)!;
    assert.ok(robin, 'every form of the person is one value, their name');
    for (const i of review.items) i.decision = i.rule === 'ip' ? null : i === robin ? 'keep' : 'rewrite';
    fs.writeFileSync(r.reviewFile, JSON.stringify(review, null, 2));
    const r2 = await exportProject(opts());
    assert.ok(!r2.ok && r2.reason === 'review');
    assert.deepStrictEqual(r2.pending.map((p) => p.rule), ['ip']);
    const decisions = fs.readFileSync(path.join(STATE(), 'export-decisions.json'), 'utf8');
    assert.ok(!decisions.includes(PERSON_EMAIL) && !decisions.includes(IPV4), 'decisions hold hashes, never values');
    assert.strictEqual(DECISIONS_FILE, 'export-decisions.json');

    const review2 = JSON.parse(fs.readFileSync(r2.reviewFile, 'utf8')) as ReviewFile;
    review2.items[0].decision = 'rewrite';
    fs.writeFileSync(r2.reviewFile, JSON.stringify(review2));
    const done = ok(await exportProject(opts()));
    assert.strictEqual(done.manifest.filter, 'reviewed');
    assert.ok(!fs.existsSync(r.reviewFile), 'the review file goes once nothing is undecided');
    const prompt = read('events/2026-11-20.jsonl');
    assert.ok(prompt.includes(`for ${PERSON_NAME} ([email-1])`), 'the person you kept, the email inside rewritten');
    assert.ok(!prompt.includes(IPV4) && prompt.includes('[ip-1]'), 'the address you rewrote');
    assert.ok(prompt.includes(SHA2.slice(0, 8)), 'SHAs are kept by default');
    assert.deepStrictEqual(done.manifest.rules.person, { rewritten: 1, kept: 1 }, 'Robin kept, the owner rewritten');
    // A later export asks about nothing it asked before.
    ok(await exportProject(opts()));
    assert.ok(!fs.existsSync(r.reviewFile));
  });

  test('--no-filter: the records as stored, nothing rewritten, nothing asked', async () => {
    setUp();
    const r = ok(await exportProject(opts({ noFilter: true })));
    assert.strictEqual(r.manifest.filter, 'none');
    assert.deepStrictEqual(r.manifest.rules, {});
    const prompt = read('events/2026-11-20.jsonl');
    for (const v of [PROJECT, PERSON_EMAIL, AWS, SHA2.slice(0, 8)]) assert.ok(prompt.includes(v));
    assert.ok(!read('events/2026-11-20.jsonl').includes('"workspace"'), 'workspace and raw still never exported');
    assert.ok(!fs.existsSync(path.join(STATE(), REVIEW_FILE)));
    await assert.rejects(exportProject(opts({ noFilter: true, rewriteAll: true })), /--no-filter/);
  });

  test('actions: the export.rules setting, and --rule over it', async () => {
    setUp();
    const rewrite = { 'project-path': 'rewrite', 'home-path': 'rewrite', secret: 'rewrite', email: 'keep', phone: 'rewrite', ip: 'rewrite', 'internal-host': 'rewrite', 'unknown-hex': 'rewrite', 'high-entropy': 'rewrite', person: 'keep' };
    saveConfig(SNAGBOAT_HOME, { version: 1, defaults: { 'export.deny': [DENY], 'export.rules': rewrite }, projects: {} });
    const r = ok(await exportProject(opts()));
    assert.strictEqual(r.manifest.filter, 'reviewed');
    assert.ok(read('events/2026-11-20.jsonl').includes(PERSON_EMAIL), 'export.rules keeps emails');
    ok(await exportProject(opts({ rules: { email: 'rewrite' } })));
    assert.ok(!read('events/2026-11-20.jsonl').includes(PERSON_EMAIL), '--rule rewrites them');
    ok(await exportProject(opts({ rules: { sha: 'rewrite' } })));
    assert.ok(!read('events/2026-11-20.jsonl').includes(SHA2.slice(0, 8)) && read('git/commits.jsonl').includes('[commit-'), '--rule sha=rewrite');
    saveConfig(SNAGBOAT_HOME, { version: 1, defaults: { 'export.rules': { email: 'sometimes' } }, projects: {} });
    const bad = await exportProject(all());
    assert.ok(bad.ok && bad.notes.some((n) => n.includes('export.rules')), 'a bad setting is noted and ignored');
  });

  test("a SHA outside the export's range is a known commit: the whole git.jsonl is read", async () => {
    setUp();
    // Only u-1 (10:00), which names SHA2 by 8 characters; SHA2's commit (10:30) is outside.
    const r = ok(await exportProject(all({ since: '2026-11-20T09:59:00.000Z', until: '2026-11-20T10:01:00.000Z' })));
    assert.strictEqual(r.manifest.counts.commits, 0);
    const prompt = read('events/2026-11-20.jsonl');
    assert.ok(prompt.includes('see [commit-1]') && !prompt.includes('[hex-'), prompt);
    assert.ok(!('unknown-hex' in r.manifest.rules));
  });

  test('the export explains itself: README, schema/, and every record valid against the schema the manifest names', async () => {
    setUp();
    const r = ok(await exportProject(all()));
    assert.strictEqual(r.manifest.readme, 'README.md');
    assert.match(read('README.md'), /^# A Snagboat export/);
    assert.ok(read('README.md').includes('| `person` |') && read('README.md').includes('[person-N]'), 'the rule table explains the placeholders');
    assert.ok(!read('README.md').includes('{{RULE_TABLE}}'));
    let checked = 0;
    for (const file of walk(OUT).filter((f) => f.endsWith('.jsonl') || f === 'manifest.json')) {
      const schemaFile = schemaFor(r.manifest.schemas, file);
      assert.ok(schemaFile, `no schema named for ${file}`);
      const schema = JSON.parse(read(schemaFile)) as Schema;
      assert.strictEqual(schema.$id, schemaFile.slice('schema/'.length), 'the $id names no one: just the file');
      const records = file === 'manifest.json' ? [JSON.parse(read(file))] : lines<unknown>(file);
      for (const rec of records) {
        assert.deepStrictEqual(validate(schema, rec), [], `${file}: ${JSON.stringify(rec).slice(0, 200)}`);
        checked++;
      }
    }
    assert.ok(checked > 20, `${checked} records checked`);
    for (const file of walk(OUT).filter((f) => f.startsWith('schema/'))) assert.ok(!read(file).includes('github.com/'), `${file} links to a repository`);
  });

  test('--zip: the export folder in one file, the same bytes on a rerun', async () => {
    setUp();
    const r = ok(await exportProject(all({ zip: true })));
    assert.strictEqual(r.zipFile, `${OUT}.zip`);
    const zipped = unzip(fs.readFileSync(r.zipFile!));
    assert.deepStrictEqual([...zipped.keys()].sort(), walk(OUT).map((f) => `acme/${f}`));
    for (const f of walk(OUT)) assert.strictEqual(zipped.get(`acme/${f}`), read(f), f);
    const bytes = fs.readFileSync(r.zipFile!);
    ok(await exportProject(all({ zip: true })));
    assert.ok(fs.readFileSync(`${OUT}.zip`).equals(bytes), 'the same store zips to the same bytes');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(OUT)).sort(), ['acme', 'acme.zip']);
    // Without --zip, an old zip would be another export's: it goes.
    ok(await exportProject(all()));
    assert.ok(!fs.existsSync(`${OUT}.zip`));
  });

  test('--out inside the project is refused and nothing is written; under its .snagboat/ it is made ignored', async () => {
    setUp();
    for (const out of [path.join(PROJECT, 'exports'), path.join(WT_OUTSIDE, 'x'), path.join(PROJECT, '.snagboat'), path.join(SNAGBOAT_HOME, 'data', 'x')]) {
      const r = await exportProject(all({ out }));
      assert.ok(!r.ok && r.reason === 'refused', `${out}: ${JSON.stringify(r)}`);
      assert.ok(!fs.existsSync(out) || fs.readdirSync(out).length === 0, `${out} was written`);
    }
    const inside = path.join(PROJECT, '.snagboat', 'exports', 'acme');
    ok(await exportProject(all({ out: inside })));
    assert.strictEqual(fs.readFileSync(path.join(PROJECT, '.snagboat', 'exports', '.gitignore'), 'utf8').split('\n').includes('*'), true);
    // And through the CLI: exit 1, with the reason.
    const prev = process.env.SNAGBOAT_HOME;
    process.env.SNAGBOAT_HOME = SNAGBOAT_HOME;
    try {
      let err = '';
      const code = await runCli(['export', '--out', 'exports'], { out: () => undefined, err: (t) => (err += t), cwd: path.join(PROJECT, 'src'), now: NOW }, 'test');
      assert.strictEqual(code, 1, err);
      assert.match(err, /inside the project/);
      assert.ok(!fs.existsSync(path.join(PROJECT, 'src', 'exports')));
    } finally {
      if (prev === undefined) delete process.env.SNAGBOAT_HOME;
      else process.env.SNAGBOAT_HOME = prev;
    }
  });

  test('--text none: structure only', async () => {
    setUp();
    ok(await exportProject(all({ text: 'none' })));
    const events = lines<NormalizedEvent>('events/2026-11-20.jsonl');
    const prompt = events.find((e) => e.eventId === 'u-1')!;
    assert.strictEqual(prompt.kind, 'user_prompt');
    assert.ok(!prompt.promptText, 'no prompt text');
    assert.strictEqual(lines<{ title: string }>('plan/items.jsonl')[0].title, '');
    assert.strictEqual((JSON.parse(read('manifest.json')) as ExportManifest).text, 'none');
    assert.ok(!read('findings.jsonl').includes('Retried'));
  });

  test('a rerun replaces the export whole, the same bytes for the same store, with no temporary folders left', async () => {
    setUp();
    ok(await exportProject(all()));
    const first = new Map(walk(OUT).map((f) => [f, read(f)]));
    fs.writeFileSync(path.join(OUT, 'stale.jsonl'), '{}\n');
    ok(await exportProject(all()));
    assert.deepStrictEqual(new Map(walk(OUT).map((f) => [f, read(f)])), first, 'placeholders numbered the same way');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(OUT)).sort(), ['acme']);
    // An existing folder that isn't an export is never replaced.
    const mine = path.join(ROOT, 'mine');
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'notes.txt'), 'keep me');
    const r = await exportProject(all({ out: mine }));
    assert.ok(!r.ok && r.reason === 'refused');
    assert.strictEqual(fs.readFileSync(path.join(mine, 'notes.txt'), 'utf8'), 'keep me');
  });

  test("--since and --until select by each record's time; with nothing to decide the store is never written", async () => {
    setUp();
    const storeBefore = walk(path.join(SNAGBOAT_HOME, 'data')).map((f) => `${f}:${fs.statSync(path.join(SNAGBOAT_HOME, 'data', f)).mtimeMs}`);
    const r = ok(await exportProject(all({ since: '2026-11-21T00:00:00.000Z', until: '2026-11-22T00:00:00.000Z' })));
    assert.deepStrictEqual(walk(path.join(OUT, 'events')), ['2026-11-21.jsonl']);
    assert.strictEqual(r.manifest.counts.commits, 0);
    assert.strictEqual(r.manifest.counts.checkouts, 2);
    assert.strictEqual(r.manifest.counts.planItems, 0, 'closed before the range');
    assert.deepStrictEqual(r.manifest.range.since, '2026-11-21T00:00:00.000Z');
    const storeAfter = walk(path.join(SNAGBOAT_HOME, 'data')).map((f) => `${f}:${fs.statSync(path.join(SNAGBOAT_HOME, 'data', f)).mtimeMs}`);
    assert.deepStrictEqual(storeAfter, storeBefore);
  });

  test('the CLI: --json prints the manifest; values to decide exit 3; bad options are refused', async () => {
    setUp();
    const prev = process.env.SNAGBOAT_HOME;
    process.env.SNAGBOAT_HOME = SNAGBOAT_HOME;
    try {
      let out = '';
      let err = '';
      const io = { out: (t: string) => (out += t), err: (t: string) => (err += t), cwd: ROOT, now: NOW };
      const code = await runCli(['export', '--project', PROJECT, '--out', OUT, '--match', MATCH, '--name', 'acme', '--rewrite-all', '--json'], io, 'test');
      assert.strictEqual(code, 0, err);
      const m = JSON.parse(out) as ExportManifest;
      assert.strictEqual(m.project, 'acme');
      assert.deepStrictEqual(m, JSON.parse(read('manifest.json')));
      out = '';
      assert.strictEqual(await runCli(['export', '--project', PROJECT, '--out', OUT, '--rewrite-all', '--rule', 'sha=keep,email=keep'], io, 'test'), 0, err);
      assert.match(out, /Exported acme-app to /);
      assert.match(out, /Privacy filter \(rewrite-all\), values by rule: .*email \d+ kept/);
      err = '';
      assert.strictEqual(await runCli(['export', '--project', PROJECT, '--out', OUT], io, 'test'), 3);
      assert.match(err, /Nothing exported/);
      assert.ok(err.includes(path.join(STATE(), REVIEW_FILE)), err);
      assert.match(err, /\n {2}email: \d+ values?\n/);
      assert.strictEqual(await runCli(['export', '--project', PROJECT], io, 'test'), 2);
      assert.strictEqual(await runCli(['export', '--project', PROJECT, '--out', OUT, '--text', 'some'], io, 'test'), 2);
      assert.strictEqual(await runCli(['export', '--project', PROJECT, '--out', OUT, '--since', 'yesterday'], io, 'test'), 2);
      assert.strictEqual(await runCli(['export', '--project', PROJECT, '--out', OUT, '--rule', 'email'], io, 'test'), 2);
      assert.strictEqual(await runCli(['export', '--project', PROJECT, '--out', OUT, '--rule', 'nope=keep'], io, 'test'), 2);
      assert.strictEqual(await runCli(['export', '--project', PROJECT, '--out', OUT, '--no-filter', '--rewrite-all'], io, 'test'), 2);
      assert.strictEqual(await runCli(['export', '--project', PROJECT, '--out', OUT, '--allow-rule', 'ip'], io, 'test'), 2, '--allow-rule is gone');
    } finally {
      if (prev === undefined) delete process.env.SNAGBOAT_HOME;
      else process.env.SNAGBOAT_HOME = prev;
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
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n${tests.length - failures}/${tests.length} passed`);
  if (failures > 0) process.exit(1);
}

main();
