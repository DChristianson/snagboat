import { SessionSummary } from '@snagboat/schema';
import { storeSessions } from '../core/sessionSummaries';
import { findGlobalDirs, findStores, findUserStores, selectStores, Store, userHome } from './stores';
import { migrate, MigrationReport, MigrationSource } from '../core/migrate';
import { workspaceOfVsCodeStore } from '../core/userStore';
import { compareToBaseline, parseBaseline, SessionCounts, verifyText } from './verify';
import { CoreService } from '../core/service/server';
import { containersAllowed, effectiveSettings, loadConfig, saveConfig, withContainerFolder } from '../core/config';
import { ContainerFolderStatus, ContainerProjectsScan, containerProjectsDir, readContainerStatus, scanContainerProjects } from '../core/containerTranscripts';
import { ensureCore, findCore } from '../core/service/lifecycle';
import { coreRequest, liveCore } from '../core/service/coreFile';
import * as fs from 'fs';
import { spawn } from 'child_process';
import * as path from 'path';
import { EventLog } from '../core/eventLog';
import { loadAdvisorGoals } from '../advisor/goals';
import { advisorReports, eventsIn, periods, reportLines } from '../advisor/report';
import { McpReads, serveMcp } from './mcp';
import { readStdin, statusLine, statusLineDir, Today } from './statusline';
import { HOOK_SCRIPT } from '../adapters/claude-code/hookRoutes';

/**
 * The snagboat CLI (docs/design/architecture-rfc.md, step 3): read the event
 * logs the VS Code extension writes, from a terminal or an agent, without VS
 * Code running. Every command prints JSON with --json. Only `migrate` and
 * `containers allow|deny` write: migrate only to the per-user store (it copies,
 * never moves or deletes), containers only its list in ~/.snagboat/config.json.
 */

const USAGE = `usage: snagboat <command> [options]

commands:
  stores              list the event stores on this machine
  sessions            list sessions in the current workspace's store
  session <id>        one session's summary
  findings            the current workspace's findings and early warnings, from the running core
  advisors            each advisor's goal, and its measures this week against the week before
  open                open the advisor UI in your browser (starts the core if it isn't running)
  statusline          one line for Claude Code's status line (findings, today's tokens); reads its
                      JSON on stdin, and never starts the core
  mcp                 an MCP server over stdio with read-only tools (findings, sessions, session,
                      advisors) for the workspace containing the current folder; the Claude Code
                      plugin runs it
  config              the settings that apply to the current folder, and where each comes from
  containers allow [dir]
                      let the core read the Claude Code transcripts a dev container keeps in
                      dir's .snagboat/claude-projects folder (dir defaults to the current
                      folder); writes containers.allow in ~/.snagboat/config.json
  containers deny [dir]
                      stop reading them
  containers status   the allowed folders: what each one's claude-projects folder holds, and
                      when the core last read it
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
  --days <n>          only sessions active in the last n days (sessions); the period measured (advisors, default 7)
  --cwd <dir>         treat dir as the current folder
  --store <kind>      user (the per-user store, ~/.snagboat/data; the default once it has events)
                      or vscode (VS Code's storage for each window; the default until then)
  --port <n>          serve: listen on this port instead of a free one
  --no-collect        serve, core start: don't read Claude Code transcripts or Copilot CLI sessions
                      (only accept events and hooks)
  --idle-minutes <n>  serve, core start: stop after n minutes with no requests (default 30; 0 never)
  --no-open           open: print the link instead of opening a browser
  --dry-run           migrate: count what would be copied, and write nothing
  --verify <file>     migrate: don't copy; check the per-user store against a baseline saved
                      with \`snagboat sessions --all --json --store vscode\` before migrating
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
  noCollect?: boolean;
  noOpen?: boolean;
  args: string[];
}

export function parseArgs(argv: string[]): Options | string {
  const opts: Options = { json: false, all: false, args: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-collect') opts.noCollect = true;
    else if (a === '--no-open') opts.noOpen = true;
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

/**
 * The stores --store picks. Without it, the per-user store's once it has events
 * (where the core and windows with snagboat.storage.perUserStore write, dev
 * containers' sessions included), else VS Code's. SNAGBOAT_STORE overrides both.
 */
function storesOf(kind: Options['store']): Store[] {
  if (process.env.SNAGBOAT_STORE || kind === 'vscode') return findStores();
  const user = findUserStores();
  return kind === 'user' || user.length > 0 ? user : findStores();
}

function storeLabel(s: Store): string {
  return `${s.app}  ${s.folder ?? s.workspaceFile ?? s.uri ?? (s.global ? '(no folder)' : '(workspace unknown)')}`;
}

function migrationText(home: string, dryRun: boolean, report: MigrationReport, skipped: Store[]): string {
  const lines = [dryRun ? `Dry run: nothing written. Would copy into ${home}:` : `Copied into ${home} (the VS Code stores are unchanged):`];
  if (report.stores.length === 0 && skipped.length === 0) lines.push('  no VS Code stores found');
  for (const r of report.stores) {
    const what =
      r.status === 'up-to-date'
        ? 'up to date: unchanged since it was last copied'
        : `${r.events} events in ${r.days} days, ${r.newEvents} ${dryRun ? 'to copy' : 'copied'}; ${r.aggregates} daily aggregates, ${r.checkpoints} checkpoints, ${r.responses} finding responses`;
    lines.push(`  ${r.label}`, `      ${what}`, `      -> ${r.dest}`);
  }
  for (const s of skipped) {
    // VS Code's server (dev containers, Remote-SSH) writes no workspace.json. Snagboat writes its own marker
    // when a window opens the store, so this is a store no window has opened since it started doing that.
    const why = s.app.endsWith('(server)')
      ? "VS Code's server doesn't record which workspace it belongs to, and no window has recorded it yet; open that folder in VS Code once and migrate again"
      : "its workspace.json doesn't say which workspace it belongs to";
    lines.push(`  ${storeLabel(s)}`, `      skipped: ${why}`, `      (${s.dir})`);
  }
  if (report.globals.length > 0) lines.push('Shared files:');
  for (const g of report.globals) {
    const what = g.status === 'exists' ? 'kept the one already there' : dryRun ? 'would copy' : 'copied';
    lines.push(`  ${g.name}  ${what}  (from ${g.from})`);
  }
  return lines.join('\n') + '\n';
}

const unknownWorkspace = (s: Store) => !s.global && !s.folder && !s.workspaceFile && !s.uri;

/** unknown: stores whose workspace isn't known (a VS Code server store no window has marked yet), so no cwd picks them. */
function noStoreMessage(cwd: string, all: boolean, unknown = 0): string {
  if (all) return 'no Snagboat event stores found on this machine';
  const hint = unknown > 0 ? ` (${unknown} store${unknown === 1 ? '' : 's'} with no known workspace, e.g. from VS Code's server before a window recorded it, only show with --all; opening the folder in VS Code records it)` : '';
  return `no Snagboat event store for a workspace containing ${cwd}; use --all to read every workspace, or --cwd <dir>${hint}`;
}

/** A store's workspace, for lines that mix stores: its folder, .code-workspace file or remote URI. */
function storeWhere(s: Store): string {
  return s.folder ?? s.workspaceFile ?? s.uri ?? (s.global ? '(no folder)' : '(workspace unknown)');
}

/** One line per session; with `where`, the workspace it's from follows (when more than one store is listed). */
function sessionLine(s: SessionSummary, where?: string): string {
  const name = s.name ? ` "${s.name}"` : '';
  return `${s.lastTs.slice(0, 16).replace('T', ' ')}  ${s.agent.padEnd(11)}  ${String(s.prompts).padStart(3)} prompts  ${String(s.toolCalls).padStart(4)} tools  ${String(s.tokens).padStart(9)} tokens  ${s.sessionId}${name}${where ? `  ${where}` : ''}`;
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
    case 'containers':
      return containersCommand(rest, cwd, io, print);
    case 'serve': {
      const home = userHome();
      let core: CoreService;
      try {
        core = await CoreService.start({
          home,
          version,
          port: parsed.port,
          collect: !parsed.noCollect,
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
    case 'open': {
      // The advisor UI (RFC step 5a): a one-time link from the core, for the workspace containing this folder.
      const home = userHome();
      let info;
      try {
        info = await ensureCore(home, __filename, { idleMinutes: parsed.idleMinutes });
      } catch (err) {
        io.err(`the core couldn't start: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
      const workspace = selectStores(findUserStores(), cwd, false).find((st) => st.workspace)?.workspace;
      const res = await coreRequest(info.port, info.token, 'POST', '/ui-links', workspace ? { workspace } : {});
      if (res.status !== 200) {
        io.err(`the core answered ${res.status}: ${JSON.stringify(res.body)}\n`);
        return 1;
      }
      const link = res.body as { url: string; expiresAt: string };
      const opened = !parsed.noOpen && (await openInBrowser(link.url));
      // The code is printed only when it's needed (--no-open, or no browser), so it doesn't land in a transcript for nothing.
      const address = link.url.slice(0, link.url.indexOf('#'));
      print(opened ? { url: address, expiresAt: link.expiresAt, opened } : { ...link, opened }, () =>
        opened ? `Opened the advisor UI (${address}) in your browser.\n` : `Open the advisor UI: ${link.url}\nThe link works once, within 2 minutes.\n`
      );
      return 0;
    }
    case 'mcp': {
      // The Claude Code plugin's MCP server (RFC step 5d): read-only tools over the core, for the workspace
      // containing this folder. Starts the core if it isn't running, as `open` does.
      const home = userHome();
      // Started now rather than on the first tool call, so a Claude Code session with the plugin has the core
      // collecting from its start.
      void ensureCore(home, __filename, { idleMinutes: parsed.idleMinutes }).catch((err) => io.err(`snagboat mcp: the core couldn't start: ${err instanceof Error ? err.message : String(err)}\n`));
      const reads = async (): Promise<McpReads> => {
        const info = await ensureCore(home, __filename, { idleMinutes: parsed.idleMinutes });
        const workspace = selectStores(findUserStores(), cwd, false).find((st) => st.workspace)?.workspace;
        return { workspace, get: (p) => coreRequest(info.port, info.token, 'GET', p, undefined, 30_000) };
      };
      await serveMcp(process.stdin, (line) => io.out(line + '\n'), reads, version);
      return 0;
    }
    case 'statusline': {
      // Claude Code's status line (RFC step 5d): reads its JSON on stdin; prints one line; never starts the core.
      const dir = statusLineDir(await readStdin()) ?? cwd;
      const info = await findCore(userHome());
      if (!info) {
        io.out(statusLine('no-core') + '\n');
        return 0;
      }
      const workspace = selectStores(findUserStores(), dir, false).find((st) => st.workspace)?.workspace;
      if (!workspace) {
        io.out(statusLine('no-workspace') + '\n');
        return 0;
      }
      const res = await coreRequest(info.port, info.token, 'GET', `/today?workspace=${encodeURIComponent(workspace)}`, undefined, 3_000).catch(() => undefined);
      io.out((res?.status === 200 ? statusLine(res.body as Today) : statusLine('no-core')) + '\n');
      return 0;
    }
    case 'print-hook-script':
      // For the Claude Code plugin's build (scripts/buildPlugin.js): the hook forwarder every project runs.
      io.out(HOOK_SCRIPT);
      return 0;
    case 'findings': {
      // Worked out by the core (3c-3d), for the per-user store's workspace containing the folder.
      const home = userHome();
      const info = await findCore(home);
      if (!info) {
        io.err('the core isn\'t running; start it with `snagboat core start` (or open the folder in VS Code with snagboat.storage.perUserStore on)\n');
        return 1;
      }
      const stores = selectStores(findUserStores(), cwd, parsed.all).filter((st) => st.workspace);
      if (stores.length === 0) {
        io.err(noStoreMessage(cwd, parsed.all, 0) + '\n');
        return 1;
      }
      const results: Array<{ workspace: string; findings: Array<{ heuristicId: string; severity: string; summary: string }>; progress: Array<{ heuristicId: string; share: number; summary: string }>; problems: string[] }> = [];
      for (const st of stores) {
        const res = await coreRequest(info.port, info.token, 'GET', `/findings?workspace=${encodeURIComponent(st.workspace!)}`, undefined, 30_000);
        if (res.status !== 200) {
          io.err(`the core answered ${res.status} for ${st.workspace}: ${JSON.stringify(res.body)}\n`);
          return 1;
        }
        results.push(...(res.body as typeof results));
      }
      print(results, () =>
        results
          .map((r) => {
            const lines = [
              ...r.findings.map((x) => `  ${x.severity.padEnd(4)}  ${x.heuristicId}: ${x.summary}`),
              ...r.progress.map((p) => `  near  ${p.heuristicId}: ${p.summary} (${Math.round(p.share * 100)}%)`),
              ...r.problems.map((p) => `  rule problem: ${p}`),
            ];
            return `${r.workspace}\n${lines.length ? lines.join('\n') : '  nothing found'}\n`;
          })
          .join('')
      );
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
          const info = await ensureCore(home, __filename, { idleMinutes: parsed.idleMinutes, collect: !parsed.noCollect });
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
    case 'advisors': {
      // Advisors as goals (RFC step 4c): built-in, or persona.md front matter in <snagboat home>/advisors/<id>/.
      const { advisors, problems } = loadAdvisorGoals(path.join(userHome(), 'advisors'));
      const available = storesOf(parsed.store);
      const stores = selectStores(available, cwd, parsed.all);
      if (stores.length === 0) {
        io.err(noStoreMessage(cwd, parsed.all, available.filter(unknownWorkspace).length) + '\n');
        return 1;
      }
      const days = parsed.days ?? 7;
      const { current, previous } = periods(io.now, days);
      const logs = stores.map((st) => new EventLog(st.dir));
      const reports = advisorReports(advisors, await eventsIn(logs, current), await eventsIn(logs, previous));
      print({ days, current, previous, advisors: reports, problems }, () =>
        [`Last ${days} days (${current.from.slice(0, 16).replace('T', ' ')} to ${current.to.slice(0, 16).replace('T', ' ')} UTC) against the ${days} before:`, '', ...reports.flatMap((r) => [...reportLines(r, days), '']), ...problems.map((p) => `problem: ${p}`)].join('\n') + '\n'
      );
      return 0;
    }
    case 'sessions': {
      const available = storesOf(parsed.store);
      const stores = selectStores(available, cwd, parsed.all);
      if (stores.length === 0) {
        io.err(noStoreMessage(cwd, parsed.all, available.filter(unknownWorkspace).length) + '\n');
        return 1;
      }
      let list = await summaries(stores);
      if (parsed.days !== undefined) {
        const since = new Date(io.now.getTime() - parsed.days * 86_400_000).toISOString();
        list = list.filter((s) => s.lastTs >= since);
      }
      const where = new Map(stores.map((s) => [s.dir, storeWhere(s)]));
      const line = (s: (typeof list)[number]) => sessionLine(s, stores.length > 1 ? where.get(s.store) : undefined);
      print(list, () => (list.length ? list.map(line).join('\n') + '\n' : 'no sessions\n'));
      return 0;
    }
    case 'session': {
      const id = rest[0];
      if (!id) {
        io.err(`session needs an id\n\n${USAGE}`);
        return 2;
      }
      const available = storesOf(parsed.store);
      const stores = selectStores(available, cwd, parsed.all);
      if (stores.length === 0) {
        io.err(noStoreMessage(cwd, parsed.all, available.filter(unknownWorkspace).length) + '\n');
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

/** snagboat containers allow|deny [folder], snagboat containers status (dev container transcripts, core/containerTranscripts.ts). */
async function containersCommand(rest: string[], cwd: string, io: CliIo, print: (value: unknown, text: () => string) => void): Promise<number> {
  const home = userHome();
  const file = path.join(home, 'config.json');
  const [sub, given] = rest;
  if (sub === 'allow' || sub === 'deny') {
    const resolved = path.resolve(cwd, given ?? '.');
    let folder: string;
    try {
      folder = fs.realpathSync(resolved);
      if (!fs.statSync(folder).isDirectory()) throw new Error('not a directory');
    } catch {
      if (sub === 'allow') {
        io.err(`${resolved} isn't a folder\n`);
        return 1;
      }
      folder = resolved; // denying a folder that's gone
    }
    const { config, problems } = loadConfig(home);
    // A config.json that isn't JSON would be replaced by the write: leave it for you to fix.
    const broken = problems.find((p) => p.includes("isn't valid JSON"));
    if (broken) {
      io.err(`${broken}\nFix it, then run this again.\n`);
      return 1;
    }
    const before = containersAllowed(config);
    let next = config;
    if (sub === 'allow') next = withContainerFolder(config, folder, true);
    else for (const f of new Set([folder, resolved])) next = withContainerFolder(next, f, false);
    const after = containersAllowed(next);
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    if (changed) saveConfig(home, next);
    print({ changed, folder, allow: after, config: file }, () => {
      if (!changed) return sub === 'allow' ? `${folder} is already allowed (${file}); nothing changed\n` : `${folder} wasn't allowed; nothing changed\n`;
      return sub === 'allow'
        ? `Changed ${file}: added ${folder} to containers.allow.\nThe core reads the Claude Code transcripts in ${containerProjectsDir(folder)} from its next ingest (every 30 seconds while it runs).\n`
        : `Changed ${file}: removed ${folder} from containers.allow. The core stops reading its dev container's transcripts on its next ingest.\n`;
    });
    return 0;
  }
  if (sub === 'status') {
    const status = readContainerStatus(home);
    const folders: Array<{ folder: string } & ContainerProjectsScan & { lastRead: ContainerFolderStatus | null }> = [];
    for (const folder of containersAllowed(loadConfig(home).config)) folders.push({ folder, ...scanContainerProjects(folder), lastRead: status[folder] ?? null });
    print({ config: file, folders }, () => {
      if (folders.length === 0) return 'No folders are allowed; `snagboat containers allow [folder]` allows one.\n';
      const lines: string[] = [];
      for (const f of folders) {
        lines.push(f.folder);
        lines.push(
          f.exists
            ? `  transcripts  ${f.projectsDir}: ${f.projects} project folder(s), ${f.sessions} session file(s)`
            : f.problem
              ? `  transcripts  ${f.projectsDir}: refused`
              : `  transcripts  ${f.projectsDir} isn't there: no dev container mounts its ~/.claude/projects here yet`
        );
        if (f.problem) lines.push(`  problem      ${f.problem}`);
        lines.push(`  last read    ${f.lastRead ? `${f.lastRead.lastReadAt} (${f.lastRead.events} event(s) recorded so far)` : 'never'}`);
      }
      return lines.join('\n') + '\n';
    });
    return 0;
  }
  io.err(`containers needs allow, deny or status\n\n${USAGE}`);
  return 2;
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

/** Opens a URL in the default browser: true once the opener started, false if there's none (a container without xdg-open). */
function openInBrowser(url: string): Promise<boolean> {
  // start's first quoted argument is the window title: an empty one, which Node passes to cmd as "".
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args as string[], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
      child.once('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}
