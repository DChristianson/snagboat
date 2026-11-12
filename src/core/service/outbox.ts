import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { isProcessAlive } from '../processes';
import { isWithinFolders } from '../paths';
import {
  formatRelayInfo,
  outboxFileName,
  outboxTempName,
  RELAY_GITIGNORE,
  RELAY_GITIGNORE_FILE,
  RELAY_INFO_FILE,
  RELAY_MAX_FILE_BYTES,
  RELAY_MAX_LINE_BYTES,
  RELAY_VERSION,
  relayCheckpointsDir,
  relayDir,
  RelayInfo,
  relayOutboxDir,
} from '../relay';
import { WriteResult } from './storeWriter';

/**
 * The container side of the relay (core/relay.ts, bead snagboat-xe5). A core
 * started with SNAGBOAT_RELAY_ROOT writes what its collectors and hooks produce
 * here instead of the per-user store: each write call becomes one file in
 * outbox/, written under a dot-name and renamed, so the host only ever sees
 * complete files. The host deletes each file once it has read it, and dedupes
 * by eventId, so a batch sent twice does no harm.
 */

/** Where a batch is split into another outbox file: well under RELAY_MAX_FILE_BYTES. */
export const OUTBOX_FILE_TARGET_BYTES = RELAY_MAX_FILE_BYTES / 4;

export interface RelayFolder {
  /** The project root, as given (absolute). */
  root: string;
  /** <root>/.snagboat/relay */
  dir: string;
  outbox: string;
}

/** Creates the relay folder for a project root: .gitignore if missing, relay.json refreshed, outbox/ and checkpoints/. */
export function prepareRelayFolder(root: string, host = os.hostname()): RelayFolder {
  if (!path.isAbsolute(root)) throw new Error(`SNAGBOAT_RELAY_ROOT must be an absolute folder (it's ${JSON.stringify(root)})`);
  root = path.resolve(root);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`SNAGBOAT_RELAY_ROOT is not a folder: ${root}`);
  const dir = relayDir(root);
  const outbox = relayOutboxDir(root);
  fs.mkdirSync(outbox, { recursive: true, mode: 0o700 });
  fs.mkdirSync(relayCheckpointsDir(root), { recursive: true, mode: 0o700 });
  const ignore = path.join(dir, RELAY_GITIGNORE_FILE);
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, RELAY_GITIGNORE);
  const info: RelayInfo = { version: RELAY_VERSION, root, host };
  const file = path.join(dir, RELAY_INFO_FILE);
  const temp = path.join(dir, `.${RELAY_INFO_FILE}.${process.pid}.tmp`);
  fs.writeFileSync(temp, formatRelayInfo(info));
  fs.renameSync(temp, file);
  // Half-written batches of a core that died mid-write: never renamed, so never sent.
  for (const name of fs.readdirSync(outbox)) {
    const m = /^\.\d+-(\d+)-\d+\.jsonl\.tmp$/.exec(name);
    if (m && (Number(m[1]) === process.pid || !isProcessAlive(Number(m[1])))) fs.rmSync(path.join(outbox, name), { force: true });
  }
  return { root, dir, outbox };
}

export class OutboxWriter {
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly folder: RelayFolder, private readonly now: () => number = Date.now) {}

  /** Appends the events whose workspace is inside the root to the outbox, in one file or several; the rest are dropped (the host couldn't map them). */
  write(events: NormalizedEvent[]): Promise<WriteResult> {
    const run = this.queue.then(() => this.writeNow(events));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async writeNow(events: NormalizedEvent[]): Promise<WriteResult> {
    const kept = events.filter((e) => typeof e.workspace === 'string' && path.isAbsolute(e.workspace) && isWithinFolders(e.workspace, [this.folder.root]));
    const result: WriteResult = { written: kept.length, duplicates: 0, spooled: 0, dropped: events.length - kept.length };
    // The host skips a line over RELAY_MAX_LINE_BYTES and deletes a file over RELAY_MAX_FILE_BYTES unread,
    // so drop the one and split a large batch (a first read of long transcripts) across files well under the other.
    const lines: string[] = [];
    for (const e of kept) {
      const line = JSON.stringify(e) + '\n';
      if (Buffer.byteLength(line) > RELAY_MAX_LINE_BYTES) {
        result.written -= 1;
        result.dropped += 1;
      } else lines.push(line);
    }
    // The folder may have been removed (git clean): make it again rather than lose the batch.
    if (lines.length > 0) await fs.promises.mkdir(this.folder.outbox, { recursive: true, mode: 0o700 });
    let chunk: string[] = [];
    let bytes = 0;
    for (const line of lines) {
      const size = Buffer.byteLength(line);
      if (chunk.length > 0 && bytes + size > OUTBOX_FILE_TARGET_BYTES) {
        await this.writeFile(chunk);
        chunk = [];
        bytes = 0;
      }
      chunk.push(line);
      bytes += size;
    }
    if (chunk.length > 0) await this.writeFile(chunk);
    return result;
  }

  private async writeFile(lines: string[]): Promise<void> {
    const name = outboxFileName(this.now(), process.pid, (this.seq += 1));
    const temp = path.join(this.folder.outbox, outboxTempName(name));
    await fs.promises.writeFile(temp, lines.join(''), { mode: 0o600 });
    await fs.promises.rename(temp, path.join(this.folder.outbox, name));
  }
}
