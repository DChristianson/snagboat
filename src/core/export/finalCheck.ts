import { escapeRegExp, findPiiValues, RuleName } from './rules';

/**
 * Rule 5, the final check (docs/design/export.md): after the export is written to a temporary
 * folder, every file is searched for the values the rules should have removed. One hit and the
 * command writes nothing. Hits say which rule and which file, never the value.
 */

/** What to look for, from ExportSanitizer.summary(). Holds the real values: keep it in memory only. */
export interface FinalCheckSpec {
  /**
   * Values that must not appear: the project's and worktrees' paths, the home folder, the user
   * and host names, every pseudonymized person's names and emails, denied words, remotes, and
   * (private repositories) the known commits' SHAs. `word`: matched case-insensitively as a
   * whole word; otherwise as written, case-insensitively.
   */
  literals: Array<{ rule: RuleName; value: string; word?: boolean }>;
  /** Values --allow or --allow-rule put back: not hits. */
  allowed: string[];
}

export interface FinalCheckFile {
  /** The file's path relative to the export folder: events/2026-11-20.jsonl. */
  file: string;
  text: string;
}

/** One rule's hits in one file, without the values. */
export interface FinalCheckHit {
  rule: RuleName;
  file: string;
  count: number;
}

/**
 * Searches the written files. Every string value in a JSON line is searched as parsed (so
 * escapes can't hide a value), and the raw text is searched for the literals too. Rule 2's
 * patterns are searched in string values only, so a number (a time in milliseconds) can't pass
 * for a card. Returns no hits when the export is clean.
 */
export function finalCheck(files: FinalCheckFile[], spec: FinalCheckSpec): FinalCheckHit[] {
  const allowed = new Set(spec.allowed.map((a) => a.toLowerCase()));
  const literals = spec.literals
    .filter((l) => !allowed.has(l.value.toLowerCase()))
    .map((l) => {
      // A word (a user, host or person's name) is matched as a whole word in its escaped form too,
      // so a user named "vscode" isn't a hit in ".vscodeignore".
      const pattern = (v: string) => (l.word ? new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(v)}(?![\\p{L}\\p{N}_])`, 'giu') : new RegExp(escapeRegExp(v), 'gi'));
      return { rule: l.rule, re: pattern(l.value), escaped: pattern(JSON.stringify(l.value).slice(1, -1)) };
    });
  const hits = new Map<string, FinalCheckHit>();
  const hit = (rule: RuleName, file: string, n = 1) => {
    const k = `${rule}\0${file}`;
    const h = hits.get(k) ?? { rule, file, count: 0 };
    h.count += n;
    hits.set(k, h);
  };
  for (const { file, text } of files) {
    const strings: string[] = [];
    try {
      // One JSON document (the manifest)...
      collectStrings(JSON.parse(text), strings);
    } catch {
      // ...or JSON Lines; a line that isn't JSON is searched as it is.
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        try {
          collectStrings(JSON.parse(line), strings);
        } catch {
          strings.push(line);
        }
      }
    }
    for (const l of literals) {
      const inRaw = (text.match(l.re)?.length ?? 0) + (l.escaped.source !== l.re.source ? (text.match(l.escaped)?.length ?? 0) : 0);
      const inStrings = strings.reduce((n, s) => n + (s.match(l.re)?.length ?? 0), 0);
      const n = Math.max(inRaw, inStrings);
      if (n > 0) hit(l.rule, file, n);
    }
    for (const s of strings) {
      for (const { rule, value } of findPiiValues(s)) if (!allowed.has(value.toLowerCase())) hit(rule, file);
    }
  }
  return [...hits.values()].sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
}

function collectStrings(v: unknown, out: string[]): void {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      collectStrings(x, out);
    }
  }
}
