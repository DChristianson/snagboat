/**
 * Builds the web demo's example traces (docs/design/visualization-explorer.md,
 * "Demo data") from Snagboat's own daily event files, and a review report of
 * every piece of text in them. Dev tooling only; never shipped.
 *
 *   npm run demo:traces -- --events <events dir> [--events <dir> ...] --session <id or prefix> [...]
 *                          [--out web/demo/traces.js] [--report <file.md>]
 *
 * What goes in: only the named sessions' events, each slimmed to what the
 * session views read. Shell-command and file targets and the raw source
 * reference (a path) are dropped, event ids are renumbered, the home folder in
 * text becomes ~, and secrets are redacted again. Prompt text, reply excerpts,
 * and session names stay: the report lists all of them, flagged lines first,
 * so a person reads every word before the file is committed. The output isn't
 * meant to be committed unreviewed.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { redactSecrets } from '../core/excerpt';
import { NormalizedEvent } from '../core/types';

/** The fields of an event the demo keeps; everything else (target, raw, channel extras) is dropped. */
const KEPT: Array<keyof NormalizedEvent> = ['sessionId', 'agent', 'ts', 'kind', 'status', 'model', 'tokens', 'textExcerpt', 'promptText', 'sessionName', 'turnId', 'agentId', 'toolName', 'toolCategory', 'channel', 'endsTurn', 'contextLimit', 'compaction'];

/** Text fields, in the order the report lists them. */
const TEXT_FIELDS = ['sessionName', 'promptText', 'textExcerpt'] as const;
type TextField = (typeof TEXT_FIELDS)[number];

/** What a reviewer should look at twice. Each is a reason and a pattern; a match flags the line, nothing is changed. */
const FLAGS: Array<[string, RegExp]> = [
  ['email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['URL', /\bhttps?:\/\/\S+/i],
  ['absolute path', /(?:^|[\s"'`(])(?:~\/|\/(?:Users|home|private|var|etc|opt|tmp)\/)\S*/],
  ['Windows path', /\b[A-Z]:\\\S+/],
  ['IP address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
  ['phone number', /\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/],
  ['long token-like string', /\b[A-Za-z0-9_+/=-]{32,}\b/],
  ['secret word', /\b(?:password|passwd|secret|api[_ -]?key|private key|credential|token)s?\b/i],
  ['redaction marker', /\[redacted[^\]]*\]/],
  ['account or money', /\b(?:account|routing|iban|ssn|social security|credit card|salary|invoice)\b|\$\d/i],
];

export interface DemoTraceSet {
  /** The sessions in the order the page lists them; the first two are picked when the set opens. */
  picked: string[];
  events: NormalizedEvent[];
}

export interface TextLine {
  sessionId: string;
  ts: string;
  field: TextField;
  text: string;
  flags: string[];
}

/** Replaces the home folder with ~ wherever it appears, then redacts secrets again. */
export function scrubText(text: string, home: string): string {
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return redactSecrets(home ? text.replace(new RegExp(escaped, 'g'), '~') : text);
}

/** One event as the demo keeps it: the kept fields, text scrubbed, a new id, a raw that says where it came from. */
export function slimEvent(e: NormalizedEvent, id: string, home: string): NormalizedEvent {
  const out: Record<string, unknown> = { eventId: id };
  for (const k of KEPT) if (e[k] !== undefined) out[k] = e[k];
  for (const f of TEXT_FIELDS) if (typeof out[f] === 'string') out[f] = scrubText(out[f] as string, home);
  out.raw = { adapter: 'demo', ref: 'trace' };
  return out as unknown as NormalizedEvent;
}

/** The reasons a piece of text is flagged for a second look. */
export function flagText(text: string): string[] {
  return FLAGS.filter(([, re]) => re.test(text)).map(([why]) => why);
}

/**
 * The named sessions' events, slimmed, in time order within each session, ids
 * renumbered per session. A session is named by its id or a prefix of it; a
 * prefix that matches several sessions, or none, is an error.
 */
export function buildTraceSet(all: NormalizedEvent[], wanted: string[], home: string): DemoTraceSet {
  const ids = [...new Set(all.map((e) => e.sessionId))];
  const picked = wanted.map((w) => {
    const hits = ids.filter((id) => id.startsWith(w));
    if (hits.length !== 1) throw new Error(`demo:traces: "${w}" matches ${hits.length} sessions`);
    return hits[0];
  });
  const seen = new Set<string>();
  const events: NormalizedEvent[] = [];
  for (const sessionId of picked) {
    const mine = all
      .filter((e) => e.sessionId === sessionId && !seen.has(e.eventId) && seen.add(e.eventId))
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    mine.forEach((e, i) => events.push(slimEvent(e, `${sessionId.slice(0, 8)}-${i}`, home)));
  }
  return { picked, events };
}

/** Every piece of text in the set, flagged. */
export function textLines(set: DemoTraceSet): TextLine[] {
  const out: TextLine[] = [];
  for (const e of set.events)
    for (const field of TEXT_FIELDS) {
      const text = e[field];
      if (typeof text === 'string' && text.trim()) out.push({ sessionId: e.sessionId, ts: e.ts, field, text, flags: flagText(text) });
    }
  return out;
}

/** The file the page loads: a script, since the page's CSP forbids fetching. One event per line, so a diff reads. */
export function traceScript(set: DemoTraceSet): string {
  return [
    '// The web demo’s example traces: real Snagboat sessions, slimmed by `npm run demo:traces` (src/scripts/demoTraces.ts).',
    '// Every prompt, reply excerpt, and session name in here was read by a person before it was committed.',
    'window.snagboatDemoTraces = {',
    `  picked: ${JSON.stringify(set.picked)},`,
    '  events: [',
    ...set.events.map((e) => `    ${JSON.stringify(e)},`),
    '  ],',
    '};',
    '',
  ].join('\n');
}

/** The review report, in Markdown: a summary per session, the flagged lines, then every line. */
export function reviewReport(set: DemoTraceSet, lines: TextLine[]): string {
  const fence = (t: string) => ['````text', t, '````'].join('\n');
  const flagged = lines.filter((l) => l.flags.length);
  const out = ['# Demo traces: text to review', '', `${set.events.length} events in ${set.picked.length} sessions; ${lines.length} pieces of text, ${flagged.length} flagged.`, ''];
  out.push('| Session | Name | Events | Prompts | Replies | Characters |', '| --- | --- | --- | --- | --- | --- |');
  for (const id of set.picked) {
    const mine = lines.filter((l) => l.sessionId === id);
    const name = mine.find((l) => l.field === 'sessionName')?.text ?? '';
    out.push(`| ${id.slice(0, 8)} | ${name.replace(/\|/g, '\\|')} | ${set.events.filter((e) => e.sessionId === id).length} | ${mine.filter((l) => l.field === 'promptText').length} | ${mine.filter((l) => l.field === 'textExcerpt').length} | ${mine.reduce((n, l) => n + l.text.length, 0).toLocaleString()} |`);
  }
  out.push('', '## Flagged', '');
  if (!flagged.length) out.push('Nothing flagged.', '');
  for (const l of flagged) out.push(`- **${l.sessionId.slice(0, 8)} ${l.ts} ${l.field}**: ${l.flags.join(', ')}`, '', fence(l.text), '');
  for (const id of set.picked) {
    out.push(`## ${id}`, '');
    for (const l of lines.filter((x) => x.sessionId === id)) out.push(`**${l.ts} ${l.field}**${l.flags.length ? ` (flagged: ${l.flags.join(', ')})` : ''}`, '', fence(l.text), '');
  }
  return out.join('\n');
}

function readEvents(dirs: string[]): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const dir of dirs)
    for (const file of fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort())
      for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as NormalizedEvent);
        } catch {
          // a torn last line; the event log skips these too
        }
      }
  return out;
}

function main(argv: string[]): void {
  const dirs: string[] = [];
  const sessions: string[] = [];
  let outFile = path.join(__dirname, '..', '..', 'web', 'demo', 'traces.js');
  let report = '';
  for (let i = 0; i < argv.length; i++) {
    const v = argv[++i];
    if (argv[i - 1] === '--events') dirs.push(v);
    else if (argv[i - 1] === '--session') sessions.push(v);
    else if (argv[i - 1] === '--out') outFile = v;
    else if (argv[i - 1] === '--report') report = v;
    else throw new Error(`demo:traces: unknown argument ${argv[i - 1]}`);
  }
  if (!dirs.length || !sessions.length) throw new Error('demo:traces: give --events <dir> and --session <id> at least once each');
  const set = buildTraceSet(readEvents(dirs), sessions, os.homedir());
  const lines = textLines(set);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, traceScript(set));
  if (report) fs.writeFileSync(report, reviewReport(set, lines));
  console.log(`demo:traces: ${set.events.length} events in ${set.picked.length} sessions to ${outFile}; ${lines.length} pieces of text, ${lines.filter((l) => l.flags.length).length} flagged${report ? `; report at ${report}` : ''}`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
