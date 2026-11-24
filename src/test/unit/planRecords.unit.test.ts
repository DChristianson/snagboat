import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { foldStoreRecords, PlanItemRecord, PlanRecord, TransitionRecord } from '@snagboat/schema';
import { beadsExportDir, BeadsIssue } from '../../core/beadsExport';
import { saveConfig } from '../../core/config';
import { beadsItem, beadsTransition, markdownItemId, parseMarkdownPlan, taskKey, textStatus } from '../../core/planRecords';
import { findOnPath, PLAN_RECORDS_FILE, PLAN_RECORDS_IDLE_MS, PlanRecordsJob, plansSetting } from '../../core/service/planRecordsJob';
import { StoreWriter } from '../../core/service/storeWriter';
import { appendStoreRecords, readStoreRecordLines } from '../../core/storeRecordFiles';
import { openWorkspaceStore } from '../../core/userStore';

// The plan job (docs/design/export.md, "Plan: plan/items.jsonl, plan/transitions.jsonl"): plan.jsonl from bd (a fake
// bd on PATH), from a dev container's .snagboat/beads export with no bd, or inferred from markdown in real git history.

const DAY = 86_400_000;
const repoRoot = path.join(__dirname, '..', '..', '..');
const fixture = path.join(repoRoot, 'src', 'test', 'fixtures', 'beads-export');

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

function tmp(prefix = 'snagboat-plan-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
// These tests run git (and a fake bd, a shell script) through PATH. On Windows (not supported,
// its CI job a signal only) sh names git by an MSYS path Node can't run, so they're POSIX only.
const gitTest = (name: string, fn: () => Promise<void> | void) => test(name, process.platform === 'win32' ? () => undefined : fn);
const originalPath = process.env.PATH;
/** sh, cat and the like for the fake bd: the system's own directories, without bd (it isn't installed there). */
const SYSTEM = ['/usr/bin', '/bin'].filter((d) => fs.existsSync(d) && !fs.existsSync(path.join(d, 'bd')));

/** A directory holding only git: PATH for "bd isn't installed". */
function gitOnlyDir(): string {
  const dir = tmp('snagboat-path-');
  fs.symlinkSync(realGit, path.join(dir, 'git'));
  return dir;
}

/** A fake bd that answers export and history from files in its own directory and logs each call. */
function fakeBd(issues: BeadsIssue[], history: Record<string, unknown[]>): { dir: string; calls: () => string[]; set: (issues: BeadsIssue[], history?: Record<string, unknown[]>) => void } {
  const dir = tmp('snagboat-bd-');
  const write = (list: BeadsIssue[], h: Record<string, unknown[]>) => {
    fs.writeFileSync(path.join(dir, 'issues.jsonl'), list.map((i) => JSON.stringify({ _type: 'issue', ...i }) + '\n').join(''));
    fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
    // bd lists newest first.
    for (const [id, events] of Object.entries(h)) fs.writeFileSync(path.join(dir, 'history', `${id}.json`), JSON.stringify([...events].reverse()));
  };
  write(issues, history);
  fs.writeFileSync(
    path.join(dir, 'bd'),
    [
      '#!/bin/sh',
      'd=$(dirname "$0")',
      'echo "$*" >> "$d/calls.log"',
      '[ "$1" = --readonly ] || { echo "not read-only" >&2; exit 3; }',
      'shift',
      'case "$1" in',
      '  export) cat "$d/issues.jsonl" ;;',
      '  history) if [ -f "$d/history/$2.json" ]; then cat "$d/history/$2.json"; else echo "no such issue" >&2; exit 1; fi ;;',
      '  *) exit 2 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  return {
    dir,
    calls: () => (fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n') : []),
    set: (list, h = {}) => {
      fs.rmSync(path.join(dir, 'calls.log'), { force: true });
      write(list, h);
    },
  };
}

/** A project folder in a real git repository, with a store. */
async function project(opts: { git?: boolean } = {}) {
  const root = tmp();
  const home = path.join(root, 'home');
  const dir = path.join(root, 'project');
  fs.mkdirSync(dir);
  let tick = Math.floor(Date.now() / 1000) - 5 * 86400;
  const git = (args: string[], who = 'Ann <ann@example.com>', at?: number) => {
    const [, name, email] = /^(.*) <(.*)>$/.exec(who)!;
    const t = at ?? (tick += 3600);
    return execFileSync(realGit, args, {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: `@${t}`, GIT_COMMITTER_DATE: `@${t}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  };
  if (opts.git !== false) git(['init', '-q', '-b', 'main']);
  /** Writes files and commits them; returns the commit's time (ISO). */
  const commit = (files: Record<string, string | null>, message: string, who?: string) => {
    for (const [f, text] of Object.entries(files)) {
      const p = path.join(dir, f);
      if (text === null) fs.rmSync(p);
      else {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text);
      }
    }
    git(['add', '-A']);
    const t = (tick += 3600);
    git(['commit', '-q', '-m', message], who, t);
    return new Date(t * 1000).toISOString();
  };
  const store = await openWorkspaceStore(home, { workspace: dir, folder: dir });
  const writer = new StoreWriter(home);
  const lines = () => readStoreRecordLines<PlanRecord>(path.join(store, PLAN_RECORDS_FILE));
  const current = () => foldStoreRecords(lines());
  const items = () => new Map(current().filter((r): r is PlanItemRecord => r.record === 'item').map((r) => [r.id, r]));
  const transitions = () => current().filter((r): r is TransitionRecord => r.record === 'transition');
  return { root, home, dir, store, writer, git, commit, lines, current, items, transitions };
}

const iso = (ms: number) => new Date(ms).toISOString();

function beadsFixture(now: number) {
  const t = (daysAgo: number) => iso(now - daysAgo * DAY);
  const issues: BeadsIssue[] = [
    { id: 'p-1', title: 'Epic', issue_type: 'epic', status: 'open', priority: 1, created_at: t(4), updated_at: t(4), owner: 'ann@example.com', created_by: 'ann' },
    {
      id: 'p-1.1',
      title: 'Do the thing',
      description: 'The secret plan',
      notes: 'Some notes',
      acceptance_criteria: 'It works',
      issue_type: 'chore',
      status: 'closed',
      priority: 2,
      assignee: 'ann',
      created_at: t(3),
      updated_at: t(1),
      started_at: t(2),
      closed_at: t(1),
      close_reason: 'Merged in #9',
      labels: ['b', 'a'],
      dependencies: [
        { issue_id: 'p-1.1', depends_on_id: 'p-1', type: 'parent-child' },
        { issue_id: 'p-1.1', depends_on_id: 'p-2', type: 'blocks' },
      ],
    },
    { id: 'p-2', title: 'A bug', issue_type: 'bug', status: 'in_progress', created_at: t(3), updated_at: t(2) },
  ];
  const state = JSON.stringify({ id: 'p-1.1', status: 'open', title: 'Do the thing', notes: '' });
  const history: Record<string, unknown[]> = {
    'p-1': [{ id: 'e-1', issue_id: 'p-1', event_type: 'created', actor: 'ann', created_at: t(4) }],
    'p-1.1': [
      { id: 'e-2', issue_id: 'p-1.1', event_type: 'created', actor: 'ann', created_at: t(3) },
      { id: 'e-3', issue_id: 'p-1.1', event_type: 'dependency_added', actor: 'ann', new_value: 'Added dependency: p-1.1 blocks p-2', created_at: t(3) },
      { id: 'e-4', issue_id: 'p-1.1', event_type: 'claimed', actor: 'agent', old_value: state, new_value: '{"assignee":"ann","status":"in_progress"}', created_at: t(2) },
      { id: 'e-5', issue_id: 'p-1.1', event_type: 'updated', actor: 'agent', old_value: state, new_value: '{"notes":"Some notes","title":"Do the thing"}', created_at: t(1.5) },
      { id: 'e-6', issue_id: 'p-1.1', event_type: 'label_added', actor: 'ann', comment: 'Added label: a', created_at: t(1.5) },
      { id: 'e-7', issue_id: 'p-1.1', event_type: 'closed', actor: 'ann', new_value: 'Merged in #9', created_at: t(1) },
      { id: 'e-8', issue_id: 'p-1.1', event_type: 'compacted', actor: 'bd', created_at: t(1) },
    ],
    'p-2': [{ id: 'e-9', issue_id: 'p-2', event_type: 'created', actor: 'bob', created_at: t(3) }],
  };
  return { issues, history };
}

/** Runs fn with PATH set to dirs (git always reachable through one of them). */
async function withPath<T>(dirs: string[], fn: () => Promise<T>): Promise<T> {
  process.env.PATH = dirs.join(path.delimiter);
  try {
    return await fn();
  } finally {
    process.env.PATH = originalPath;
  }
}

// ---- mapping -------------------------------------------------------------------------------

test('a bead as an item: kind, status, parent, blockedBy, labels, times, people, text only when captured', () => {
  const { issues } = beadsFixture(Date.parse('2026-11-10T00:00:00Z'));
  const item = beadsItem(issues[1], { text: true, now: '2026-11-10T00:00:00.000Z' });
  assert.strictEqual(item.kind, 'task'); // chore
  assert.strictEqual(item.status, 'done'); // closed
  assert.strictEqual(item.parent, 'p-1');
  assert.deepStrictEqual(item.blockedBy, ['p-2']);
  assert.deepStrictEqual(item.labels, ['a', 'b']);
  assert.strictEqual(item.closeReason, 'Merged in #9');
  assert.strictEqual(item.assignee, 'ann');
  assert.ok(item.created.endsWith('.000Z') && item.closed && item.started);
  assert.deepStrictEqual(item.text, { description: 'The secret plan', notes: 'Some notes', acceptance: 'It works' });
  assert.strictEqual(item.source, 'beads');
  assert.strictEqual(item.confidence, 'observed');
  assert.strictEqual(beadsItem(issues[1], { text: false, now: '' }).text, undefined);
  const epic = beadsItem(issues[0], { text: true, now: '' });
  assert.strictEqual(epic.kind, 'epic');
  assert.strictEqual(epic.owner, 'ann@example.com');
  assert.strictEqual(epic.createdBy, 'ann');
  assert.strictEqual(beadsItem(issues[2], { text: true, now: '' }).status, 'in_progress');
  assert.strictEqual(beadsItem({ id: 'x-1', issue_type: 'molecule', status: 'weird', created_at: 'bad', updated_at: '2026-11-01T00:00:00Z' }, { text: true, now: '' }).kind, 'task');
  assert.strictEqual(beadsItem({ id: 'x-1', status: 'deferred', updated_at: '2026-11-01T00:00:00Z' }, { text: true, now: '' }).status, 'deferred');
  assert.strictEqual(beadsItem({ id: 'x-1', status: 'weird', updated_at: '2026-11-01T00:00:00Z' }, { text: true, now: '' }).status, 'open');
});

test('bd audit events as transitions: statuses from the old and new state, field names only, the other bead, the label', () => {
  const { history } = beadsFixture(Date.parse('2026-11-10T00:00:00Z'));
  const ts = (history['p-1.1'] as Parameters<typeof beadsTransition>[0][]).map(beadsTransition);
  assert.strictEqual(ts[6], undefined, 'an event type it does not know is skipped');
  const [created, dep, claimed, updated, label, closed] = ts as TransitionRecord[];
  assert.strictEqual(created.type, 'created');
  assert.strictEqual(created.id, 'e-2');
  assert.strictEqual(dep.to, 'p-2');
  assert.deepStrictEqual([claimed.type, claimed.from, claimed.to, claimed.actor], ['claimed', 'open', 'in_progress', 'agent']);
  assert.deepStrictEqual(updated.fields, ['notes']);
  assert.ok(!JSON.stringify(updated).includes('Some notes'));
  assert.strictEqual(label.to, 'a');
  assert.deepStrictEqual([closed.type, closed.to], ['closed', 'done']);
  const removed = beadsTransition({ id: 'r', issue_id: 'snagboat-1', event_type: 'dependency_removed', new_value: 'Removed dependency on snagboat-2.1', created_at: '2026-11-01T00:00:00Z' })!;
  assert.strictEqual(removed.to, 'snagboat-2.1');
  const pc = beadsTransition({ id: 'r', issue_id: 'snagboat-1', event_type: 'dependency_added', new_value: 'Added dependency: snagboat-1 parent-child snagboat-9', created_at: '2026-11-01T00:00:00Z' })!;
  assert.strictEqual(pc.to, 'snagboat-9');
});

test('markdown: checklists and numbered steps are tasks; headings with tasks below are epics or milestones', () => {
  const text = [
    '# Plan',
    'Intro prose.',
    '## Background',
    'Nothing to do here.',
    '## Phase 1',
    '- [x] Write the parser',
    '- [ ] Write the job',
    '  - [x] Nested done',
    '- [~] Halfway',
    '- [-] Not doing this',
    '- plain bullet, not a task',
    '```',
    '- [ ] in a code block',
    '```',
    '## Steps',
    '1. **Schema:** types (done)',
    '2. ~~Old step~~',
    '3. Capture — built.',
    '4. Linker (blocked on 3)',
    '5. Sanitizer (planned, not started)',
    '6. Ship it 2026-12-01',
  ].join('\n');
  const items = parseMarkdownPlan('docs/plan.md', text);
  const byTitle = new Map(items.map((i) => [i.title, i]));
  assert.ok(!byTitle.has('Background'), 'a heading with no tasks is not an item');
  assert.ok(![...byTitle.keys()].some((t) => t.includes('code block')));
  assert.ok(![...byTitle.keys()].some((t) => t.includes('plain bullet')));
  assert.strictEqual(byTitle.get('Plan')!.kind, 'epic');
  assert.strictEqual(byTitle.get('Phase 1')!.kind, 'milestone');
  assert.strictEqual(byTitle.get('Phase 1')!.status, 'in_progress');
  assert.strictEqual(byTitle.get('Write the parser')!.status, 'done');
  assert.strictEqual(byTitle.get('Write the job')!.status, 'open');
  assert.strictEqual(byTitle.get('Nested done')!.parent, byTitle.get('Write the job')!.id);
  assert.strictEqual(byTitle.get('Write the job')!.parent, byTitle.get('Phase 1')!.id);
  assert.strictEqual(byTitle.get('Phase 1')!.parent, byTitle.get('Plan')!.id);
  assert.strictEqual(byTitle.get('Halfway')!.status, 'in_progress');
  assert.strictEqual(byTitle.get('Not doing this')!.status, 'dropped');
  assert.strictEqual(byTitle.get('Schema: types (done)')!.status, 'done');
  assert.strictEqual(byTitle.get('Old step')!.status, 'done');
  assert.strictEqual(byTitle.get('Capture — built.')!.status, 'done');
  assert.strictEqual(byTitle.get('Linker (blocked on 3)')!.status, 'blocked');
  assert.strictEqual(byTitle.get('Sanitizer (planned, not started)')!.status, 'open');
  assert.strictEqual(byTitle.get('Ship it 2026-12-01')!.date, '2026-12-01');
  assert.strictEqual(byTitle.get('Write the parser')!.heading, 'Plan > Phase 1');
  assert.strictEqual(byTitle.get('Write the parser')!.id, markdownItemId(['docs/plan.md', 'plan', 'phase 1', '- write the parser']));
  assert.strictEqual(byTitle.get('Nested done')!.id, markdownItemId(['docs/plan.md', 'plan', 'phase 1', '- write the job', '- nested done']));
  assert.strictEqual(byTitle.get('Schema: types (done)')!.id, markdownItemId(['docs/plan.md', 'plan', 'steps', '- schema: types']));
  assert.ok(items.every((i) => /^md-[0-9a-f]{12}$/.test(i.id)));

  // Marking a task done keeps its id; so does marking a heading done.
  const marked = parseMarkdownPlan('docs/plan.md', text.replace('- [ ] Write the job', '- [x] ~~Write the job~~ — done.').replace('## Phase 1', '## Phase 1 (done)'));
  const again = new Map(marked.map((i) => [i.id, i]));
  assert.strictEqual(again.get(byTitle.get('Write the job')!.id)!.status, 'done');
  assert.strictEqual(again.get(byTitle.get('Nested done')!.id)!.parent, byTitle.get('Write the job')!.id);
  assert.strictEqual(again.get(byTitle.get('Phase 1')!.id)!.title, 'Phase 1 (done)');
  // Rewording one makes a new item, and its children with it; the rest keep their ids.
  const reworded = parseMarkdownPlan('docs/plan.md', text.replace('- [ ] Write the job', '- [x] Write the plan job, reworded'));
  const ids = new Set(reworded.map((i) => i.id));
  assert.ok(!ids.has(byTitle.get('Write the job')!.id) && !ids.has(byTitle.get('Nested done')!.id));
  assert.ok(ids.has(byTitle.get('Write the parser')!.id) && ids.has(byTitle.get('Halfway')!.id));
  // The same file elsewhere is different items.
  assert.notStrictEqual(parseMarkdownPlan('docs/other.md', text)[0].id, items[0].id);
  // Repeated sibling headings get their own ids.
  const twice = parseMarkdownPlan('a.md', '## Notes\n- [ ] one\n## Notes\n- [ ] two\n');
  assert.strictEqual(new Set(twice.map((i) => i.id)).size, 4);
});

test('markdown ids: from the text, not the position; repeats numbered', () => {
  const ids = (text: string) => parseMarkdownPlan('p.md', text).map((i) => [i.title, i.id] as const);
  const v1 = ids('## A\n- [ ] one\n- [ ] two\n');
  const v2 = ids('## A\n- [ ] zero\n- [ ] one\n- [ ] two\n');
  assert.strictEqual(v2[2][1], v1[1][1], 'inserting above keeps one');
  assert.strictEqual(v2[3][1], v1[2][1], 'and two');
  const moved = ids('## A\n- [ ] two\n- [ ] one\n');
  assert.deepStrictEqual(new Set(moved.map(([, id]) => id)), new Set(v1.map(([, id]) => id)), 'reordering keeps ids');
  // The same text twice under one heading: distinct ids, the second numbered.
  const twins = parseMarkdownPlan('p.md', '## A\n- [ ] Same\n- [ ] same.\n');
  assert.notStrictEqual(twins[1].id, twins[2].id);
  assert.deepStrictEqual([twins[1].key, twins[2].key], ['same', 'same #2']);
  assert.strictEqual(twins[2].id, markdownItemId(['p.md', 'a', '- same #2']));
  // The same text under different parents: different items.
  const nested = parseMarkdownPlan('p.md', '## A\n- [ ] x\n  - [ ] same\n- [ ] y\n  - [ ] same\n');
  assert.strictEqual(new Set(nested.map((i) => i.id)).size, 5);
  // Status marks and notes aren't part of the text.
  assert.strictEqual(taskKey('~~Write the job~~ (done)'), 'write the job');
  assert.strictEqual(taskKey('**Done:** the thing.'), 'the thing');
  assert.strictEqual(taskKey('Capture — built.'), 'capture');
  assert.strictEqual(taskKey('Linker (blocked on 3)'), 'linker');
  assert.strictEqual(taskKey('Fix it  (see #12) ✅'), 'fix it (see #12)');
});

test('textStatus: markers, not prose', () => {
  assert.strictEqual(textStatus('Something we have done before'), undefined);
  assert.strictEqual(textStatus('**Done:** the thing'), 'done');
  assert.strictEqual(textStatus('**Move the files — done.** (more)'), 'done');
  assert.strictEqual(textStatus('Goal tracking (designed 2026-11-16; built, its last step later)'), 'done');
  assert.strictEqual(textStatus('Refactor (in progress)'), 'in_progress');
  assert.strictEqual(textStatus('Thing ✅'), 'done');
  assert.strictEqual(textStatus('Later (deferred)'), 'deferred');
});

test('plans setting: a path or paths, relative and inside the project', () => {
  assert.deepStrictEqual(plansSetting('plans'), ['plans']);
  assert.deepStrictEqual(plansSetting(['docs/plan.md', '/abs', '../out', 3]), ['docs/plan.md']);
  assert.strictEqual(plansSetting([]), undefined);
  assert.strictEqual(plansSetting(undefined), undefined);
});

// ---- the job: beads ------------------------------------------------------------------------

gitTest('beads with bd on PATH: items and transitions, history only for changed beads, idempotent, deleted beads dropped', async () => {
  const p = await project();
  fs.mkdirSync(path.join(p.dir, '.beads'));
  p.commit({ 'docs/plan.md': '# Plan\n- [ ] markdown task\n' }, 'docs');
  const now = Date.now();
  const { issues, history } = beadsFixture(now);
  const bd = fakeBd(issues, history);
  const gitDir = gitOnlyDir();
  assert.strictEqual(findOnPath('bd', bd.dir), path.join(bd.dir, 'bd'));
  assert.strictEqual(findOnPath('bd', gitDir), undefined);
  await withPath([bd.dir, gitDir, ...SYSTEM], async () => {
    const job = new PlanRecordsJob(p.home, p.writer);
    const n = await job.run();
    assert.strictEqual(n, 3 + 8, 'three items, eight transitions');
    assert.deepStrictEqual(job.sourceOf(p.dir), { source: 'bd', detail: path.join(bd.dir, 'bd') });
    const items = p.items();
    assert.deepStrictEqual([...items.keys()].sort(), ['p-1', 'p-1.1', 'p-2'], 'beads win: no markdown items');
    assert.strictEqual(items.get('p-1.1')!.text?.description, 'The secret plan');
    assert.deepStrictEqual(p.transitions().map((t) => t.id).sort(), ['e-1', 'e-2', 'e-3', 'e-4', 'e-5', 'e-6', 'e-7', 'e-9']);
    assert.ok(bd.calls().every((c) => c.startsWith('--readonly ')));
    assert.strictEqual(bd.calls().filter((c) => c.includes('history')).length, 3);

    // Again: bd export only, nothing appended.
    bd.set(issues, history);
    assert.strictEqual(await job.run({ force: true }), 0);
    assert.deepStrictEqual(bd.calls(), ['--readonly export']);

    // One bead changes: only its history is read; its item and its new transition are appended.
    const changed = issues.map((i) => (i.id === 'p-2' ? { ...i, status: 'closed', updated_at: iso(now - 0.5 * DAY), closed_at: iso(now - 0.5 * DAY) } : i));
    const h2 = { ...history, 'p-2': [...history['p-2'], { id: 'e-10', issue_id: 'p-2', event_type: 'closed', actor: 'bob', created_at: iso(now - 0.5 * DAY) }] };
    bd.set(changed, h2);
    assert.strictEqual(await job.run({ force: true }), 2);
    assert.deepStrictEqual(bd.calls(), ['--readonly export', '--readonly history p-2 --events --json']);
    assert.strictEqual(p.items().get('p-2')!.status, 'done');

    // A bead whose history fails waits for the next run.
    const added = [...changed, { id: 'p-3', title: 'New', status: 'open', created_at: iso(now), updated_at: iso(now) }];
    bd.set(added, h2);
    assert.strictEqual(await job.run({ force: true }), 0);
    assert.ok(!p.items().has('p-3'));
    bd.set(added, { ...h2, 'p-3': [{ id: 'e-11', issue_id: 'p-3', event_type: 'created', actor: 'ann', created_at: iso(now) }] });
    assert.strictEqual(await job.run({ force: true }), 2);
    assert.ok(p.items().has('p-3'));

    // A bead deleted from bd is kept, as dropped.
    bd.set(added.filter((i) => i.id !== 'p-3'), h2);
    assert.strictEqual(await job.run({ force: true }), 1);
    assert.strictEqual(p.items().get('p-3')!.status, 'dropped');
    assert.strictEqual(await job.run({ force: true }), 0);
    job.dispose();
  });
});

gitTest('beads: captureContent off stores no text; outcomes.git or collect off stops the job', async () => {
  const p = await project();
  fs.mkdirSync(path.join(p.dir, '.beads'));
  const { issues, history } = beadsFixture(Date.now());
  const bd = fakeBd(issues, history);
  saveConfig(p.home, { version: 1, defaults: {}, projects: { [p.dir]: { captureContent: false } } });
  const job = new PlanRecordsJob(p.home, p.writer, { bd: path.join(bd.dir, 'bd') });
  await job.run();
  assert.ok(p.items().size === 3 && [...p.items().values()].every((i) => i.text === undefined));
  assert.ok(!fs.readFileSync(path.join(p.store, PLAN_RECORDS_FILE), 'utf8').includes('secret'));

  for (const off of [{ 'outcomes.git': false }, { collect: false }]) {
    const q = await project();
    fs.mkdirSync(path.join(q.dir, '.beads'));
    saveConfig(q.home, { version: 1, defaults: {}, projects: { [q.dir]: off } });
    assert.strictEqual(await new PlanRecordsJob(q.home, q.writer, { bd: path.join(bd.dir, 'bd') }).run(), 0);
    assert.strictEqual(q.lines().length, 0);
  }
});

gitTest('beads from a dev container export with no bd on PATH: fresh or stale, worktrees read the main tree\'s', async () => {
  const p = await project();
  fs.mkdirSync(path.join(p.dir, '.beads'));
  p.commit({ 'a.txt': 'a\n' }, 'start');
  fs.cpSync(fixture, beadsExportDir(p.dir), { recursive: true });
  // A second working tree, with its own store, sees the main tree's export.
  const wt = path.join(p.root, 'wt');
  p.git(['worktree', 'add', '-q', '-b', 'side', wt]);
  const wtStore = await openWorkspaceStore(p.home, { workspace: wt, folder: wt });
  const logs: string[] = [];
  await withPath([gitOnlyDir(), ...SYSTEM], async () => {
    // The fixture's exporter last ran 2026-11-03T10:00:00Z.
    const job = new PlanRecordsJob(p.home, p.writer, { clock: () => Date.parse('2026-11-03T10:01:00Z'), log: (l) => logs.push(l) });
    await job.run();
    assert.deepStrictEqual(job.sourceOf(p.dir), { source: 'export', fresh: true, lastRun: '2026-11-03T10:00:00.000Z', detail: beadsExportDir(p.dir) });
    const items = p.items();
    assert.deepStrictEqual([...items.keys()], ['demo-1', 'demo-1.1', 'demo-2']);
    assert.strictEqual(items.get('demo-1.1')!.parent, 'demo-1');
    assert.strictEqual(items.get('demo-1.1')!.kind, 'task');
    assert.strictEqual(items.get('demo-2')!.kind, 'bug');
    assert.deepStrictEqual(p.transitions().map((t) => t.id).sort(), ['e1', 'e2', 'e3', 'f1']);
    const wtLines = readStoreRecordLines<PlanRecord>(path.join(wtStore, PLAN_RECORDS_FILE));
    assert.deepStrictEqual(foldStoreRecords(wtLines).map((r) => r.id).sort(), foldStoreRecords(p.lines()).map((r) => r.id).sort());
    assert.strictEqual(await job.run({ force: true }), 0);

    // Stale: still read, and said.
    const later = new PlanRecordsJob(p.home, p.writer, { clock: () => Date.parse('2026-11-04T10:00:00Z'), log: (l) => logs.push(l) });
    await later.run();
    assert.strictEqual(later.sourceOf(p.dir)!.fresh, false);
    assert.ok(logs.some((l) => l.includes('stale')));

    // .beads with no bd and no export: nothing, and no markdown either.
    fs.rmSync(beadsExportDir(p.dir), { recursive: true });
    fs.mkdirSync(path.join(p.dir, 'docs'));
    p.commit({ 'docs/plan.md': '- [ ] task\n' }, 'docs');
    const none = new PlanRecordsJob(p.home, p.writer, { log: (l) => logs.push(l) });
    assert.strictEqual(await none.run(), 0);
    assert.strictEqual(none.sourceOf(p.dir)!.source, 'none');
    assert.ok(logs.some((l) => l.includes("bd isn't installed")));
  });
});

// ---- the job: markdown ---------------------------------------------------------------------

gitTest('markdown only: items from docs at HEAD, status changes become transitions at the commit that made them, by its author', async () => {
  const p = await project();
  const v1 = ['# Roadmap', '## Phase 1', '- [ ] Parser', '- [ ] Job', '- [ ] Docs', ''].join('\n');
  const c1 = p.commit({ 'docs/roadmap.md': v1, 'docs/README.md': '- [ ] not a plan\n', 'README.md': '- [ ] nor this\n', 'notes.md': '- [ ] outside docs\n' }, 'plan', 'Ann <ann@example.com>');
  await withPath([gitOnlyDir(), ...SYSTEM], async () => {
    const job = new PlanRecordsJob(p.home, p.writer);
    await job.run();
    assert.deepStrictEqual(job.sourceOf(p.dir), { source: 'markdown' });
    let items = [...p.items().values()];
    assert.deepStrictEqual(items.map((i) => i.title).sort(), ['Docs', 'Job', 'Parser', 'Phase 1', 'Roadmap']);
    assert.ok(items.every((i) => i.source === 'markdown' && i.confidence === 'inferred' && i.from?.file === 'docs/roadmap.md' && i.updated === c1));
    assert.strictEqual(items.find((i) => i.title === 'Parser')!.from!.heading, 'Roadmap > Phase 1');
    assert.strictEqual(p.transitions().length, 0, 'first sight is no transition');
    const parser = items.find((i) => i.title === 'Parser')!.id;
    const job2 = items.find((i) => i.title === 'Job')!.id;
    const docs = items.find((i) => i.title === 'Docs')!.id;
    const phase = items.find((i) => i.title === 'Phase 1')!.id;

    // Bob checks off Parser and rewords Job, then a new task appears; a commit to another file changes nothing.
    const v2a = v1.replace('- [ ] Parser', '- [x] Parser').replace('- [ ] Job', '- [ ] The plan job');
    const c2 = p.commit({ 'docs/roadmap.md': v2a }, 'progress', 'Bob <bob@example.com>');
    const v2 = v2a.replace('- [ ] Docs', '- [ ] Docs\n- [ ] Tests');
    const c2b = p.commit({ 'docs/roadmap.md': v2 }, 'tests', 'Bob <bob@example.com>');
    p.commit({ 'src.txt': 'x\n' }, 'unrelated', 'Cy <cy@example.com>');
    await job.run({ force: true });
    items = [...p.items().values()];
    const byId = p.items();
    assert.strictEqual(byId.get(parser)!.status, 'done');
    assert.strictEqual(byId.get(parser)!.closed, c2);
    assert.strictEqual(byId.get(parser)!.created, c1);
    // Reworded: a snapshot can't tell, so the old item is dropped and a new one made.
    assert.strictEqual(byId.get(job2)!.status, 'dropped');
    assert.ok(items.some((i) => i.title === 'The plan job' && i.id !== job2 && i.status === 'open'));
    assert.strictEqual(byId.get(phase)!.status, 'in_progress');
    const ts = p.transitions();
    const closed = ts.find((t) => t.item === parser)!;
    assert.deepStrictEqual([closed.type, closed.from, closed.to, closed.at, closed.actor, closed.confidence], ['closed', 'open', 'done', c2, 'Bob <bob@example.com>', 'inferred']);
    assert.ok(/^md-t-[0-9a-f]{16}$/.test(closed.id));
    const phaseT = ts.find((t) => t.item === phase)!;
    assert.deepStrictEqual([phaseT.type, phaseT.from, phaseT.to, phaseT.at], ['status_changed', 'open', 'in_progress', c2b], 'a heading changes with its latest item');
    const tests = items.find((i) => i.title === 'Tests')!;
    assert.deepStrictEqual(ts.filter((t) => t.item === tests.id).map((t) => [t.type, t.to, t.at]), [['created', 'open', c2b]]);

    // Idempotent.
    const before = p.lines().length;
    assert.strictEqual(await job.run({ force: true }), 0);
    assert.strictEqual(await new PlanRecordsJob(p.home, p.writer).run(), 0, 'a fresh job (a restarted core) appends nothing either');
    assert.strictEqual(p.lines().length, before);

    // Reopened by Cy, then an open item is removed: dropped at that commit.
    const v3 = v2.replace('- [x] Parser', '- [ ] Parser').replace('- [ ] Docs\n', '');
    const c3 = p.commit({ 'docs/roadmap.md': v3 }, 'rethink', 'Cy <cy@example.com>');
    await job.run({ force: true });
    const after = p.transitions();
    const reopened = after.find((t) => t.item === parser && t.type === 'reopened')!;
    assert.deepStrictEqual([reopened.from, reopened.to, reopened.at, reopened.actor], ['done', 'open', c3, 'Cy <cy@example.com>']);
    // Docs is dropped; Tests, below it, keeps its id.
    assert.strictEqual(p.items().get(docs)!.status, 'dropped');
    assert.strictEqual(after.find((t) => t.item === docs && t.to === 'dropped')!.at, c3);
    assert.strictEqual(p.items().get(tests.id)!.status, 'open');
    assert.strictEqual(p.items().get(tests.id)!.title, 'Tests');
  });
});

gitTest('markdown ids in the snapshot: inserting above, rewording, marking done', async () => {
  const p = await project();
  const v1 = ['# Plan', '- [ ] Alpha', '- [ ] Beta', '- [ ] Gamma', ''].join('\n');
  p.commit({ 'docs/plan.md': v1 }, 'plan');
  await withPath([gitOnlyDir(), ...SYSTEM], async () => {
    const job = new PlanRecordsJob(p.home, p.writer);
    await job.run();
    const id = (title: string) => [...p.items().values()].find((i) => i.title === title)?.id;
    const alpha = id('Alpha')!;
    const beta = id('Beta')!;
    const gamma = id('Gamma')!;

    // Inserting a task above the others: their ids stay, the only transition is the new one's creation.
    const v2 = v1.replace('- [ ] Alpha', '- [ ] Zero\n- [ ] Alpha');
    const c2 = p.commit({ 'docs/plan.md': v2 }, 'insert');
    await job.run({ force: true });
    assert.deepStrictEqual([id('Alpha'), id('Beta'), id('Gamma')], [alpha, beta, gamma]);
    assert.deepStrictEqual(p.transitions().map((t) => [t.item, t.type, t.at]), [[id('Zero'), 'created', c2]]);
    assert.ok([...p.items().values()].every((i) => i.status !== 'dropped'));

    // Marking one done keeps its id, with a closed transition.
    const v3 = v2.replace('- [ ] Beta', '- [x] ~~Beta~~ — done.');
    const c3 = p.commit({ 'docs/plan.md': v3 }, 'done', 'Bob <bob@example.com>');
    await job.run({ force: true });
    assert.strictEqual(p.items().get(beta)!.status, 'done');
    assert.deepStrictEqual(p.transitions().filter((t) => t.item === beta).map((t) => [t.type, t.from, t.to, t.at, t.actor]), [['closed', 'open', 'done', c3, 'Bob <bob@example.com>']]);

    // Rewording one: the snapshot can't tell, so it's the old item dropped and a new one created.
    const c4 = p.commit({ 'docs/plan.md': v3.replace('- [ ] Gamma', '- [ ] Gamma, reworded') }, 'reword');
    await new PlanRecordsJob(p.home, p.writer).run();
    const reworded = id('Gamma, reworded')!;
    assert.notStrictEqual(reworded, gamma);
    assert.strictEqual(p.items().get(gamma)!.status, 'dropped');
    const at4 = p.transitions().filter((t) => t.at === c4).map((t) => `${t.item === gamma ? 'old' : t.item === reworded ? 'new' : t.item}:${t.type}:${t.to}`).sort();
    assert.deepStrictEqual(at4, ['new:created:open', 'old:status_changed:dropped']);
  });
});

gitTest('markdown: items stored under the old position ids are replaced, not left open', async () => {
  const p = await project();
  const c1 = p.commit({ 'docs/plan.md': '# Plan\n- [ ] Alpha\n- [x] Beta\n' }, 'plan');
  // What an earlier version stored: position ids, and a transition for one.
  const old = (n: number, title: string, status: 'open' | 'done') => ({
    record: 'item', version: 1, id: markdownItemId(['docs/plan.md', 'plan', `#${n}`]), kind: 'task', title, status, labels: [], created: c1, updated: c1,
    source: 'markdown', from: { file: 'docs/plan.md', heading: 'Plan' }, confidence: 'inferred',
  });
  const oldAlpha = old(1, 'Alpha', 'open');
  await p.writer.appendRecords(path.join(p.store, PLAN_RECORDS_FILE), [
    oldAlpha as PlanItemRecord,
    old(2, 'Beta', 'done') as PlanItemRecord,
    { record: 'transition', version: 1, id: 'md-t-0000000000000000', item: oldAlpha.id, at: c1, type: 'created', to: 'open', actor: 'Ann <ann@example.com>', confidence: 'inferred' },
  ]);
  await withPath([gitOnlyDir(), ...SYSTEM], async () => {
    const lines: string[] = [];
    await new PlanRecordsJob(p.home, p.writer, { log: (l) => lines.push(l) }).run();
    assert.ok(lines.some((l) => l.includes('replaced 2 task(s)')));
  });
  const items = [...p.items().values()];
  assert.deepStrictEqual(items.map((i) => `${i.title}:${i.status}`).sort(), ['Alpha:open', 'Beta:done', 'Plan:in_progress']);
  assert.ok(!items.some((i) => i.id === oldAlpha.id));
  assert.ok(!p.lines().some((r) => r.id === oldAlpha.id || (r.record === 'transition' && r.item === oldAlpha.id)), 'their lines are gone');
  assert.strictEqual(p.transitions().length, 0, 'the file is first seen again');
});

gitTest('markdown: the plans setting names the files, README included when named', async () => {
  const p = await project();
  p.commit({ 'docs/design.md': '- [ ] in docs\n', 'plans/q1.md': '# Q1\n1. First\n2. Second (done)\n', 'README.md': '- [ ] named readme\n' }, 'plans');
  saveConfig(p.home, { version: 1, defaults: {}, projects: { [p.dir]: { plans: ['plans', 'README.md'] } } });
  await withPath([gitOnlyDir(), ...SYSTEM], async () => {
    await new PlanRecordsJob(p.home, p.writer).run();
  });
  const titles = [...p.items().values()].map((i) => `${i.from!.file}:${i.title}:${i.status}`).sort();
  assert.deepStrictEqual(titles, ['README.md:named readme:open', 'plans/q1.md:First:open', 'plans/q1.md:Q1:in_progress', 'plans/q1.md:Second (done):done']);
});

gitTest('markdown: a folder with no git, or no commits, records nothing', async () => {
  const p = await project({ git: false });
  fs.mkdirSync(path.join(p.dir, 'docs'));
  fs.writeFileSync(path.join(p.dir, 'docs', 'plan.md'), '- [ ] task\n');
  await withPath([gitOnlyDir(), ...SYSTEM], async () => {
    assert.strictEqual(await new PlanRecordsJob(p.home, p.writer).run(), 0);
    const q = await project();
    assert.strictEqual(await new PlanRecordsJob(q.home, q.writer).run(), 0);
  });
});

// ---- cadence and retention -----------------------------------------------------------------

gitTest('cadence: hourly when idle, every tick while a session is active, one run at a time', async () => {
  const p = await project();
  p.commit({ 'docs/plan.md': '- [ ] one\n' }, 'plan');
  let now = Date.now();
  let calls = 0;
  const git = async (args: string[], cwd: string) => {
    if (args[0] === 'ls-tree') calls++;
    return execFileSync(realGit, args, { cwd }).toString();
  };
  const job = new PlanRecordsJob(p.home, p.writer, { clock: () => now, git, bd: null });
  const [a, b] = [job.run(), job.run()];
  assert.strictEqual(a, b, 'a second run joins the first');
  await a;
  assert.strictEqual(calls, 1);
  now += 10 * 60_000;
  await job.run();
  assert.strictEqual(calls, 1, 'idle: not due');
  await p.writer.write([{ eventId: 'e1', sessionId: 's', agent: 'claude-code', ts: new Date(now).toISOString(), kind: 'tool_call', status: 'success', workspace: p.dir, raw: { adapter: 't', ref: 'r' } }]);
  await job.run();
  assert.strictEqual(calls, 2, 'active: due');
  now += PLAN_RECORDS_IDLE_MS + 16 * 60_000;
  await job.run();
  assert.strictEqual(calls, 3, 'an hour on: due');
  job.dispose();
});

gitTest('retention: closed items and transitions older than rawDays go and are not put back; item text follows textDays', async () => {
  const p = await project();
  fs.mkdirSync(path.join(p.dir, '.beads'));
  const now = Date.now();
  const { issues, history } = beadsFixture(now);
  // An old closed bead, and an open one updated long ago.
  const old = iso(now - 200 * DAY);
  const oldIssues = [
    ...issues,
    { id: 'p-old', title: 'Old', status: 'closed', description: 'old text', created_at: old, updated_at: old, closed_at: old },
    { id: 'p-open', title: 'Still open', status: 'open', description: 'stale text', created_at: old, updated_at: iso(now - 40 * DAY) },
  ];
  const oldHistory = {
    ...history,
    'p-old': [{ id: 'e-old', issue_id: 'p-old', event_type: 'created', actor: 'ann', created_at: old }],
    'p-open': [{ id: 'e-open', issue_id: 'p-open', event_type: 'created', actor: 'ann', created_at: old }],
  };
  const bd = fakeBd(oldIssues, oldHistory);
  const job = new PlanRecordsJob(p.home, p.writer, { bd: path.join(bd.dir, 'bd') });
  await job.run();
  let items = p.items();
  assert.ok(!items.has('p-old'), 'closed before rawDays: not appended');
  assert.ok(!bd.calls().includes('--readonly history p-old --events --json'), 'nor its history read');
  assert.ok(items.has('p-open'), 'an open item stays whatever its age');
  assert.strictEqual(items.get('p-open')!.text, undefined, 'updated before textDays: no text');
  assert.ok(!p.transitions().some((t) => t.id === 'e-open'), 'its old transition is past rawDays');
  assert.ok(items.get('p-1.1')!.text);

  // Records already stored that aged out, and text past textDays, go with retention.
  const file = path.join(p.store, PLAN_RECORDS_FILE);
  await appendStoreRecords(file, [
    { record: 'item', version: 1, id: 'p-aged', kind: 'task', title: 'aged', status: 'done', labels: [], created: old, updated: old, closed: old, source: 'beads', confidence: 'observed' },
    { record: 'transition', version: 1, id: 't-aged', item: 'p-aged', at: old, type: 'closed', actor: 'ann', confidence: 'observed' },
    // p-open as stored before its text aged past textDays.
    { ...items.get('p-open')!, text: { description: 'stale text' } },
  ]);
  await p.writer.runRetention();
  const left = p.lines();
  assert.ok(!left.some((r) => r.id === 'p-aged' || r.id === 't-aged'));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('stale'));
  assert.ok(left.some((r) => r.id === 'p-open'), 'the item stays, without its text');
  assert.strictEqual(p.items().get('p-1.1')!.text?.description, 'The secret plan', 'recent text stays');
  assert.strictEqual(await job.run({ force: true }), 0, 'nothing put back');
  items = p.items();
  assert.ok(!items.has('p-aged'));
});

async function main() {
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
