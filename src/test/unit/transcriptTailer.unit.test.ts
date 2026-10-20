import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TranscriptTailer } from '../../adapters/claude-code/transcriptTail';
import { SeenMessages } from '../../adapters/claude-code/normalize';
import { AdapterContext, NormalizedEvent } from '../../core/types';

// These run the real chokidar watcher (fs.watch, as in the packaged
// extension), so they wait on real file system events.

function assistantLine(id: string): string {
  return (
    JSON.stringify({
      type: 'assistant',
      uuid: id,
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      message: { id: `msg_${id}`, model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 5 } },
    }) + '\n'
  );
}

function fakeCtx(onPublish: (e: NormalizedEvent) => void = () => undefined) {
  const published: NormalizedEvent[] = [];
  const health = new Map<string, string>();
  const ctx: AdapterContext = {
    publish: (e) => {
      onPublish(e);
      published.push(e);
    },
    readCheckpoint: async () => undefined,
    writeCheckpoint: async () => undefined,
    reportHealth: (key, message) => (message === undefined ? health.delete(key) : health.set(key, message)),
    captureContent: () => false,
  };
  return { ctx, published, health };
}

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor: timed out'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function tempDir(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'snagboat-tailer-'));
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('a transcripts folder created after start is found by the periodic check and read from the top', async () => {
    const root = await tempDir();
    const dir = path.join(root, '-project'); // does not exist yet
    const { ctx, published, health } = fakeCtx();
    const tailer = new TranscriptTailer(ctx, dir, new Map(), new SeenMessages(), () => undefined, 200);
    tailer.start();
    try {
      assert.strictEqual(health.size, 0, 'a missing folder is normal, not a health issue');
      await new Promise((r) => setTimeout(r, 300));
      await fs.promises.mkdir(dir);
      await fs.promises.writeFile(path.join(dir, 'session.jsonl'), assistantLine('a') + assistantLine('b'));
      await waitFor(() => published.length === 2);
      await fs.promises.appendFile(path.join(dir, 'session.jsonl'), assistantLine('c'));
      await waitFor(() => published.length === 3);
    } finally {
      tailer.stop();
    }
  });

  test('a new session file in an existing folder is picked up', async () => {
    const dir = await tempDir();
    await fs.promises.writeFile(path.join(dir, 'old.jsonl'), assistantLine('a'));
    const { ctx, published } = fakeCtx();
    const tailer = new TranscriptTailer(ctx, dir, new Map(), new SeenMessages(), () => undefined, 60_000);
    tailer.start();
    try {
      await waitFor(() => published.length === 1);
      await fs.promises.writeFile(path.join(dir, 'new.jsonl'), assistantLine('b'));
      await waitFor(() => published.length === 2);
    } finally {
      tailer.stop();
    }
  });

  test('a failed read is reported as a health issue for that file and cleared by the next good read', async () => {
    const dir = await tempDir();
    let failNext = true;
    const { ctx, published, health } = fakeCtx(() => {
      if (failNext) {
        failNext = false;
        throw new Error('boom');
      }
    });
    const tailer = new TranscriptTailer(ctx, dir, new Map(), new SeenMessages(), () => undefined, 60_000);
    tailer.start();
    try {
      await new Promise((r) => setTimeout(r, 300));
      await fs.promises.writeFile(path.join(dir, 'session.jsonl'), assistantLine('a'));
      await waitFor(() => health.has('transcript:session.jsonl'));
      assert.match(health.get('transcript:session.jsonl')!, /failed reading session\.jsonl: boom/);

      await fs.promises.appendFile(path.join(dir, 'session.jsonl'), assistantLine('b'));
      await waitFor(() => !health.has('transcript:session.jsonl'));
      assert.ok(published.length >= 2, 'the unread line is retried, since the offset only advances after a good read');
    } finally {
      tailer.stop();
    }
  });

  test('no workspace folder is reported as a health issue', () => {
    const { ctx, health } = fakeCtx();
    new TranscriptTailer(ctx, undefined, new Map(), new SeenMessages(), () => undefined).start();
    assert.ok(health.has('transcripts'));
  });

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
  if (failures > 0) process.exit(1);
  process.exit(0);
}

main();
