import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { workspaceKey } from '../userStore';
import { claimWorkspace, releaseClaim } from './claims';
import { CoreInfo, coreRequest } from './coreFile';
import { ensureCore } from './lifecycle';
import { spoolDir } from './storeWriter';

/**
 * A front door's connection to the core for one workspace (3c-3c: a VS Code
 * window with snagboat.storage.perUserStore on). The core collects and writes;
 * the client
 *
 *   - follows the workspace's live feed (GET /events/stream), reconnecting,
 *     and starting the core again, if it goes away; a reconnect replays the
 *     day files changed while it was away, so nothing written meanwhile is
 *     missed (the receiver drops repeats by eventId);
 *   - posts the events only it sees (VS Code's edits, Copilot), and if the core
 *     can't take them, spools them where the core picks them up;
 *   - holds the workspace's folder while a command rewrites days (claims.ts).
 */

export interface CoreClientOptions {
  home: string;
  /** dist/snagboat.js, run to start a core when none is running. */
  cliPath: string;
  workspace: string;
  log?: (line: string) => void;
  /** Starts or finds the core; ensureCore by default (tests pass their own). */
  ensure?: () => Promise<CoreInfo>;
}

export interface StreamHandlers {
  onEvents: (events: NormalizedEvent[]) => void;
  /** After the replay of changed day files that follows each (re)connect. */
  onReplayed?: () => void;
}

const RETRY_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000];

export class CoreClient {
  private info!: CoreInfo;
  private token!: string;
  private handlers?: StreamHandlers;
  private request?: http.ClientRequest;
  private retry?: NodeJS.Timeout;
  private failures = 0;
  private closed = false;
  /** When the feed was last known complete: a reconnect replays what changed after it. */
  private upTo: string;
  private connecting?: Promise<void>;

  private constructor(private readonly opts: CoreClientOptions) {
    this.upTo = new Date().toISOString();
  }

  /** Finds or starts the core and gets a token for the workspace; throws if it can't. */
  static async connect(opts: CoreClientOptions): Promise<CoreClient> {
    const client = new CoreClient(opts);
    await client.authorize();
    return client;
  }

  private async authorize(): Promise<void> {
    this.info = await (this.opts.ensure ?? (() => ensureCore(this.opts.home, this.opts.cliPath)))();
    const res = await coreRequest(this.info.port, this.info.token, 'POST', '/tokens', { workspaces: [this.opts.workspace] });
    if (res.status !== 200) throw new Error(`the core refused a token for ${this.opts.workspace}: ${JSON.stringify(res.body)}`);
    this.token = (res.body as { token: string }).token;
    // A core started by an older Snagboat has no live feed (or flush): say so rather than wait on it forever.
    const probe = await coreRequest(this.info.port, this.token, 'POST', '/flush', {}, 60_000);
    if (probe.status === 404) {
      throw new Error(`the running core (version ${this.info.version}, pid ${this.info.pid}) is older than this extension; stop it with "snagboat core stop" and reload`);
    }
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
          return this.lost(`the core answered ${res.statusCode}`, res.statusCode === 401);
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
        res.on('close', () => this.lost('the event stream closed', false));
      }
    );
    req.on('error', (err) => this.lost(err.message, false));
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
    if (event === 'replayed') {
      this.failures = 0;
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

  /** The stream ended: reconnect after a pause, starting the core again and getting a new token if needed. */
  private lost(why: string, unauthorized: boolean): void {
    if (this.closed || this.request === undefined) return; // already handled (error, then close)
    this.request.destroy();
    this.request = undefined;
    this.retryLater(why, unauthorized);
  }

  private retryLater(why: string, unauthorized: boolean): void {
    if (this.closed) return;
    const delay = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)];
    this.failures += 1;
    this.opts.log?.(`lost the core (${why}); reconnecting in ${delay / 1000}s`);
    this.retry = setTimeout(() => void this.reconnect(unauthorized), delay);
  }

  private reconnect(unauthorized: boolean): Promise<void> {
    this.connecting ??= (async () => {
      try {
        const pid = this.info.pid;
        if (unauthorized) await this.authorize();
        else {
          this.info = await (this.opts.ensure ?? (() => ensureCore(this.opts.home, this.opts.cliPath)))();
          // A new core knows no token minted by the old one.
          if (this.info.pid !== pid) await this.authorize();
        }
        this.open();
      } catch (err) {
        this.retryLater(err instanceof Error ? err.message : String(err), unauthorized);
      } finally {
        this.connecting = undefined;
      }
    })();
    return this.connecting;
  }

  /** Sends events to the core for this workspace; spooled for the core to pick up if it can't take them now. */
  async post(events: NormalizedEvent[]): Promise<void> {
    if (events.length === 0) return;
    const tagged = events.map((e) => (e.workspace ? e : { ...e, workspace: this.opts.workspace }));
    try {
      const res = await coreRequest(this.info.port, this.token, 'POST', '/events', tagged);
      if (res.status === 200) return;
      throw new Error(`the core answered ${res.status}: ${JSON.stringify(res.body)}`);
    } catch (err) {
      this.opts.log?.(`spooling ${tagged.length} event(s) for the core: ${err instanceof Error ? err.message : String(err)}`);
      const dir = spoolDir(this.opts.home);
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.promises.appendFile(path.join(dir, `${workspaceKey(this.opts.workspace)}.jsonl`), tagged.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
    }
  }

  /**
   * Runs op with the workspace's folder held: the core writes nothing there
   * meanwhile (it spools), and ingests what it spooled once op is done.
   */
  async hold<T>(storeDir: string, op: () => Promise<T>): Promise<T> {
    claimWorkspace(storeDir, process.pid, { hold: true });
    try {
      await this.flush(); // a write the core had already started is on disk
      return await op();
    } finally {
      releaseClaim(storeDir);
      await this.flush().catch(() => undefined);
    }
  }

  private async flush(): Promise<void> {
    const res = await coreRequest(this.info.port, this.token, 'POST', '/flush', {}, 60_000).catch(() => undefined);
    if (res && res.status !== 200) throw new Error(`the core answered ${res.status} to a flush`);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retry);
    this.request?.destroy();
    this.request = undefined;
  }
}
