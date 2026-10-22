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

  let settings: ClaudeSettings = {};
  try {
    const contents = await fs.promises.readFile(settingsPath, 'utf8');
    settings = JSON.parse(contents) as ClaudeSettings;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`snagboat: could not parse ${settingsPath}, leaving it untouched`, err);
      return;
    }
  }

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
