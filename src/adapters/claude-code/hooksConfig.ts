import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface HookEntry {
  type: 'command';
  command: string;
}

interface HookMatcher {
  matcher?: string;
  hooks: HookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[] | undefined>;
  [key: string]: unknown;
}

const HOOK_COMMAND_MARKER = 'snagboat-hook-receiver';
const HOOK_EVENT_NAMES = ['PostToolUse', 'Stop'] as const;

/**
 * The settings.json command for our hooks: runs the routing script at a stable
 * path, so the entry never changes between sessions or windows. Written with
 * a literal $HOME for the default location, so a committed settings.json works
 * for anyone. "2>/dev/null || true" keeps a hook from ever failing (and so
 * from ever blocking Claude Code) if the script is gone, e.g. Snagboat was
 * uninstalled.
 */
export function buildHookCommand(scriptPath: string): string {
  const home = os.homedir();
  const shown = scriptPath.startsWith(home + path.sep) ? `$HOME${scriptPath.slice(home.length)}` : scriptPath;
  return `"${shown}" 2>/dev/null || true # ${HOOK_COMMAND_MARKER}`;
}

/**
 * Merges PostToolUse/Stop hook entries running our command into the project's
 * .claude/settings.json without touching any other hooks or settings. Any
 * existing Snagboat entry (found by its marker comment, e.g. the old fixed-port
 * curl command) is rewritten in place to the current command, and duplicates
 * are removed. Safe to call on every adapter start: a no-op once up to date.
 */
export async function ensureHooksConfigured(projectDir: string, command: string): Promise<void> {
  const settingsDir = path.join(projectDir, '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');
  await fs.promises.mkdir(settingsDir, { recursive: true });

  const settings = await readSettings(settingsPath);
  if (!settings) return;

  settings.hooks ??= {};
  let changed = false;
  for (const eventName of HOOK_EVENT_NAMES) {
    const matchers = (settings.hooks[eventName] ??= []);
    let found = false;
    for (const matcher of matchers) {
      const hooks = matcher.hooks ?? [];
      const kept = hooks.filter((h) => {
        if (!h.command?.includes(HOOK_COMMAND_MARKER)) return true;
        if (found) return false; // duplicate Snagboat entry
        found = true;
        if (h.command !== command) {
          h.command = command;
          changed = true;
        }
        return true;
      });
      if (kept.length !== hooks.length) {
        matcher.hooks = kept;
        changed = true;
      }
    }
    // Drop matcher groups emptied by duplicate removal.
    const nonEmpty = matchers.filter((m) => (m.hooks ?? []).length > 0);
    if (nonEmpty.length !== matchers.length) {
      settings.hooks[eventName] = nonEmpty;
      changed = true;
    }
    if (!found) {
      settings.hooks[eventName]!.push({ matcher: '*', hooks: [{ type: 'command', command }] });
      changed = true;
    }
  }

  if (changed) {
    await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  }
}

/**
 * Removes every Snagboat hook entry (found by its marker) from the project's
 * .claude/settings.json, then any matcher group, event list, or hooks object
 * that leaves empty. Other hooks and settings are untouched, and a file with
 * nothing of Snagboat's isn't rewritten. Returns whether anything was removed.
 * Throws if the file exists but isn't valid JSON, so the caller can say so.
 */
export async function removeHooksConfigured(projectDir: string): Promise<boolean> {
  const settingsPath = path.join(projectDir, '.claude', 'settings.json');
  const settings = await readSettings(settingsPath, { throwOnInvalid: true });
  if (!settings?.hooks) return false;
  let removed = false;
  for (const [eventName, matchers] of Object.entries(settings.hooks)) {
    if (!Array.isArray(matchers)) continue;
    const kept = matchers
      .map((m) => {
        const hooks = (m.hooks ?? []).filter((h) => !h.command?.includes(HOOK_COMMAND_MARKER));
        if (hooks.length !== (m.hooks ?? []).length) removed = true;
        return { ...m, hooks };
      })
      .filter((m, i) => m.hooks.length > 0 || (matchers[i].hooks ?? []).length === 0);
    if (kept.length > 0) settings.hooks[eventName] = kept;
    else delete settings.hooks[eventName];
  }
  if (!removed) return false;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return true;
}

/** The parsed settings file; {} when it doesn't exist; undefined (with a warning) when it can't be read or parsed, unless throwOnInvalid. */
async function readSettings(settingsPath: string, opts: { throwOnInvalid?: boolean } = {}): Promise<ClaudeSettings | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(settingsPath, 'utf8')) as ClaudeSettings;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (opts.throwOnInvalid) throw new Error(`could not read ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`);
    console.warn(`snagboat: could not parse ${settingsPath}, leaving it untouched`, err);
    return undefined;
  }
}
