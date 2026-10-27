import * as crypto from 'crypto';
import * as http from 'http';
import * as path from 'path';
import { AdapterContext } from '../../core/types';
import { normalizeHookPayload } from './normalize';
import { isWithinFolders } from '../../core/paths';

function tokensMatch(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '');
  const expected = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}


/**
 * The project dir the routing script routed on. Header values arrive as raw
 * bytes read as latin1, so re-decode them as UTF-8 for non-ASCII paths.
 */
function projectDirHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === undefined ? undefined : Buffer.from(raw, 'latin1').toString('utf8');
}

/**
 * Local HTTP endpoint for Claude Code hook payloads, forwarded by the routing
 * script (see hookRoutes.ts). Listens on a free port chosen by the OS, accepts
 * only requests carrying this window's token, and drops hooks whose project
 * (the script's X-Snagboat-Project-Dir, i.e. CLAUDE_PROJECT_DIR) is outside
 * this window's folders, which can happen when two folders' route names
 * collide. The payload's cwd is deliberately not checked: it follows Claude
 * into other directories and worktrees mid-session.
 */
export class HooksReceiver {
  private server?: http.Server;
  private workspaceFolders: string[];

  constructor(
    private readonly ctx: AdapterContext,
    private readonly opts: {
      token: string;
      workspaceFolders: string[];
      port?: number;
      turnFallback?: (sessionId: string) => string | undefined;
      /** Sessions whose hooks another adapter already covers (Copilot runs .claude/settings.json hooks too); dropped. */
      ignoreSession?: (sessionId: string) => boolean;
    }
  ) {
    this.workspaceFolders = opts.workspaceFolders;
  }

  /** Replaces the folders whose hooks are accepted, after workspace folders change. */
  setWorkspaceFolders(folders: string[]): void {
    this.workspaceFolders = folders;
  }

  /** Resolves with the bound port once listening; rejects if it can't listen. */
  start(): Promise<number> {
    this.server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      if (!tokensMatch(req.headers.authorization, this.opts.token)) {
        res.writeHead(401).end();
        req.resume();
        return;
      }
      const projectDir = projectDirHeader(req.headers['x-snagboat-project-dir']);
      if (!projectDir || !isWithinFolders(projectDir, this.workspaceFolders)) {
        res.writeHead(421).end(); // Misdirected Request: not this window's project
        req.resume();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200).end();
        const raw = Buffer.concat(chunks).toString('utf8');
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          // Payloads carry tool inputs and outputs (file contents, commands), and
          // JSON.parse errors quote part of their input, so log only the size.
          console.warn(`snagboat: failed to parse hook payload as JSON (${raw.length} bytes)`);
          return;
        }
        const event = normalizeHookPayload(payload, this.opts.turnFallback);
        if (event && this.opts.ignoreSession?.(event.sessionId)) return;
        if (event) {
          this.ctx.publish(event);
        } else {
          console.warn(`snagboat: hook payload did not map to a NormalizedEvent (${describeHookPayload(payload)}, ${raw.length} bytes)`);
        }
      });
    });
    const server = this.server;
    return new Promise((resolve, reject) => {
      server.once('error', (err) => {
        this.ctx.reportHealth('hooksReceiver', `failed to start the hook receiver: ${err.message}`);
        reject(err);
      });
      server.listen(this.opts.port ?? 0, '127.0.0.1', () => {
        this.ctx.reportHealth('hooksReceiver', undefined);
        resolve((server.address() as { port: number }).port);
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
  }
}

/** Identifies a hook payload for diagnostics by its event and tool names only, never its contents. */
function describeHookPayload(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return typeof payload;
  const p = payload as Record<string, unknown>;
  const field = (key: string) => (typeof p[key] === 'string' ? (p[key] as string) : '?');
  return `hook_event_name=${field('hook_event_name')} tool_name=${field('tool_name')}`;
}
