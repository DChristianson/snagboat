import * as fs from 'fs';
import * as path from 'path';

/**
 * Suggestions you dismissed (discovery's candidates and shell categories), kept in
 * <snagboat home>/suggestions.json so the core's advisor UI and a VS Code window with
 * the per-user store on share one list (RFC step 5c-2). Saved rules are shared by every
 * workspace, so a dismissal is too, as VS Code has always kept it.
 */

const FILE = 'suggestions.json';

export function readDismissed(home: string): string[] {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(home, FILE), 'utf8')) as { dismissed?: unknown };
    return Array.isArray(v.dismissed) ? v.dismissed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function writeDismissed(home: string, ids: string[]): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, FILE);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ dismissed: [...new Set(ids)].sort() }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
