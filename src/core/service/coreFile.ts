import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { isProcessAlive } from '../processes';

/**
 * ~/.snagboat/core.json: how front doors find the core service (the RFC's
 * local API). It holds the port, the admin token (which reads every
 * workspace and mints per-workspace tokens), the core's pid and version.
 * Owner-only (0600): the token is the key to every workspace's data. A file
 * whose pid has exited is stale; the next core to start replaces it.
 */

export interface CoreInfo {
  port: number;
  token: string;
  pid: number;
  version: string;
  startedAt: string;
}

export function coreFilePath(home: string): string {
  return path.join(home, 'core.json');
}

export function readCoreFile(home: string): CoreInfo | undefined {
  try {
    const info = JSON.parse(fs.readFileSync(coreFilePath(home), 'utf8')) as CoreInfo;
    return Number.isInteger(info.port) && Number.isInteger(info.pid) && typeof info.token === 'string' ? info : undefined;
  } catch {
    return undefined;
  }
}

/** core.json if its core is still running. */
export function liveCore(home: string): CoreInfo | undefined {
  const info = readCoreFile(home);
  return info && isProcessAlive(info.pid) ? info : undefined;
}

export function writeCoreFile(home: string, info: CoreInfo): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = coreFilePath(home);
  const temp = `${file}.${info.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** Removes core.json if it's still this core's. */
export function removeCoreFile(home: string, pid: number): void {
  if (readCoreFile(home)?.pid === pid) fs.rmSync(coreFilePath(home), { force: true });
}

/**
 * ~/.snagboat/core.route: "<port> <hook token> <pid>", the same format as a
 * window's route file, so the hook script reads it the same way. The hook
 * token can only post hooks. Owner-only.
 */
export function coreRoutePath(home: string): string {
  return path.join(home, 'core.route');
}

export function writeCoreRoute(home: string, port: number, hookToken: string, pid: number): void {
  const file = coreRoutePath(home);
  const temp = `${file}.${pid}.tmp`;
  fs.writeFileSync(temp, `${port} ${hookToken} ${pid}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function removeCoreRoute(home: string, pid: number): void {
  try {
    if (Number(fs.readFileSync(coreRoutePath(home), 'utf8').trim().split(/\s+/)[2]) === pid) fs.rmSync(coreRoutePath(home), { force: true });
  } catch {
    // already gone
  }
}

export interface CoreResponse {
  status: number;
  body: unknown;
}

/** One request to the core with a token; the body is sent and read as JSON. Rejects if the core can't be reached. */
export function coreRequest(port: number, token: string, method: string, urlPath: string, body?: unknown, timeoutMs = 5_000): Promise<CoreResponse> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        timeout: timeoutMs,
        // A connection per request. Node's agent keeps connections alive by default, and the core closes an
        // idle one after 5 seconds: a core busy for that long (discovery on a slow machine) closed it just as
        // the next request went out on it, which failed with ECONNRESET. On 127.0.0.1 a new one costs nothing.
        agent: false,
        headers: { Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = undefined;
          try {
            parsed = text ? JSON.parse(text) : undefined;
          } catch {
            parsed = text;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('the core did not answer in time')));
    req.on('error', reject);
    req.end(data);
  });
}
