import * as zlib from 'zlib';
import {
  exportedEventSchema,
  exportManifestSchema,
  findingRecordSchema,
  gitRecordSchema,
  linkRecordSchema,
  planRecordSchema,
  sessionRecordSchema,
} from '@snagboat/schema';
import { ruleTable } from './filter';

/**
 * What makes an export explain itself (snagboat-93b.10.15, docs/design/export.md, "What an export
 * holds"): its JSON Schemas under schema/, a README.md that says what each file is, how the ids
 * join them and what each placeholder means (the privacy filter's rule table, generated from its
 * rules), and --zip's archive. Both documents are static text, the same in every export: nothing
 * here names the project, the machine or anyone.
 */

/** Each export file (a path or a pattern), and the schema in schema/ its records follow. */
export const EXPORT_SCHEMAS: Record<string, string> = {
  'manifest.json': 'schema/exportManifest.v2.schema.json',
  'events/*.jsonl': 'schema/exportedEvent.v5.schema.json',
  'sessions.jsonl': 'schema/sessionRecord.v1.schema.json',
  'findings.jsonl': 'schema/findingRecord.v1.schema.json',
  'git/*.jsonl': 'schema/gitRecord.v1.schema.json',
  'plan/*.jsonl': 'schema/planRecord.v1.schema.json',
  'links.jsonl': 'schema/linkRecord.v1.schema.json',
};

const SCHEMAS: Record<string, object> = {
  'schema/exportManifest.v2.schema.json': exportManifestSchema,
  'schema/exportedEvent.v5.schema.json': exportedEventSchema,
  'schema/sessionRecord.v1.schema.json': sessionRecordSchema,
  'schema/findingRecord.v1.schema.json': findingRecordSchema,
  'schema/gitRecord.v1.schema.json': gitRecordSchema,
  'schema/planRecord.v1.schema.json': planRecordSchema,
  'schema/linkRecord.v1.schema.json': linkRecordSchema,
};

export const README_FILE = 'README.md';

/**
 * The schema files, each with its $id made its own file name: the published $id is a URL into
 * Snagboat's repository, which names its owner, and an export names nobody. Nothing $refs across
 * files, so a relative $id resolves the same.
 */
export function schemaFiles(): Array<{ file: string; text: string }> {
  return Object.entries(SCHEMAS).map(([file, schema]) => {
    const copy = { ...(schema as Record<string, unknown>), $id: file.slice('schema/'.length) };
    return { file, text: JSON.stringify(copy, null, 2) + '\n' };
  });
}

export function readmeFile(): { file: string; text: string } {
  return { file: README_FILE, text: README.replace('{{RULE_TABLE}}', ruleTable()) };
}

const README = `# A Snagboat export

This folder is one project's record from Snagboat: the coding agents' sessions, what they did, the
git history and plan items they worked on, and how those connect. It was written by
\`snagboat export\`, which put everything through Snagboat's privacy filter first. \`manifest.json\`
says when, which versions, what was counted and what each of the filter's rules rewrote and kept.

## Files

Everything is JSON Lines (one JSON object per line) apart from \`manifest.json\`. Each file's
records follow a JSON Schema in \`schema/\`; \`manifest.json\`'s \`schemas\` maps each file to its
schema.

| File | One line is | Schema |
| --- | --- | --- |
| \`manifest.json\` | (one object) format, versions, time range, counts, what each filter rule rewrote and kept | \`exportManifest.v2\` |
| \`events/YYYY-MM-DD.jsonl\` | an event: a prompt, a reply, a tool call, a model call, a finding, an outcome. UTC days. | \`exportedEvent.v5\` |
| \`sessions.jsonl\` | a session: its agent, model, times, tokens, branches, commits and plan items | \`sessionRecord.v1\` |
| \`findings.jsonl\` | a finding or early warning, from first seen to last, and how it was answered | \`findingRecord.v1\` |
| \`git/commits.jsonl\` | a commit, merges included, with its changed files | \`gitRecord.v1\` (\`commit\`) |
| \`git/branches.jsonl\` | a branch: where it started, where it was merged | \`gitRecord.v1\` (\`branch\`) |
| \`git/checkouts.jsonl\` | a HEAD move: which branch a working tree had checked out, from when | \`gitRecord.v1\` (\`checkout\`) |
| \`plan/items.jsonl\` | a plan item (an issue, or a step of a markdown plan) as it last stood | \`planRecord.v1\` (\`item\`) |
| \`plan/transitions.jsonl\` | a change to a plan item: created, claimed, status, closed, reopened | \`planRecord.v1\` (\`transition\`) |
| \`links.jsonl\` | an edge between two of the above, with its kind, confidence and evidence | \`linkRecord.v1\` |

Every record has \`record\` (its type) and \`version\`. Fields are optional unless the schema says
otherwise; a reader should ignore fields and record types it doesn't know.

## How the files join

- \`sessionId\` joins events to \`sessions.jsonl\`. A subagent's events carry its \`agentId\`.
- Commits are keyed by \`sha\`, branches, checkouts, plan items and transitions by \`id\`. A
  transition's \`item\` is its plan item's \`id\`.
- \`links.jsonl\` connects them: each link has a \`from\` and a \`to\` (a \`type\` and an \`id\`), a
  \`kind\` (\`made\`, \`worked-on\`, \`touched\` with \`how\`, \`references\`, \`merged\`, \`made-in\`)
  and a \`confidence\`: \`observed\` when the records show it directly, \`inferred\` when it was
  worked out, with the \`evidence\` either way.
- \`sessions.jsonl\` repeats each session's branches, commits and plan items from the links, for
  convenience.

## What the privacy filter rewrote

Before writing this, Snagboat's privacy filter looked for values that might identify a person,
a machine or a secret, and the exporter decided, value by value or rule by rule, which to rewrite
and which to keep. \`manifest.json\`'s \`filter\` says how it ran (\`reviewed\`, \`rewrite-all\`, or
\`none\` when it was turned off) and its \`rules\` how many values each rule rewrote and kept. A
rewritten value reads as its rule's placeholder:

{{RULE_TABLE}}
Numbered placeholders (\`[person-N]\`, \`[email-N]\`, \`[commit-N]\`) are numbered for this export
only, in the order values were first met: the same value is the same placeholder in every file, so
ids still join, but numbers mean nothing across exports. Capture had already replaced some secrets
with \`[redacted]\`, \`[redacted ... key]\` or \`[redacted ... token]\` before anything was stored.
Agents (\`claude-code\`, Copilot, bots) are never people, so they keep their names. With \`text\`
\`none\` in the manifest, prompts, replies, commit messages and plan text were left out entirely.

Tool output was never recorded, so it isn't here. Prompt and reply text is as long as Snagboat kept
it; \`textTruncated\` on an event says it was cut.
`;

const crcOf = (buf: Buffer): number => zlib.crc32(buf) >>> 0;

/** DOS date and time for a zip entry, from a UTC time. */
function dosTime(at: Date): { time: number; date: number } {
  const y = Math.max(1980, at.getUTCFullYear());
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((y - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

/**
 * A zip of the files, each under `folder/`, deflated, every entry stamped with `at` so the same
 * export zips to the same bytes. Plain zip (no zip64): an export is far below 4 GB.
 */
export function zipFiles(folder: string, files: Array<{ file: string; text: string }>, at: Date): Buffer {
  const { time, date } = dosTime(at);
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(`${folder}/${f.file}`, 'utf8');
    const data = Buffer.from(f.text, 'utf8');
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crcOf(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(((0o100600 << 16) >>> 0), 38); // -rw-------
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
