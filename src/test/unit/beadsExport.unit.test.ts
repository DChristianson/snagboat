import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { beadsExportDir, readBeadsExport } from '../../core/beadsExport';
import { BEADS_EXPORT_SCRIPT } from '../../core/beadsExportScript';

// Beads exported by a dev container (bead snagboat-93b.10.8): the container's beads-export.sh writes bd export and
// bd history to .snagboat/beads/, and the core reads them back.

const repo = path.join(__dirname, '..', '..', '..');
const fixture = path.join(repo, 'src', 'test', 'fixtures', 'beads-export');
const script = path.join(repo, '.devcontainer', 'beads-export.sh');

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-beads-')));
}

/** A project folder with the fixture export in .snagboat/beads. */
function exported(): string {
  const folder = tmp();
  fs.cpSync(fixture, beadsExportDir(folder), { recursive: true });
  return folder;
}

test('the embedded script is .devcontainer/beads-export.sh', () => {
  // A Windows checkout may have turned the script's line endings into CRLF.
  assert.strictEqual(BEADS_EXPORT_SCRIPT, fs.readFileSync(script, 'utf8').replace(/\r\n/g, '\n'), 'copy .devcontainer/beads-export.sh into src/core/beadsExportScript.ts');
});

test('reads issues and each bead\'s events, oldest first, and the status', () => {
  const folder = exported();
  const r = readBeadsExport(folder, { now: new Date('2026-11-03T10:02:00Z') })!;
  assert.deepStrictEqual(r.issues.map((i) => i.id), ['demo-1', 'demo-1.1', 'demo-2']);
  assert.strictEqual(r.issues[0].close_reason, 'Merged in #1');
  assert.strictEqual(r.issues[1].dependencies![0].depends_on_id, 'demo-1');
  assert.deepStrictEqual(r.events.get('demo-1')!.map((e) => e.event_type), ['created', 'claimed', 'closed']);
  assert.deepStrictEqual(r.events.get('demo-1.1')!.map((e) => e.id), ['f1']);
  assert.ok(!r.events.has('demo-2'));
  assert.deepStrictEqual(r.missingHistory, ['demo-2']);
  assert.strictEqual(r.status!.bd_version, '1.3.4');
  assert.strictEqual(r.lastRun!.toISOString(), '2026-11-03T10:00:00.000Z');
  assert.strictEqual(r.fresh, true);
  assert.deepStrictEqual(r.problems, []);
});

test('freshness: stale after three intervals (at least 5 minutes), or as asked', () => {
  const folder = exported();
  assert.strictEqual(readBeadsExport(folder, { now: new Date('2026-11-03T10:05:00Z') })!.fresh, true);
  assert.strictEqual(readBeadsExport(folder, { now: new Date('2026-11-03T10:05:01Z') })!.fresh, false);
  assert.strictEqual(readBeadsExport(folder, { now: new Date('2026-11-03T10:01:00Z'), staleAfterMs: 30_000 })!.fresh, false);
  // No status: issues.jsonl's time stands in.
  fs.rmSync(path.join(beadsExportDir(folder), 'status.json'));
  const r = readBeadsExport(folder)!;
  assert.strictEqual(r.status, undefined);
  assert.strictEqual(r.fresh, true);
});

test('historyFor reads only those beads\' history', () => {
  const r = readBeadsExport(exported(), { historyFor: ['demo-1.1'] })!;
  assert.deepStrictEqual([...r.events.keys()], ['demo-1.1']);
  assert.strictEqual(r.issues.length, 3);
});

test('no export: undefined', () => {
  assert.strictEqual(readBeadsExport(tmp()), undefined);
});

test('untrusted: links refused, bad lines and other beads\' events skipped and counted', () => {
  const folder = exported();
  const dir = beadsExportDir(folder);
  fs.appendFileSync(path.join(dir, 'issues.jsonl'), 'not json\n{"_type":"memory","id":"m1"}\n{"id":"../etc"}\n{"_type":"issue","id":"demo-1"}\n');
  const elsewhere = path.join(tmp(), 'x.json');
  fs.writeFileSync(elsewhere, '[]');
  fs.symlinkSync(elsewhere, path.join(dir, 'history', 'demo-2.json'));
  const h = path.join(dir, 'history', 'demo-1.1.json');
  fs.writeFileSync(h, JSON.stringify([...JSON.parse(fs.readFileSync(h, 'utf8')), { id: 'x', issue_id: 'demo-1', event_type: 'closed', created_at: '2026-11-02T09:00:00Z' }]));
  const r = readBeadsExport(folder)!;
  assert.deepStrictEqual(r.issues.map((i) => i.id), ['demo-1', 'demo-1.1', 'demo-2']);
  assert.deepStrictEqual(r.events.get('demo-1.1')!.map((e) => e.id), ['f1']);
  assert.deepStrictEqual(r.missingHistory, ['demo-2']);
  assert.ok(r.problems.some((p) => /skipped 4 line\(s\)/.test(p)), r.problems.join('\n'));
  assert.ok(r.problems.some((p) => /refused .*demo-2\.json is a symlink/.test(p)), r.problems.join('\n'));
  assert.ok(r.problems.some((p) => /skipped 1 event\(s\)/.test(p)), r.problems.join('\n'));

  const linked = tmp();
  fs.mkdirSync(path.join(linked, '.snagboat'));
  fs.symlinkSync(dir, beadsExportDir(linked));
  const refused = readBeadsExport(linked)!;
  assert.deepStrictEqual(refused.issues, []);
  assert.match(refused.problems[0], /is a symlink/);
});

// The script itself, against a stand-in bd that serves a JSONL file and logs what it's asked.

function fakeBd(root: string): { bin: string; issues: string; calls: string } {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const issues = path.join(root, 'bd-issues.jsonl');
  const calls = path.join(root, 'bd-calls.log');
  fs.writeFileSync(
    path.join(bin, 'bd'),
    [
      '#!/bin/sh',
      `echo "$*" >> '${calls}'`,
      '[ "$1" = --readonly ] && shift',
      'case $1 in',
      '  version) echo "bd version 9.8.7 (test)" ;;',
      `  export) cat '${issues}' ;;`,
      '  history) [ "$2" = broken ] && { echo "no such bead" >&2; exit 1; }; printf \'[{"id":"h-%s","issue_id":"%s","event_type":"created","created_at":"2026-11-01T00:00:00Z"}]\\n\' "$2" "$2" ;;',
      '  *) exit 1 ;;',
      'esac',
    ].join('\n') + '\n',
    { mode: 0o755 }
  );
  return { bin, issues, calls };
}

const issue = (id: string, updated: string) => JSON.stringify({ _type: 'issue', id, title: id, status: 'open', updated_at: updated, dependencies: [{ issue_id: id, depends_on_id: 'x', created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' }] });

function runScript(folder: string, bin: string, mode = 'once') {
  const r = spawnSync('sh', [script, mode, folder], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, timeout: 30_000 });
  assert.strictEqual(r.status, 0, r.stderr);
  return r;
}

const historyCalls = (calls: string) => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '').split('\n').filter((l) => / history /.test(` ${l} `)).map((l) => l.split(' ')[2]);

test('beads-export.sh: exports, fetches history only for changed beads, drops deleted ones, reports status', () => {
  const root = tmp();
  const folder = path.join(root, 'proj');
  fs.mkdirSync(path.join(folder, '.beads'), { recursive: true });
  const bd = fakeBd(root);
  fs.writeFileSync(bd.issues, [issue('p-1', '2026-11-01T00:00:00Z'), issue('p-2', '2026-11-01T00:00:00Z'), issue('p-3', '2026-11-01T00:00:00Z')].join('\n') + '\n');

  runScript(folder, bd.bin);
  const dir = beadsExportDir(folder);
  assert.deepStrictEqual(historyCalls(bd.calls), ['p-1', 'p-2', 'p-3']);
  assert.ok(fs.readFileSync(bd.calls, 'utf8').split('\n').filter(Boolean).every((l) => l.startsWith('--readonly ') || l === 'version'), 'only reads bd');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'issues.jsonl'), 'utf8'), fs.readFileSync(bd.issues, 'utf8'));
  assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n')[1], '*');
  let status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.strictEqual(status.ok, true);
  assert.strictEqual(status.issues, 3);
  assert.strictEqual(status.histories_written, 3);
  assert.strictEqual(status.bd_version, '9.8.7');
  assert.strictEqual(status.last_error, null);
  assert.ok(!fs.existsSync(path.join(dir, 'export.lock')), 'the lock goes when it exits');

  // Nothing changed: no history fetched.
  fs.writeFileSync(bd.calls, '');
  runScript(folder, bd.bin);
  assert.deepStrictEqual(historyCalls(bd.calls), []);

  // p-2 changed, p-3 deleted, p-4 new, and one bd can't give the history of: retried next time.
  fs.writeFileSync(bd.issues, [issue('p-1', '2026-11-01T00:00:00Z'), issue('p-2', '2026-11-05T00:00:00Z'), issue('p-4', '2026-11-05T00:00:00Z'), issue('broken', '2026-11-05T00:00:00Z')].join('\n') + '\n');
  runScript(folder, bd.bin);
  assert.deepStrictEqual(historyCalls(bd.calls).sort(), ['broken', 'p-2', 'p-4']);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'history')).sort(), ['p-1.json', 'p-2.json', 'p-4.json']);
  status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.strictEqual(status.ok, false);
  assert.strictEqual(status.history_failures, 1);
  assert.match(status.last_error, /bd history broken failed: no such bead/);
  fs.writeFileSync(bd.calls, '');
  runScript(folder, bd.bin);
  assert.deepStrictEqual(historyCalls(bd.calls), ['broken']);

  // What it wrote reads back.
  const r = readBeadsExport(folder)!;
  assert.deepStrictEqual(r.issues.map((i) => i.id), ['p-1', 'p-2', 'p-4', 'broken']);
  assert.deepStrictEqual(r.events.get('p-2')!.map((e) => e.id), ['h-p-2']);
  assert.ok(r.fresh);
  assert.ok(fs.readFileSync(path.join(dir, 'export.log'), 'utf8').includes('wrote 2 history file(s), 1 failed'));
});

// The script runs only in a Linux dev container. Its lock reads POSIX pids and /proc, and
// Windows (not supported, its CI job a signal only) has neither /bin/sh nor those pids.
const posixOnly = process.platform === 'win32';

test('beads-export.sh: quiet without bd or .beads, one copy per folder, never through a link', () => {
  if (posixOnly) return;
  const root = tmp();
  const folder = path.join(root, 'proj');
  fs.mkdirSync(folder);
  // No bd on PATH at all: exits at once, writes nothing.
  const r = spawnSync('/bin/sh', [script, 'once', folder], { encoding: 'utf8', env: { PATH: path.join(root, 'nothing') }, timeout: 10_000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(folder, '.snagboat')));

  const bd = fakeBd(root);
  fs.writeFileSync(bd.issues, issue('p-1', '2026-11-01T00:00:00Z') + '\n');
  // bd but no .beads: status only.
  runScript(folder, bd.bin);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(beadsExportDir(folder), 'status.json'), 'utf8')).ok, false);
  assert.ok(!fs.existsSync(path.join(beadsExportDir(folder), 'issues.jsonl')));

  // Another copy holds the lock: a live process whose command line names beads-export (where /proc can say).
  fs.mkdirSync(path.join(folder, '.beads'));
  const lock = path.join(beadsExportDir(folder), 'export.lock');
  fs.mkdirSync(lock, { recursive: true });
  const holder = spawn('sh', ['-c', 'sleep 10; :', 'beads-export.sh'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(path.join(lock, 'pid'), `${holder.pid}\n`);
    runScript(folder, bd.bin);
    assert.ok(!fs.existsSync(path.join(beadsExportDir(folder), 'issues.jsonl')), 'a live copy keeps the folder');
    assert.strictEqual(fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim(), String(holder.pid));
  } finally {
    holder.kill();
  }
  // A lock with no pid yet: another copy is starting, so it's held; over a minute old, that copy died.
  fs.rmSync(path.join(lock, 'pid'));
  runScript(folder, bd.bin);
  assert.ok(!fs.existsSync(path.join(beadsExportDir(folder), 'issues.jsonl')), 'a fresh lock with no pid is held');
  const old = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(lock, old, old);
  runScript(folder, bd.bin);
  assert.ok(fs.existsSync(path.join(beadsExportDir(folder), 'issues.jsonl')), 'an old one is taken over');
  assert.ok(!fs.existsSync(lock));
  fs.rmSync(path.join(beadsExportDir(folder), 'issues.jsonl'));
  fs.mkdirSync(lock);

  // A stale lock (its pid gone) is taken over.
  fs.writeFileSync(path.join(lock, 'pid'), '999999\n');
  runScript(folder, bd.bin);
  assert.ok(fs.existsSync(path.join(beadsExportDir(folder), 'issues.jsonl')));
  assert.ok(!fs.existsSync(lock));

  // .snagboat/beads a link: writes nothing there.
  const other = path.join(root, 'other');
  fs.mkdirSync(path.join(other, '.beads'), { recursive: true });
  fs.mkdirSync(path.join(other, '.snagboat'));
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  fs.symlinkSync(target, beadsExportDir(other));
  runScript(other, bd.bin);
  assert.deepStrictEqual(fs.readdirSync(target), []);
});

test('beads-export.sh start returns at once and leaves one copy running', () => {
  if (posixOnly) return;
  const root = tmp();
  const folder = path.join(root, 'proj');
  fs.mkdirSync(path.join(folder, '.beads'), { recursive: true });
  const bd = fakeBd(root);
  fs.writeFileSync(bd.issues, issue('p-1', '2026-11-01T00:00:00Z') + '\n');
  const started = Date.now();
  runScript(folder, bd.bin, 'start');
  runScript(folder, bd.bin, 'start');
  assert.ok(Date.now() - started < 5000);
  const status = path.join(beadsExportDir(folder), 'status.json');
  const lockPid = path.join(beadsExportDir(folder), 'export.lock', 'pid');
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(status) && Date.now() < deadline) spawnSync('sleep', ['0.2']);
  assert.ok(fs.existsSync(status), 'the background copy ran');
  const pid = Number(fs.readFileSync(lockPid, 'utf8'));
  try {
    assert.strictEqual(JSON.parse(fs.readFileSync(status, 'utf8')).pid, pid, 'the second start left the first running');
  } finally {
    process.kill(pid, 'SIGTERM');
  }
  const gone = Date.now() + 5000;
  while (fs.existsSync(lockPid) && Date.now() < gone) spawnSync('sleep', ['0.2']);
  assert.ok(!fs.existsSync(lockPid), 'SIGTERM releases the lock');
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
