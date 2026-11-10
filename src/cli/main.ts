import { SessionIndex, SessionSummary } from '@snagboat/schema';
import { EventLog } from '../core/eventLog';
import { findStores, selectStores, Store } from './stores';

/**
 * The snagboat CLI (docs/design/architecture-rfc.md, step 3): read the event
 * logs the VS Code extension writes, from a terminal or an agent, without VS
 * Code running. Read-only. Every command prints JSON with --json.
 */

const USAGE = `usage: snagboat <command> [options]

commands:
  stores              list the event stores on this machine
  sessions            list sessions in the current workspace's store
  session <id>        one session's summary
  version             print the version

options:
  --json              print JSON instead of text
  --all               read every workspace's store, not just the one containing the current folder
  --days <n>          only sessions active in the last n days (sessions)
  --cwd <dir>         treat dir as the current folder
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
  args: string[];
}

export function parseArgs(argv: string[]): Options | string {
  const opts: Options = { json: false, all: false, args: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--days' || a === '--cwd') {
      const value = argv[++i];
      if (value === undefined) return `${a} needs a value`;
      if (a === '--days') {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return `--days takes a positive number, not ${value}`;
        opts.days = n;
      } else opts.cwd = value;
    } else if (a.startsWith('--')) return `unknown option ${a}`;
    else opts.args.push(a);
  }
  return opts;
}

async function summaries(stores: Store[]): Promise<Array<SessionSummary & { store: string; folder?: string }>> {
  const all: Array<SessionSummary & { store: string; folder?: string }> = [];
  for (const store of stores) {
    const log = new EventLog(store.dir);
    const index = new SessionIndex();
    for (const day of await log.listDays()) for (const e of await log.readDay(day)) index.ingest(e);
    for (const s of index.list()) all.push({ ...s, store: store.dir, folder: store.folder });
  }
  return all.sort((a, b) => b.lastTs.localeCompare(a.lastTs));
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
      const stores = findStores();
      print(stores, () => (stores.length ? stores.map((s) => `${s.app}  ${s.folder ?? s.workspaceFile ?? (s.global ? '(no folder)' : '?')}  ${s.dir}`).join('\n') + '\n' : 'no Snagboat event stores found\n'));
      return 0;
    }
    case 'sessions': {
      const stores = selectStores(findStores(), cwd, parsed.all);
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
      const stores = selectStores(findStores(), cwd, parsed.all);
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
