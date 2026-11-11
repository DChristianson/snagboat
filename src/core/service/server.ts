import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { NormalizedEvent, SessionSummary } from '@snagboat/schema';
import { storeSessions } from '../sessionSummaries';
import { listUserStores, userDataDir, workspaceInfoOf } from '../userStore';
import { liveCore, readCoreFile, removeCoreFile, removeCoreRoute, writeCoreFile, writeCoreRoute } from './coreFile';
import { hookEvent, ingestHookSpool, openHookSpool } from './hooks';
import { ClaudeCollector, defaultProjectsDir } from './claudeCollector';
import { CopilotCollector } from './copilotCollector';
import { isWithinFolders, withRealPaths } from '../paths';
import { collectedWorkspace, knownWorkspaceFolders } from './workspaces';
import { CheckpointStore } from '../checkpointStore';
import { effectiveSettings } from '../config';
import { projectDirHeader } from '../../adapters/claude-code/hooksReceiver';
import { isProcessAlive } from '../processes';
import { RETENTION_INTERVAL_MS, StoreWriter } from './storeWriter';
import { EventLog } from '../eventLog';
import { FindingsService, WorkspaceFindings } from './findings';
import { HEURISTICS_INTERVAL_MS } from '../../heuristics/engine';

const STREAM_BATCH = 500;
const STREAM_PING_MS = 15_000;
/** What this core offers beyond 3c-2's endpoints, so a client can tell an older core apart. */
const CORE_FEATURES = ['events-stream', 'flush', 'retention', 'findings'];

/**
 * The core service (docs/design/architecture-rfc.md, step 3; handoff 3c-2):
 * one process per user that reads and writes the per-user store
 * (~/.snagboat/data) for every front door. Listens on 127.0.0.1 only and
 * publishes its port and admin token in ~/.snagboat/core.json.
 *
 * Tokens: the admin token in core.json reads every workspace (the explicit
 * cross-workspace scope, like the CLI's --all) and mints workspace tokens with
 * POST /tokens. A workspace token sees and writes only its workspaces: a VS
 * Code window gets one for its workspace and never sees another's data.
 * Tokens other than the admin token live only as long as the process.
 *
 * Endpoints:
 *   GET  /health               version, pid, start time
 *   POST /tokens               admin: { workspaces: [...] } -> { token }
 *   POST /events               one event or an array; workspace set from the token if missing
 *   GET  /sessions[?days=n]    sessions of the token's workspaces, newest first
 *   GET  /sessions/:id         one session, by id or unique id prefix
 *   GET  /events/stream[?changedSince=<iso>]
 *                              server-sent events: each batch written to the token's
 *                              workspaces, as a JSON array per message; with changedSince,
 *                              first every event in day files changed since then, then a
 *                              "replayed" message (3c-3c: a client window's live feed)
 *   POST /flush                waits for writes in flight, then ingests the spool of
 *                              workspaces no longer claimed (a window holding its folder)
 *   GET  /findings[?workspace=w] the token's workspaces' findings and early warnings now (3c-3d);
 *                              a workspace token's stream also carries them ("findings" messages)
 *   POST /retention            applies the token's workspaces' retention now (a window whose
 *                              retention settings changed) -> { changed: <days> }
 *
 * POST /tokens takes { workspaces: [w], folders: [...] } for a saved multi-root workspace
 * (a .code-workspace file): projects in those folders are recorded under w while the token lives.
 * When the core is stopped on purpose (POST /shutdown: snagboat core stop), each open stream
 * gets a "stopping" message, so its client doesn't start another core in its place. Any other
 * exit (a signal, a crash) says nothing, and clients start a new core.
 *   POST /hook                 hook token (core.route): a Claude Code hook payload, with the
 *                              project dir header the hook script sends
 *   POST /shutdown             admin: stop the core
 *
 * It exits after idleMs with no requests and no open event stream (0: never).
 * It runs retention for the workspaces no window has claimed (storeWriter.ts).
 */

export class CoreRunningError extends Error {
  constructor(readonly port: number, readonly pid: number) {
    super(`a Snagboat core is already running (pid ${pid}, port ${port})`);
  }
}

export interface CoreOptions {
  home: string;
  version: string;
  /** 0 or absent: a free port. */
  port?: number;
  /** Exit after this long with no requests; 0 never. Default 30 minutes. */
  idleMs?: number;
  /** How often followed workspaces' heuristics run with no new events; default 30 seconds. */
  heuristicsEveryMs?: number;
  /** How often to move spooled events of workspaces no longer claimed; default 30 seconds. */
  ingestEveryMs?: number;
  /** Read Claude Code transcripts and Copilot CLI sessions for every project (default true; 3c-3b, 3c-3d). */
  collect?: boolean;
  /** Where Claude Code keeps its projects' transcripts; default ~/.claude/projects (SNAGBOAT_CLAUDE_PROJECTS_DIR). */
  claudeProjectsDir?: string;
  /** ~/.copilot/session-state, or SNAGBOAT_COPILOT_SESSIONS_DIR. */
  copilotSessionsDir?: string;
  /** How often to apply retention to the workspaces the core owns; default every 6 hours. */
  retentionEveryMs?: number;
  log?: (line: string) => void;
}

type Scope = { admin: true } | { admin: false; workspaces: string[] };

const MAX_BODY = 16 * 1024 * 1024;
const DEFAULT_IDLE_MS = 30 * 60_000;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function isEvent(e: unknown): e is NormalizedEvent {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  const raw = o.raw as Record<string, unknown> | undefined;
  return (
    ['eventId', 'sessionId', 'agent', 'ts', 'kind', 'status'].every((k) => typeof o[k] === 'string') &&
    !!raw &&
    typeof raw === 'object' &&
    typeof raw.adapter === 'string' &&
    typeof raw.ref === 'string' &&
    (o.workspace === undefined || typeof o.workspace === 'string')
  );
}

function lockFile(home: string): string {
  return path.join(home, 'core.lock');
}

function takeLock(home: string): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile(home), 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = Number(fs.readFileSync(lockFile(home), 'utf8').trim());
      if (Number.isInteger(pid) && pid !== process.pid && isProcessAlive(pid)) throw new CoreRunningError(readCoreFile(home)?.port ?? 0, pid);
      fs.rmSync(lockFile(home), { force: true }); // left by a core that exited without stopping
    }
  }
  throw new Error(`couldn't take ${lockFile(home)}`);
}

function releaseLock(home: string): void {
  try {
    if (Number(fs.readFileSync(lockFile(home), 'utf8').trim()) === process.pid) fs.rmSync(lockFile(home), { force: true });
  } catch {
    // already gone
  }
}

function tokenEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export class CoreService {
  readonly token = crypto.randomBytes(32).toString('hex');
  /** Published in core.route for the hook script; good only for POST /hook. */
  readonly hookToken = crypto.randomBytes(32).toString('hex');
  readonly stopped: Promise<void>;
  private readonly server: http.Server;
  private readonly writer: StoreWriter;
  private readonly findings: FindingsService;
  /** Streams that want findings, told of each change. */
  private readonly findingsListeners = new Set<(result: WorkspaceFindings) => void>();
  private readonly workspaceTokens = new Map<string, string[]>();
  /** Folder -> the .code-workspace workspace it's part of, per token that registered them. */
  private readonly tokenFolders = new Map<string, Map<string, string>>();
  /** Ends each open event stream with "stopping"; resolves when it has closed. */
  private readonly stoppingStreams = new Set<() => Promise<void>>();
  private collector?: ClaudeCollector;
  private copilot?: CopilotCollector;
  private readonly settingsCache = new Map<string, { at: number; values: Record<string, unknown> }>();
  private readonly startedAt = new Date().toISOString();
  private lastActivity = Date.now();
  /** Open GET /events/stream responses: a window that's a client keeps the core up. */
  private streams = 0;
  private timers: NodeJS.Timeout[] = [];
  private resolveStopped!: () => void;
  private stopping = false;
  private boundPort = 0;

  private constructor(private readonly opts: CoreOptions) {
    this.writer = new StoreWriter(opts.home);
    this.findings = new FindingsService({
      home: opts.home,
      onChange: (result) => {
        for (const listener of this.findingsListeners) listener(result);
      },
      // A .code-workspace window registered its folders with its token; its settings are its first folder's.
      settingsDir: (workspace) => {
        for (const folders of this.tokenFolders.values()) for (const [folder, w] of folders) if (w === workspace) return folder;
        return undefined;
      },
      log: (line) => this.log(line),
    });
    this.writer.onWritten((workspace, events) => this.findings.ingest(workspace, events));
    this.stopped = new Promise((resolve) => (this.resolveStopped = resolve));
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  get port(): number {
    return this.boundPort;
  }

  /** Starts a core, unless one is already running for this home (CoreRunningError). A stale core.json is replaced. */
  static async start(opts: CoreOptions): Promise<CoreService> {
    const running = liveCore(opts.home);
    if (running && running.pid !== process.pid) throw new CoreRunningError(running.port, running.pid);
    // One core per home, even when two front doors start one at the same moment: the lock is created exclusively.
    takeLock(opts.home);
    const core = new CoreService(opts);
    try {
      await new Promise<void>((resolve, reject) => {
        core.server.once('error', reject);
        core.server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
      });
    } catch (err) {
      releaseLock(opts.home);
      throw err;
    }
    core.boundPort = (core.server.address() as { port: number }).port;
    writeCoreFile(opts.home, { port: core.boundPort, token: core.token, pid: process.pid, version: opts.version, startedAt: core.startedAt });
    writeCoreRoute(opts.home, core.boundPort, core.hookToken, process.pid);
    // From now on, hooks that find neither a window nor a running core are kept for the next core.
    openHookSpool(opts.home);
    core.log(`snagboat core ${opts.version} listening on 127.0.0.1:${core.boundPort} (pid ${process.pid})`);

    // Hooks spooled while no core ran, then events spooled for workspaces a window had claimed.
    const ingest = async () => {
      try {
        const hooks = await ingestHookSpool(opts.home, async (projectDir, payload, at) => void (await core.deliverHook(projectDir, payload, at)));
        if (hooks > 0) core.log(`read ${hooks} spooled hook(s)`);
        const events = await core.writer.ingestSpool();
        if (events > 0) core.log(`ingested ${events} spooled event(s)`);
      } catch (err) {
        core.log(`spool ingest failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    // Retention for the workspaces the core owns (no window has them), after the spools are in.
    const retention = async () => {
      try {
        const days = await core.writer.runRetention();
        if (days > 0) core.log(`retention: rolled up or removed text from ${days} day(s)`);
      } catch (err) {
        core.log(`retention failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    void ingest().then(retention);
    core.timers.push(setInterval(ingest, opts.ingestEveryMs ?? 30_000));
    core.timers.push(setInterval(retention, opts.retentionEveryMs ?? RETENTION_INTERVAL_MS));
    // Heuristics such as "stalled" fire on the absence of events, so followed workspaces are also evaluated on a timer.
    core.timers.push(setInterval(() => core.findings.tick(), opts.heuristicsEveryMs ?? HEURISTICS_INTERVAL_MS));
    if (opts.collect ?? true) {
      const checkpoints = new CheckpointStore(path.join(userDataDir(opts.home), 'core'));
      await checkpoints.init();
      core.collector = new ClaudeCollector({
        projectsDir: opts.claudeProjectsDir ?? defaultProjectsDir(),
        checkpoints,
        workspaceFor: (projectDir) => core.workspaceFor(projectDir),
        captureContent: (projectDir) => core.settingsFor(projectDir).captureContent !== false,
        deliver: (events, projectDir) => {
          // Collecting counts as activity: the core stays up while an agent is working.
          core.lastActivity = Date.now();
          // A window that claimed the workspace to write it reads this very transcript folder itself
          // when the project is its folder: drop. A session started in a subfolder it never reads,
          // or a client window holding the folder for a rewrite (it reads no transcripts): keep.
          return core.writer.write(events, (e, claim) => (!claim.hold && workspaceInfoOf(e.workspace!).folder === projectDir ? 'drop' : 'spool'));
        },
        log: (line) => core.log(line),
      });
      await core.collector.start();
      core.copilot = new CopilotCollector({
        checkpoints,
        sessionsDir: opts.copilotSessionsDir,
        workspaceFor: (cwd) => core.workspaceFor(cwd),
        captureContent: (cwd) => core.settingsFor(cwd).captureContent !== false,
        deliver: (events, cwd) => {
          core.lastActivity = Date.now();
          // A window writing its folder itself reads the Copilot sessions started inside it: drop those.
          return core.writer.write(events, (e, claim) => {
            const folder = workspaceInfoOf(e.workspace!).folder;
            return !claim.hold && folder && isWithinFolders(cwd, withRealPaths([folder])) ? 'drop' : 'spool';
          });
        },
        log: (line) => core.log(line),
      });
      await core.copilot.start();
    }
    const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    if (idleMs > 0) {
      core.timers.push(
        setInterval(() => {
          if (core.streams > 0) core.lastActivity = Date.now();
          if (Date.now() - core.lastActivity >= idleMs) {
            core.log(`idle for ${Math.round(idleMs / 1000)}s; stopping`);
            void core.stop();
          }
        }, Math.min(idleMs, 60_000))
      );
    }
    for (const t of core.timers) t.unref();
    return core;
  }

  /** Stops the core. final: stopped on purpose (snagboat core stop), so clients shouldn't start another. */
  async stop(opts: { final?: boolean } = {}): Promise<void> {
    if (this.stopping) return this.stopped;
    this.stopping = true;
    if (opts.final) {
      // Said and closed before the connections are cut, so each client hears it (and doesn't start another core).
      const said = [...this.stoppingStreams].map((say) => say());
      await Promise.race([Promise.all(said), new Promise((r) => setTimeout(r, 1_000).unref())]);
    }
    for (const t of this.timers) clearInterval(t);
    this.collector?.stop();
    this.copilot?.stop();
    await this.findings.dispose().catch(() => undefined);
    removeCoreRoute(this.opts.home, process.pid);
    removeCoreFile(this.opts.home, process.pid);
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    await closed;
    releaseLock(this.opts.home);
    this.resolveStopped();
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  private scopeOf(req: http.IncomingMessage): Scope | undefined {
    const given = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    if (tokenEquals(given, this.token)) return { admin: true };
    for (const [token, workspaces] of this.workspaceTokens) if (tokenEquals(given, token)) return { admin: false, workspaces };
    return undefined;
  }

  private async readBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new HttpError(413, 'request body too large');
      chunks.push(chunk as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'body is not JSON');
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.lastActivity = Date.now();
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    };
    try {
      if (req.method === 'POST' && req.url === '/hook') return send(200, await this.hook(req));
      const scope = this.scopeOf(req);
      if (!scope) {
        req.resume();
        return send(401, { error: 'missing or unknown token' });
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /health') return send(200, { ok: true, version: this.opts.version, pid: process.pid, startedAt: this.startedAt, features: CORE_FEATURES });
      if (route === 'POST /retention') {
        req.resume();
        return send(200, { changed: await this.writer.runRetention((w) => scope.admin || scope.workspaces.includes(w)) });
      }
      if (route === 'POST /tokens') return send(200, this.mintToken(scope, await this.readBody(req)));
      if (route === 'GET /events/stream') return this.stream(scope, url.searchParams.get('changedSince'), req, res);
      if (route === 'POST /flush') {
        req.resume();
        return send(200, { ingested: await this.writer.flush() });
      }
      if (route === 'POST /events') return send(200, await this.postEvents(scope, await this.readBody(req)));
      if (route === 'GET /findings') return send(200, await this.currentFindings(scope, url.searchParams.get('workspace')));
      if (route === 'GET /sessions') return send(200, await this.sessions(scope, url.searchParams.get('days')));
      if (req.method === 'GET' && url.pathname.startsWith('/sessions/')) return send(200, await this.session(scope, decodeURIComponent(url.pathname.slice('/sessions/'.length))));
      if (route === 'POST /shutdown') {
        if (!scope.admin) throw new HttpError(403, 'only the admin token can stop the core');
        send(200, { stopping: true });
        setImmediate(() => void this.stop({ final: true }));
        return;
      }
      req.resume();
      send(404, { error: `no such endpoint: ${route}` });
    } catch (err) {
      req.resume();
      if (err instanceof HttpError) return send(err.status, { error: err.message });
      this.log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      send(500, { error: 'internal error' });
    }
  }

  /** A project folder's settings (config.json, .snagboat.json), cached for a few seconds: collectors ask per chunk. */
  settingsFor(dir: string): Record<string, unknown> {
    const hit = this.settingsCache.get(dir);
    if (hit && Date.now() - hit.at < 5_000) return hit.values;
    const values = effectiveSettings(this.opts.home, dir).values;
    this.settingsCache.set(dir, { at: Date.now(), values });
    return values;
  }

  /** The workspace a project's activity is recorded under, or undefined when it's not recorded (workspaces.ts). */
  workspaceFor(projectDir: string): string | undefined {
    const aliases = new Map<string, string>();
    for (const folders of this.tokenFolders.values()) for (const [folder, workspace] of folders) aliases.set(folder, workspace);
    return collectedWorkspace(this.opts.home, projectDir, knownWorkspaceFolders(this.opts.home, [...this.workspaceTokens.values()].flat()), aliases);
  }

  private async hook(req: http.IncomingMessage) {
    const given = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    if (!tokenEquals(given, this.hookToken) && !tokenEquals(given, this.token)) throw new HttpError(401, 'missing or unknown token');
    const projectDir = projectDirHeader(req.headers['x-snagboat-project-dir'], req.headers['x-snagboat-project-dir-hex']);
    if (!projectDir) throw new HttpError(400, 'missing X-Snagboat-Project-Dir');
    return this.deliverHook(projectDir, await this.readBody(req), new Date().toISOString());
  }

  /**
   * Records a hook for the workspace containing its project. Answers 200 even
   * when it records nothing (no known workspace, or a payload that isn't a hook
   * Snagboat records), so the script doesn't spool what would be dropped anyway.
   */
  async deliverHook(projectDir: string, payload: unknown, receivedAt: string) {
    const workspace = this.workspaceFor(projectDir);
    if (!workspace) return { recorded: false, reason: "the project's settings say not to record it" };
    const event = hookEvent(payload, receivedAt);
    if (!event) return { recorded: false, reason: 'not a hook Snagboat records' };
    return { recorded: true, ...(await this.writer.write([{ ...event, workspace }])) };
  }

  private mintToken(scope: Scope, body: unknown): { token: string; workspaces: string[] } {
    if (!scope.admin) throw new HttpError(403, 'only the admin token can mint tokens');
    const workspaces = (body as { workspaces?: unknown })?.workspaces;
    if (!Array.isArray(workspaces) || workspaces.length === 0 || !workspaces.every((w) => typeof w === 'string' && w.length > 0)) {
      throw new HttpError(400, 'body must be { "workspaces": ["<workspace>", ...] }');
    }
    const folders = (body as { folders?: unknown })?.folders;
    if (folders !== undefined && (!Array.isArray(folders) || workspaces.length !== 1 || !folders.every((f) => typeof f === 'string' && path.isAbsolute(f)))) {
      throw new HttpError(400, 'folders must be absolute paths, for exactly one workspace');
    }
    const token = crypto.randomBytes(32).toString('hex');
    this.workspaceTokens.set(token, [...new Set(workspaces as string[])]);
    if (folders && folders.length > 0) this.tokenFolders.set(token, new Map((folders as string[]).map((f) => [f, workspaces[0] as string])));
    return { token, workspaces: this.workspaceTokens.get(token)! };
  }

  private async postEvents(scope: Scope, body: unknown) {
    const list = Array.isArray(body) ? body : [body];
    const events: NormalizedEvent[] = [];
    for (const [i, e] of list.entries()) {
      if (!isEvent(e)) throw new HttpError(400, `event ${i} is not a NormalizedEvent`);
      let workspace = e.workspace;
      if (workspace === undefined) {
        if (scope.admin || scope.workspaces.length !== 1) throw new HttpError(400, `event ${i} needs a workspace`);
        workspace = scope.workspaces[0];
      } else if (!scope.admin && !scope.workspaces.includes(workspace)) {
        throw new HttpError(403, `event ${i} is for a workspace this token can't write`);
      }
      events.push({ ...e, workspace });
    }
    return this.writer.write(events);
  }

  /** GET /events/stream: a server-sent event per batch written to the scope's workspaces. */
  private stream(scope: Scope, changedSince: string | null, req: http.IncomingMessage, res: http.ServerResponse): void {
    const since = changedSince === null ? undefined : Date.parse(changedSince);
    if (since !== undefined && !Number.isFinite(since)) throw new HttpError(400, 'changedSince must be an ISO date');
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    const visible = (workspace: string) => scope.admin || scope.workspaces.includes(workspace);
    const send = (events: NormalizedEvent[]) => {
      for (let i = 0; i < events.length; i += STREAM_BATCH) res.write(`data: ${JSON.stringify(events.slice(i, i + STREAM_BATCH))}\n\n`);
    };
    // Registered before the replay, so nothing written meanwhile falls between the two (the client drops repeats by eventId).
    const stop = this.writer.onWritten((workspace, events) => visible(workspace) && send(events));
    const ping = setInterval(() => res.write(': ping\n\n'), STREAM_PING_MS);
    ping.unref();
    this.streams += 1;
    const sayStopping = () => new Promise<void>((resolve) => {
      res.once('close', () => resolve());
      res.end('event: stopping\ndata: {}\n\n');
    });
    this.stoppingStreams.add(sayStopping);
    // A workspace token's stream also carries its workspaces' findings: each change, and the current ones to start.
    const stopFindings = scope.admin
      ? undefined
      : this.followFindings(scope.workspaces, (result) => {
          if (!res.destroyed && visible(result.workspace)) res.write(`event: findings\ndata: ${JSON.stringify(result)}\n\n`);
        });
    res.on('close', () => {
      this.stoppingStreams.delete(sayStopping);
      stopFindings?.();
      stop();
      clearInterval(ping);
      this.streams -= 1;
      this.lastActivity = Date.now();
    });
    if (since === undefined) return;
    void (async () => {
      for (const store of this.visibleStores(scope)) {
        const log = new EventLog(store.dir);
        for (const day of await log.listDays()) {
          let mtime: number;
          try {
            mtime = fs.statSync(path.join(log.dir, `${day}.jsonl`)).mtimeMs;
          } catch {
            continue;
          }
          if (mtime >= since && !res.destroyed) send((await log.readDay(day)).map((e) => ({ ...e, workspace: store.workspace })));
        }
      }
      if (!res.destroyed) res.write('event: replayed\ndata: {}\n\n');
    })().catch((err) => this.log(`replay failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Follows the workspaces' findings for a stream; sends each one's current findings once it's followed. */
  private followFindings(workspaces: string[], send: (result: WorkspaceFindings) => void): () => void {
    this.findingsListeners.add(send);
    const unfollow: Array<() => void> = [];
    let stopped = false;
    for (const workspace of workspaces) {
      void this.findings
        .follow(workspace)
        .then(async (stop) => {
          if (stopped) return stop();
          unfollow.push(stop);
          const latest = await this.findings.latest(workspace);
          if (latest && !stopped) send(latest);
        })
        .catch((err) => this.log(`couldn't follow findings for ${workspace}: ${err instanceof Error ? err.message : String(err)}`));
    }
    return () => {
      stopped = true;
      this.findingsListeners.delete(send);
      for (const stop of unfollow) stop();
    };
  }

  /** GET /findings: the token's workspaces' findings now (the admin token names one with ?workspace=). */
  private async currentFindings(scope: Scope, workspace: string | null): Promise<WorkspaceFindings[]> {
    const list = scope.admin ? (workspace ? [workspace] : []) : workspace ? scope.workspaces.filter((w) => w === workspace) : scope.workspaces;
    if (list.length === 0) throw new HttpError(400, scope.admin ? 'the admin token needs ?workspace=<workspace>' : `this token can't read ${workspace}`);
    return Promise.all(list.map((w) => this.findings.current(w)));
  }

  private visibleStores(scope: Scope) {
    const stores = listUserStores(this.opts.home);
    return scope.admin ? stores : stores.filter((s) => scope.workspaces.includes(s.workspace));
  }

  private async sessions(scope: Scope, daysParam: string | null): Promise<Array<SessionSummary & { workspace: string }>> {
    let days: number | undefined;
    if (daysParam !== null) {
      days = Number(daysParam);
      if (!Number.isFinite(days) || days <= 0) throw new HttpError(400, 'days must be a positive number');
    }
    const all: Array<SessionSummary & { workspace: string }> = [];
    for (const store of this.visibleStores(scope)) for (const s of await storeSessions(store.dir)) all.push({ ...s, workspace: store.workspace });
    const since = days === undefined ? '' : new Date(Date.now() - days * 86_400_000).toISOString();
    return all.filter((s) => s.lastTs >= since).sort((a, b) => b.lastTs.localeCompare(a.lastTs));
  }

  private async session(scope: Scope, id: string): Promise<SessionSummary & { workspace: string }> {
    if (!id) throw new HttpError(404, 'session id missing');
    const found = (await this.sessions(scope, null)).filter((s) => s.sessionId === id || s.sessionId.startsWith(id));
    if (found.length === 0) throw new HttpError(404, `no session ${id}`);
    const exact = found.filter((s) => s.sessionId === id);
    if (exact.length === 1) return exact[0];
    if (found.length > 1) throw new HttpError(409, `${id} matches ${found.length} sessions; give more of the id`);
    return found[0];
  }
}
