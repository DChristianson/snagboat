import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { workspaceKey } from '../userStore';
import { claimWorkspace, releaseClaim } from './claims';
import { CoreInfo, coreRequest } from './coreFile';
import { ensureCore, findCore } from './lifecycle';
import { spoolDir } from './storeWriter';

/**
 * A front door's connection to the core for one workspace (3c-3c: a VS Code
 * window with snagboat.storage.perUserStore on). The core collects and writes;
 * the client
 *
 *   - follows the workspace's live feed (GET /events/stream), reconnecting,
 *     and starting the core again if it went away unexpectedly; a reconnect
 *     replays the day files changed while it was away, so nothing written
 *     meanwhile is missed (the receiver drops repeats by eventId). A core that
 *     says it's stopping (snagboat core stop) isn't replaced: the client
 *     reattaches when some other front door starts one;
 *   - posts the events only it sees (VS Code's edits, Copilot's telemetry),
 *     and if the core can't take them, spools them where the core picks them up;
 *   - holds the workspace's folder while a command rewrites days (claims.ts);
 *   - asks the core to apply the workspace's retention now.
 */

export interface CoreClientOptions {
  home: string;
  /** dist/snagboat.js, run to start a core when none is running. */
  cliPath: string;
  workspace: string;
  /** A saved multi-root workspace's folders: the core records projects in them under `workspace`. */
  folders?: string[];
  log?: (line: string) => void;
  /** Starts or finds the core; ensureCore by default (tests pass their own). */
  ensure?: () => Promise<CoreInfo>;
  /** Finds a running core without starting one; findCore by default. */
  find?: () => Promise<CoreInfo | undefined>;
}

export interface StreamHandlers {
  onEvents: (events: NormalizedEvent[]) => void;
  /** After the replay of changed day files that follows each (re)connect. */
  onReplayed?: () => void;
}

/** What a core must offer (GET /health "features") for a client to use it. */
const REQUIRED_FEATURES = ['events-stream', 'flush', 'retention'];
const RETRY_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000];
/** How long a hold waits for the core to finish the writes it started. */
const FLUSH_TIMEOUT_MS = 60_000;

let spoolSeq = 0;

export class CoreClient {
  private info!: CoreInfo;
  private token!: string;
  private handlers?: StreamHandlers;
  private request?: http.ClientRequest;
  private retry?: NodeJS.Timeout;
  private failures = 0;
  private closed = false;
  /** The core said it was stopping on purpose: don't start another in its place. */
  private coreStopped = false;
  /** When the feed was last known complete: a reconnect replays what changed after it. */
  private upTo: string;
  private connecting?: Promise<void>;

  private constructor(private readonly opts: CoreClientOptions) {
    this.upTo = new Date().toISOString();
  }

  /** Finds or starts the core and gets a token for the workspace; throws if it can't. */
  static async connect(opts: CoreClientOptions): Promise<CoreClient> {
    const client = new CoreClient(opts);
    await client.authorize(await client.ensure());
    return client;
  }

  private ensure(): Promise<CoreInfo> {
    return (this.opts.ensure ?? (() => ensureCore(this.opts.home, this.opts.cliPath)))();
  }

  private async find(): Promise<CoreInfo | undefined> {
    return (this.opts.find ?? (() => findCore(this.opts.home)))();
  }

  private async authorize(info: CoreInfo): Promise<void> {
    // A core started by an older Snagboat has no live feed: say so rather than wait on it forever.
    const health = await coreRequest(info.port, info.token, 'GET', '/health');
    const features = (health.body as { features?: unknown })?.features;
    if (health.status !== 200 || !Array.isArray(features) || !REQUIRED_FEATURES.every((f) => features.includes(f))) {
      throw new Error(`the running core (version ${info.version}, pid ${info.pid}) is older than this extension; stop it with "snagboat core stop" and reload`);
    }
    const res = await coreRequest(info.port, info.token, 'POST', '/tokens', { workspaces: [this.opts.workspace], ...(this.opts.folders?.length ? { folders: this.opts.folders } : {}) });
    if (res.status !== 200) throw new Error(`the core refused a token for ${this.opts.workspace}: ${JSON.stringify(res.body)}`);
    this.info = info;
    this.token = (res.body as { token: string }).token;
  }

  /** The running core's pid (for the status of this window's storage). */
  get corePid(): number {
    return this.info.pid;
  }

  /**
   * Follows the live feed. changedSince: when what the caller already has was
   * read; day files changed after it are replayed first.
   */
  follow(handlers: StreamHandlers, changedSince: string): void {
    this.handlers = handlers;
    this.upTo = changedSince;
    this.open();
  }

  private open(): void {
    if (this.closed || !this.handlers) return;
    const handlers = this.handlers;
    // Anything written from here on reaches this stream; what came before, the replay covers.
    const opened = new Date(Date.now() - 2_000).toISOString();
    const req = http.get(
      {
        host: '127.0.0.1',
        port: this.info.port,
        path: `/events/stream?changedSince=${encodeURIComponent(this.upTo)}`,
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return this.lost(req, `the core answered ${res.statusCode}`, res.statusCode === 401);
        }
        res.setEncoding('utf8');
        let buffer = '';
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            this.message(block, handlers, opened);
          }
        });
        res.on('close', () => this.lost(req, 'the event stream closed', false));
      }
    );
    req.on('error', (err) => this.lost(req, err.message, false));
    this.request = req;
  }

  private message(block: string, handlers: StreamHandlers, opened: string): void {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return; // a comment (connected, ping)
    if (event === 'stopping') {
      this.coreStopped = true;
      return;
    }
    if (event === 'replayed') {
      this.failures = 0;
      this.coreStopped = false;
      this.upTo = opened;
      handlers.onReplayed?.();
      return;
    }
    try {
      const events = JSON.parse(data.join('\n')) as NormalizedEvent[];
      if (Array.isArray(events) && events.length > 0) handlers.onEvents(events);
    } catch (err) {
      this.opts.log?.(`a message from the core couldn't be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The stream ended: reconnect after a pause. Ignored for a request that's no longer the current one. */
  private lost(req: http.ClientRequest, why: string, unauthorized: boolean): void {
    if (this.closed || req !== this.request) return;
    req.destroy();
    this.request = undefined;
    this.retryLater(why, unauthorized);
  }

  private retryLater(why: string, unauthorized: boolean): void {
    if (this.closed) return;
    const delay = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)];
    this.failures += 1;
    this.opts.log?.(`lost the core (${why}); ${this.coreStopped ? 'it was stopped, so waiting for another to start' : 'reconnecting'} in ${delay / 1000}s`);
    this.retry = setTimeout(() => void this.reconnect(unauthorized), delay);
  }

  private reconnect(unauthorized: boolean): Promise<void> {
    this.connecting ??= (async () => {
      try {
        const pid = this.info.pid;
        // Stopped on purpose: only a core someone else starts. Otherwise start one if it's gone.
        const info = this.coreStopped ? await this.find() : await this.ensure();
        if (!info) throw new Error('no core running');
        // A new core knows no token minted by the old one.
        if (unauthorized || info.pid !== pid || info.port !== this.info.port) await this.authorize(info);
        this.open();
      } catch (err) {
        this.retryLater(err instanceof Error ? err.message : String(err), unauthorized);
      } finally {
        this.connecting = undefined;
      }
    })();
    return this.connecting;
  }

  /** A request with this client's token; on a 401 (the core restarted), one more try with a new token. */
  private async request401(method: string, urlPath: string, body: unknown, timeoutMs?: number) {
    let res = await coreRequest(this.info.port, this.token, method, urlPath, body, timeoutMs);
    if (res.status === 401) {
      const info = await this.find();
      if (!info) return res;
      await this.authorize(info);
      res = await coreRequest(this.info.port, this.token, method, urlPath, body, timeoutMs);
    }
    return res;
  }

  /** Sends events to the core for this workspace; spooled for the core to pick up if it can't take them now. */
  async post(events: NormalizedEvent[]): Promise<void> {
    if (events.length === 0) return;
    const tagged = events.map((e) => (e.workspace ? e : { ...e, workspace: this.opts.workspace }));
    try {
      const res = await this.request401('POST', '/events', tagged);
      if (res.status === 200) return;
      throw new Error(`the core answered ${res.status}: ${JSON.stringify(res.body)}`);
    } catch (err) {
      this.opts.log?.(`spooling ${tagged.length} event(s) for the core: ${err instanceof Error ? err.message : String(err)}`);
      await this.spool(tagged);
    }
  }

  /**
   * A file of its own, written then renamed into place, so the core (which
   * renames a spool file before reading it) never reads one half-written or
   * takes one while this is still appending.
   */
  private async spool(events: NormalizedEvent[]): Promise<void> {
    const dir = spoolDir(this.opts.home);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const name = `${workspaceKey(this.opts.workspace)}.w${process.pid}-${Date.now()}-${(spoolSeq += 1)}.jsonl`;
    const temp = path.join(dir, `${name}.tmp`);
    await fs.promises.writeFile(temp, events.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
    await fs.promises.rename(temp, path.join(dir, name));
  }

  /**
   * Runs op with the workspace's folder held: the core writes nothing there
   * meanwhile (it spools), and ingests what it spooled once op is done. If
   * the core can't confirm it has finished the writes it started, op doesn't
   * run: rewriting a day under one of them could lose it.
   */
  async hold<T>(storeDir: string, op: () => Promise<T>): Promise<T> {
    claimWorkspace(storeDir, process.pid, { hold: true });
    try {
      await this.flush();
      return await op();
    } finally {
      releaseClaim(storeDir);
      await this.flush().catch((err) => this.opts.log?.(`the core will pick up what it spooled later: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  /** Waits for the core's writes in flight. No core running counts as done: nothing is writing. */
  private async flush(): Promise<void> {
    let res;
    try {
      res = await this.request401('POST', '/flush', {}, FLUSH_TIMEOUT_MS);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED' && !(await this.find())) return;
      throw new Error(`the core didn't confirm its writes were done: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status !== 200) throw new Error(`the core answered ${res.status} to a flush`);
  }

  /** Applies the workspace's retention now (its settings changed); how many days changed, 0 if no core answers. */
  async retention(): Promise<number> {
    try {
      const res = await this.request401('POST', '/retention', {}, 120_000);
      return res.status === 200 ? Number((res.body as { changed?: number }).changed ?? 0) : 0;
    } catch {
      return 0;
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retry);
    this.request?.destroy();
    this.request = undefined;
  }
}
