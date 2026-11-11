import { SessionSummary } from '@snagboat/schema';
import { storeSessions } from '../core/sessionSummaries';
import { findGlobalDirs, findStores, findUserStores, selectStores, Store, userHome } from './stores';
import { migrate, MigrationReport, MigrationSource } from '../core/migrate';
import { workspaceOfVsCodeStore } from '../core/userStore';
import { compareToBaseline, parseBaseline, SessionCounts, verifyText } from './verify';
import { CoreService } from '../core/service/server';
import { effectiveSettings } from '../core/config';
import { ensureCore, findCore } from '../core/service/lifecycle';
import { coreRequest, liveCore } from '../core/service/coreFile';
import * as fs from 'fs';

/**
 * The snagboat CLI (docs/design/architecture-rfc.md, step 3): read the event
 * logs the VS Code extension writes, from a terminal or an agent, without VS
 * Code running. Every command prints JSON with --json. Only `migrate` writes,
 * and only to the per-user store: it copies, never moves or deletes.
 */

const USAGE = `usage: snagboat <command> [options]

commands:
  stores              list the event stores on this machine
  sessions            list sessions in the current workspace's store
  session <id>        one session's summary
  config              the settings that apply to the current folder, and where each comes from
  serve               run the core service in the foreground (Ctrl-C stops it)
  core start          start the core in the background, unless it's running
  core status         whether the core is running, and where
  core stop           stop the core
  migrate             copy every VS Code store into the per-user store (~/.snagboat/data);
                      copies only, leaving the VS Code stores as they are, and a rerun copies
                      only what's new
  version             print the version

options:
  --json              print JSON instead of text
  --all               read every workspace's store, not just the one containing the current folder
  --days <n>          only sessions active in the last n days (sessions)
  --cwd <dir>         treat dir as the current folder
  --store <kind>      vscode (VS Code's storage, the default) or user (the per-user store)
  --port <n>          serve: listen on this port instead of a free one
  --idle-minutes <n>  serve, core start: stop after n minutes with no requests (default 30; 0 never)
  --dry-run           migrate: count what would be copied, and write nothing
  --verify <file>     migrate: don't copy; check the per-user store against a baseline saved
                      with \`snagboat sessions --all --json\` before migrating
`;

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  cwd: string;
  now: Date;
}

interface Options {
  json: boolean;
  all: boolean;
  days?: number;
  cwd?: string;
  store?: 'vscode' | 'user';
  dryRun?: boolean;
  verify?: string;
  port?: number;
  idleMinutes?: number;
  args: string[];
}

export function parseArgs(argv: string[]): Options | string {
  const opts: Options = { json: false, all: false, args: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--port' || a === '--idle-minutes') {
      const value = argv[++i];
      const n = Number(value);
      if (value === undefined || !Number.isInteger(n) || n < 0) return `${a} takes a whole number, not ${value ?? 'nothing'}`;
      if (a === '--port') opts.port = n;
      else opts.idleMinutes = n;
    } else if (a === '--days' || a === '--cwd' || a === '--store' || a === '--verify') {
      const value = argv[++i];
      if (value === undefined) return `${a} needs a value`;
      if (a === '--days') {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return `--days takes a positive number, not ${value}`;
        opts.days = n;
      } else if (a === '--store') {
        if (value !== 'vscode' && value !== 'user') return `--store takes vscode or user, not ${value}`;
        opts.store = value;
      } else if (a === '--verify') opts.verify = value;
      else opts.cwd = value;
    } else if (a.startsWith('--')) return `unknown option ${a}`;
    else opts.args.push(a);
  }
  return opts;
}

async function summaries(stores: Store[]): Promise<Array<SessionSummary & { store: string; folder?: string }>> {
  const all: Array<SessionSummary & { store: string; folder?: string }> = [];
  for (const store of stores) {
    for (const s of await storeSessions(store.dir)) all.push({ ...s, store: store.dir, folder: store.folder });
  }
  return all.sort((a, b) => b.lastTs.localeCompare(a.lastTs));
}

/** The stores --store picks: VS Code's (the default) or the per-user store's. SNAGBOAT_STORE overrides both. */
function storesOf(kind: Options['store']): Store[] {
  return kind === 'user' && !process.env.SNAGBOAT_STORE ? findUserStores() : findStores();
}

function storeLabel(s: Store): string {
  return `${s.app}  ${s.folder ?? s.workspaceFile ?? s.uri ?? (s.global ? '(no folder)' : '?')}`;
}

function migrationText(home: string, dryRun: boolean, report: MigrationReport, skipped: Store[]): string {
  const lines = [dryRun ? `Dry run: nothing written. Would copy into ${home}:` : `Copied into ${home} (the VS Code stores are unchanged):`];
  if (report.stores.length === 0) lines.push('  no VS Code stores found');
  for (const r of report.stores) {
    const what =
      r.status === 'up-to-date'
        ? 'up to date: unchanged since it was last copied'
        : `${r.events} events in ${r.days} days, ${r.newEvents} ${dryRun ? 'to copy' : 'copied'}; ${r.aggregates} daily aggregates, ${r.checkpoints} checkpoints, ${r.responses} finding responses`;
    lines.push(`  ${r.label}`, `      ${what}`, `      -> ${r.dest}`);
  }
  for (const s of skipped) lines.push(`  ${storeLabel(s)}`, `      skipped: its workspace.json doesn't say which workspace it belongs to`, `      (${s.dir})`);
  if (report.globals.length > 0) lines.push('Shared files:');
  for (const g of report.globals) {
    const what = g.status === 'exists' ? 'kept the one already there' : dryRun ? 'would copy' : 'copied';
    lines.push(`  ${g.name}  ${what}  (from ${g.from})`);
  }
  return lines.join('\n') + '\n';
}

function noStoreMessage(cwd: string, all: boolean): string {
  return all
    ? 'no Snagboat event stores found on this machine'
    : `no Snagboat event store for a workspace containing ${cwd}; use --all to read every workspace, or --cwd <dir>`;
}

function sessionLine(s: SessionSummary): string {
  const name = s.name ? ` "${s.name}"` : '';
  return `${s.lastTs.slice(0, 16).replace('T', ' ')}  ${s.agent.padEnd(11)}  ${String(s.prompts).padStart(3)} prompts  ${String(s.toolCalls).padStart(4)} tools  ${String(s.tokens).padStart(9)} tokens  ${s.sessionId}${name}`;
}

export async function runCli(argv: string[], io: CliIo, version: string): Promise<number> {
  const parsed = parseArgs(argv);
  if (typeof parsed === 'string') {
    io.err(`${parsed}\n\n${USAGE}`);
    return 2;
  }
  const [command, ...rest] = parsed.args;
  const cwd = parsed.cwd ?? io.cwd;
  const print = (value: unknown, text: () => string) => io.out(parsed.json ? JSON.stringify(value, null, 2) + '\n' : text());

  switch (command) {
    case 'version':
      print({ version }, () => `snagboat ${version}\n`);
      return 0;
    case 'stores': {
      const stores = process.env.SNAGBOAT_STORE ? findStores() : [...findStores(), ...findUserStores()];
      print(stores, () => (stores.length ? stores.map((s) => `${storeLabel(s)}  ${s.dir}`).join('\n') + '\n' : 'no Snagboat event stores found\n'));
      return 0;
    }
    case 'config': {
      const settings = effectiveSettings(userHome(), cwd);
      print(settings, () => {
        const lines = [`settings for ${cwd}`, `  from ${settings.files.config}${settings.files.projectFolder ? ` (project entry ${settings.files.projectFolder})` : ''}`];
        if (settings.files.projectFile) lines.push(`  and ${settings.files.projectFile}`);
        const keys = Object.keys(settings.values).sort();
        if (keys.length === 0) lines.push('  nothing set: every setting has its built-in default');
        for (const key of keys) lines.push(`  ${key} = ${JSON.stringify(settings.values[key])}  (${settings.sources[key]})`);
        for (const problem of settings.problems) lines.push(`  ignored: ${problem}`);
        return lines.join('\n') + '\n';
      });
      return 0;
    }
    case 'serve': {
      const home = userHome();
      let core: CoreService;
      try {
        core = await CoreService.start({
          home,
          version,
          port: parsed.port,
          idleMs: parsed.idleMinutes === undefined ? undefined : parsed.idleMinutes * 60_000,
          log: (line) => io.err(`${new Date().toISOString()} ${line}\n`),
        });
      } catch (err) {
        io.err(`${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
      const stop = () => void core.stop();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      await core.stopped;
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      return 0;
    }
    case 'core': {
      const home = userHome();
      const sub = rest[0];
      if (sub === 'status') {
        const info = await findCore(home);
        print(info ? { running: true, port: info.port, pid: info.pid, version: info.version, startedAt: info.startedAt } : { running: false }, () =>
          info ? `running: pid ${info.pid}, 127.0.0.1:${info.port}, version ${info.version}, since ${info.startedAt}\n` : 'not running\n'
        );
        return info ? 0 : 1;
      }
      if (sub === 'start') {
        try {
          const info = await ensureCore(home, __filename, { idleMinutes: parsed.idleMinutes });
          print({ running: true, port: info.port, pid: info.pid }, () => `running: pid ${info.pid}, 127.0.0.1:${info.port}\n`);
          return 0;
        } catch (err) {
          io.err(`${err instanceof Error ? err.message : String(err)}\n`);
          return 1;
        }
      }
      if (sub === 'stop') {
        const info = await findCore(home);
        if (!info) {
          print({ running: false }, () => 'not running\n');
          return 0;
        }
        await coreRequest(info.port, info.token, 'POST', '/shutdown');
        const deadline = Date.now() + 5_000;
        while (liveCore(home) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        print({ stopped: !liveCore(home), pid: info.pid }, () => (liveCore(home) ? `asked pid ${info.pid} to stop; it's still running\n` : `stopped pid ${info.pid}\n`));
        return liveCore(home) ? 1 : 0;
      }
      io.err(`core needs start, status or stop\n\n${USAGE}`);
      return 2;
    }
    case 'migrate': {
      if (parsed.verify !== undefined) {
        let baseline: SessionCounts[];
        try {
          baseline = parseBaseline(fs.readFileSync(parsed.verify, 'utf8'));
        } catch (err) {
          io.err(`can't read the baseline ${parsed.verify}: ${err instanceof Error ? err.message : String(err)}\n`);
          return 2;
        }
        const result = compareToBaseline(baseline, await summaries(findUserStores()));
        print(result, () => verifyText(result));
        return result.ok ? 0 : 1;
      }
      const home = userHome();
      const sources: MigrationSource[] = [];
      const skipped: Store[] = [];
      for (const s of findStores()) {
        const info = workspaceOfVsCodeStore(s.dir, s.global);
        if (info) sources.push({ dir: s.dir, label: storeLabel(s), info });
        else skipped.push(s);
      }
      const dryRun = parsed.dryRun ?? false;
      const report = await migrate(sources, findGlobalDirs(), home, { dryRun });
      print({ home, dryRun, ...report, skipped: skipped.map((s) => s.dir) }, () => migrationText(home, dryRun, report, skipped));
      return 0;
    }
    case 'sessions': {
      const stores = selectStores(storesOf(parsed.store), cwd, parsed.all);
      if (stores.length === 0) {
        io.err(noStoreMessage(cwd, parsed.all) + '\n');
        return 1;
      }
      let list = await summaries(stores);
      if (parsed.days !== undefined) {
        const since = new Date(io.now.getTime() - parsed.days * 86_400_000).toISOString();
        list = list.filter((s) => s.lastTs >= since);
      }
      print(list, () => (list.length ? list.map(sessionLine).join('\n') + '\n' : 'no sessions\n'));
      return 0;
    }
    case 'session': {
      const id = rest[0];
      if (!id) {
        io.err(`session needs an id\n\n${USAGE}`);
        return 2;
      }
      const stores = selectStores(storesOf(parsed.store), cwd, parsed.all);
      if (stores.length === 0) {
        io.err(noStoreMessage(cwd, parsed.all) + '\n');
        return 1;
      }
      const found = (await summaries(stores)).filter((s) => s.sessionId === id || s.sessionId.startsWith(id));
      if (found.length !== 1) {
        io.err(found.length === 0 ? `no session ${id} in this workspace's store\n` : `${id} matches ${found.length} sessions; give more of the id\n`);
        return 1;
      }
      const s = found[0];
      print(s, () =>
        [
          `session  ${s.sessionId}${s.name ? `  "${s.name}"` : ''}`,
          `agent    ${s.agent}`,
          `time     ${s.firstTs} to ${s.lastTs}`,
          `models   ${s.models.join(', ') || '-'}`,
          `prompts  ${s.prompts}   model calls ${s.modelCalls}   tool calls ${s.toolCalls}   subagents ${s.subagents}`,
          `tokens   ${s.tokens}`,
          `days     ${s.days.join(', ')}`,
          '',
        ].join('\n')
      );
      return 0;
    }
    case undefined:
    case 'help':
      io.out(USAGE);
      return command === undefined ? 2 : 0;
    default:
      io.err(`unknown command ${command}\n\n${USAGE}`);
      return 2;
  }
}

// Bundled as dist/snagboat.js (esbuild.js); VERSION is injected there.
declare const SNAGBOAT_VERSION: string | undefined;

if (require.main === module) {
  const version = typeof SNAGBOAT_VERSION === 'string' ? SNAGBOAT_VERSION : 'dev';
  runCli(process.argv.slice(2), { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t), cwd: process.cwd(), now: new Date() }, version).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`snagboat: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  );
}
