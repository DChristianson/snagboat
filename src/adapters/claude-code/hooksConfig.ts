import * as fs from 'fs';
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

export function buildHookCommand(port: number): string {
  // "|| true" ensures a hook never fails (and so never blocks Claude Code) just
  // because the extension/receiver isn't currently running.
  return `curl -s -X POST http://127.0.0.1:${port}/hook -H "Content-Type: application/json" -d @- >/dev/null 2>&1 || true # ${HOOK_COMMAND_MARKER}`;
}

/**
 * Additively merges PostToolUse/Stop hook entries pointing at our local receiver
 * into the project's .claude/settings.json, without touching any hooks or other
 * settings the user already has configured there. Safe to call on every adapter
 * start: a no-op once our entries are already present.
 */
export async function ensureHooksConfigured(projectDir: string, port: number): Promise<void> {
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
    const alreadyPresent = matchers.some((m) =>
      m.hooks?.some((h) => h.command?.includes(HOOK_COMMAND_MARKER))
    );
    if (!alreadyPresent) {
      matchers.push({ matcher: '*', hooks: [{ type: 'command', command: buildHookCommand(port) }] });
      changed = true;
    }
  }

  if (changed) {
    await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  }
}
