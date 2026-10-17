/**
 * Dev tooling for Claude Code transcripts; never shipped (esbuild bundles only
 * src/extension.ts).
 *
 *   npm run verify:transcripts [-- <file.jsonl> ...]
 *     Replays real transcripts through normalizeTranscriptChunk in random chunk
 *     sizes, with simulated restarts, and checks token totals against an
 *     independent count (each message.id's usage once). Defaults to this
 *     project's own transcripts under ~/.claude/projects. Prints totals only,
 *     never content.
 *
 *   node out/scripts/transcripts.js redact <in.jsonl> <out.jsonl> [maxLines]
 *     Writes an allowlist-redacted copy for use as a committed test fixture:
 *     structure, ids (renumbered), block types, and usage survive; all text,
 *     paths, and other fields are dropped.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeTranscriptChunk, SeenMessages } from '../adapters/claude-code/normalize';

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

const emptyTotals = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
const sum = (t: Totals) => t.input + t.output + t.cacheRead + t.cacheCreation;

function parse(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function addUsage(t: Totals, usage: any): void {
  t.input += usage?.input_tokens ?? 0;
  t.output += usage?.output_tokens ?? 0;
  t.cacheRead += usage?.cache_read_input_tokens ?? 0;
  t.cacheCreation += usage?.cache_creation_input_tokens ?? 0;
}

/** Ground truth, independent of the adapter: each message.id's usage once; lines without an id count individually. */
export function expectedTotals(lines: string[]): { totals: Totals; messages: number; usageLines: number } {
  const totals = emptyTotals();
  const seen = new Set<string>();
  let messages = 0;
  let usageLines = 0;
  for (const raw of lines) {
    const d = parse(raw);
    if (d?.type !== 'assistant' || !d.message?.usage) continue;
    usageLines++;
    const id = d.message.id;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    messages++;
    addUsage(totals, d.message.usage);
  }
  return { totals, messages, usageLines };
}

/** Deterministic PRNG so a failing replay can be reproduced from its seed. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Feeds lines to the adapter in random chunks (1-8 lines), and after roughly a
 * fifth of chunks simulates a restart by round-tripping SeenMessages through
 * its checkpoint snapshot.
 */
export function replayTotals(lines: string[], file: string, seed: number): { totals: Totals; events: number } {
  const rand = mulberry32(seed);
  let seen = new SeenMessages();
  const totals = emptyTotals();
  let events = 0;
  for (let i = 0; i < lines.length; ) {
    const size = 1 + Math.floor(rand() * 8);
    for (const e of normalizeTranscriptChunk(lines.slice(i, i + size), file, i, { captureContent: true, seen })) {
      events++;
      totals.input += e.tokens?.input ?? 0;
      totals.output += e.tokens?.output ?? 0;
      totals.cacheRead += e.tokens?.cacheRead ?? 0;
      totals.cacheCreation += e.tokens?.cacheCreation ?? 0;
    }
    i += size;
    if (rand() < 0.2) seen = new SeenMessages(JSON.parse(JSON.stringify(seen.snapshot())));
  }
  return { totals, events };
}

function defaultTranscripts(): string[] {
  const sanitized = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(os.homedir(), '.claude', 'projects', sanitized);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function verify(files: string[]): number {
  if (files.length === 0) {
    console.error('No transcripts found. Pass .jsonl paths explicitly.');
    return 1;
  }
  let failures = 0;
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    const expected = expectedTotals(lines);
    const perLine = emptyTotals();
    for (const raw of lines) {
      const d = parse(raw);
      if (d?.type === 'assistant' && d.message?.usage) addUsage(perLine, d.message.usage);
    }
    const seeds = [1, 2, 3, 4, 5];
    const mismatches = seeds.filter((seed) => JSON.stringify(replayTotals(lines, file, seed).totals) !== JSON.stringify(expected.totals));
    const ratio = sum(expected.totals) > 0 ? (sum(perLine) / sum(expected.totals)).toFixed(2) : 'n/a';
    console.log(
      `${path.basename(file)}: ${expected.messages} messages on ${expected.usageLines} usage lines; ` +
        `expected ${sum(expected.totals)} tokens, per-line counting gave ${sum(perLine)} (${ratio}x); ` +
        (mismatches.length === 0 ? `replay matched under ${seeds.length} chunkings` : `MISMATCH under seeds ${mismatches.join(', ')}`)
    );
    if (mismatches.length > 0) failures++;
  }
  return failures > 0 ? 1 : 0;
}

function redact(input: string, output: string, maxLines: number): void {
  const ids = new Map<string, string>();
  const rename = (prefix: string, id: unknown) => {
    if (typeof id !== 'string') return undefined;
    const key = `${prefix}:${id}`;
    if (!ids.has(key)) ids.set(key, `${prefix}-${ids.size + 1}`);
    return ids.get(key);
  };
  const out: string[] = [];
  for (const raw of fs.readFileSync(input, 'utf8').split('\n')) {
    if (out.length >= maxLines) break;
    const d = parse(raw);
    if (!d || typeof d.type !== 'string') continue;
    const line: Record<string, unknown> = { type: d.type, uuid: rename('u', d.uuid), parentUuid: rename('u', d.parentUuid) };
    if (d.type === 'assistant' || d.type === 'user') {
      line.sessionId = 'redacted-session';
      line.timestamp = d.timestamp;
      const m = d.message ?? {};
      const content = Array.isArray(m.content)
        ? m.content.map((b: any) => (b?.type === 'text' ? { type: 'text', text: '[redacted text]' } : { type: b?.type }))
        : typeof m.content === 'string'
          ? '[redacted text]'
          : undefined;
      line.message =
        d.type === 'assistant'
          ? {
              id: rename('msg', m.id),
              model: m.model,
              role: m.role,
              stop_reason: m.stop_reason,
              content,
              usage: m.usage && {
                input_tokens: m.usage.input_tokens,
                output_tokens: m.usage.output_tokens,
                cache_read_input_tokens: m.usage.cache_read_input_tokens,
                cache_creation_input_tokens: m.usage.cache_creation_input_tokens,
              },
            }
          : { role: m.role, content };
    }
    out.push(JSON.stringify(line));
  }
  fs.writeFileSync(output, out.join('\n') + '\n');
  console.log(`Wrote ${out.length} redacted lines to ${output}`);
}

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'redact') {
    redact(args[0], args[1], Number(args[2] ?? 120));
  } else if (cmd === 'verify') {
    process.exit(verify(args.length > 0 ? args : defaultTranscripts()));
  } else {
    console.error('usage: transcripts.js verify [files...] | redact <in> <out> [maxLines]');
    process.exit(2);
  }
}
