/**
 * Summarizes a Copilot structure capture (snagboat.copilot.captureStructure)
 * so Copilot's spans can be mapped to Snagboat events. Dev tooling only.
 *
 *   npm run summarize:copilot [-- <capture.jsonl> ...]
 *
 * Defaults to every capture file in VS Code's global storage for Snagboat.
 * Captures hold no text values (strings are stored as their length), so the
 * summary can't contain any either.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface SpanRecord {
  name: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  startTimeUnixNano?: string;
  status?: number;
  attributes: Record<string, unknown>;
}

function defaultFiles(): string[] {
  const base =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage')
      : path.join(os.homedir(), '.config', 'Code', 'User', 'globalStorage');
  const dir = path.join(base, 'dchristianson.snagboat', 'copilot-structure');
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export function summarize(records: any[]): string[] {
  const spans: SpanRecord[] = [];
  const resourceKeys = new Map<string, number>();
  const metrics = new Map<string, Set<string>>();
  for (const r of records) {
    const s = r?.structure;
    if (s?.signal === 'traces') {
      for (const res of s.resources ?? []) {
        for (const k of Object.keys(res.resource ?? {})) resourceKeys.set(k, (resourceKeys.get(k) ?? 0) + 1);
        spans.push(...(res.spans ?? []));
      }
    } else if (s?.signal === 'metrics') {
      for (const res of s.resources ?? [])
        for (const m of res.metrics ?? []) {
          const keys = metrics.get(m.name) ?? new Set<string>();
          for (const dp of m.dataPoints ?? []) for (const k of Object.keys(dp.attributes ?? {})) keys.add(k);
          metrics.set(m.name, keys);
        }
    }
  }
  const byId = new Map(spans.filter((s) => s.spanId).map((s) => [s.spanId!, s]));
  const out: string[] = [`${records.length} payloads, ${spans.length} spans, ${new Set(spans.map((s) => s.traceId)).size} traces`];

  out.push('', 'Resource attributes: ' + ([...resourceKeys.keys()].sort().join(', ') || '(none)'));

  const names = [...new Set(spans.map((s) => s.name))].sort();
  for (const name of names) {
    const mine = spans.filter((s) => s.name === name);
    const parents = new Map<string, number>();
    for (const s of mine) {
      const parent = s.parentSpanId ? byId.get(s.parentSpanId)?.name ?? '(parent not captured)' : '(root)';
      parents.set(parent, (parents.get(parent) ?? 0) + 1);
    }
    out.push('', `span "${name}" ×${mine.length}; parent: ${[...parents].map(([p, n]) => `${p} ×${n}`).join(', ')}`);
    const keys = new Map<string, unknown[]>();
    for (const s of mine) for (const [k, v] of Object.entries(s.attributes ?? {})) keys.set(k, [...(keys.get(k) ?? []), v]);
    for (const [k, values] of [...keys].sort(([a], [b]) => a.localeCompare(b))) {
      const nums = values.filter((v): v is number => typeof v === 'number');
      const kind = nums.length === values.length ? `number ${Math.min(...nums)}–${Math.max(...nums)}` : typeof values[0] === 'boolean' ? 'boolean' : 'text (lengths only)';
      out.push(`    ${k}: ${kind}, on ${values.length}/${mine.length}`);
    }
  }

  if (metrics.size > 0) {
    out.push('', 'Metrics:');
    for (const [name, keys] of metrics) out.push(`    ${name}: attributes ${[...keys].sort().join(', ') || '(none)'}`);
  }

  // One example trace as a tree (the largest one), by span name only.
  const traces = new Map<string, SpanRecord[]>();
  for (const s of spans) if (s.traceId) traces.set(s.traceId, [...(traces.get(s.traceId) ?? []), s]);
  const biggest = [...traces.values()].sort((a, b) => b.length - a.length)[0];
  if (biggest) {
    out.push('', `Example trace (${biggest.length} spans):`);
    const children = new Map<string, SpanRecord[]>();
    const ids = new Set(biggest.map((s) => s.spanId));
    const roots: SpanRecord[] = [];
    for (const s of [...biggest].sort((a, b) => String(a.startTimeUnixNano).localeCompare(String(b.startTimeUnixNano)))) {
      if (s.parentSpanId && ids.has(s.parentSpanId)) children.set(s.parentSpanId, [...(children.get(s.parentSpanId) ?? []), s]);
      else roots.push(s);
    }
    const walk = (s: SpanRecord, depth: number) => {
      const tokens = Object.entries(s.attributes ?? {}).filter(([k, v]) => /token/i.test(k) && typeof v === 'number').map(([k, v]) => `${k.replace(/^gen_ai\.usage\./, '')}=${v}`);
      out.push(`    ${'  '.repeat(depth)}${s.name}${tokens.length ? `  (${tokens.join(', ')})` : ''}`);
      for (const c of children.get(s.spanId ?? '') ?? []) walk(c, depth + 1);
    };
    for (const r of roots) walk(r, 0);
  }
  return out;
}

if (require.main === module) {
  const files = process.argv.length > 2 ? process.argv.slice(2) : defaultFiles();
  if (files.length === 0) {
    console.error('No captures found. Turn on snagboat.copilot.captureStructure, use Copilot Chat, then rerun (or pass capture .jsonl paths).');
    process.exit(1);
  }
  const records = files.flatMap((f) =>
    fs
      .readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
  );
  for (const line of summarize(records)) console.log(line);
}
