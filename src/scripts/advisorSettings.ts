/**
 * Advisors from your VS Code settings, for the dev scripts: `--advisor <id>`
 * reads `snagboat.advisors` and `snagboat.advisor.providers` from the user
 * settings.json (or `--settings <path>`) with the extension's own parser, so
 * an advisor's address, model, sending policy, persona, and prompt files are
 * exactly what the extension would use. Dev tooling only; never shipped.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AdvisorConfig, Capability, parseAdvisors } from '../advisor/advisors';
import { PromptLayers, resolvePrompts } from '../advisor/prompts';

/** Where VS Code keeps the user settings on this platform. */
export function defaultSettingsPath(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'settings.json');
  return path.join(home, '.config', 'Code', 'User', 'settings.json');
}

/** settings.json allows comments and trailing commas; strip them outside strings. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export interface ScriptAdvisor {
  advisor: AdvisorConfig;
  /** The layers for an ability, read from the advisor's files. */
  prompts(ability: Capability): PromptLayers;
}

/** The named advisors from a settings file; throws with a readable message when one is missing or broken. */
export function advisorsFromSettings(ids: string[], settingsFile = defaultSettingsPath()): ScriptAdvisor[] {
  let settings: Record<string, unknown>;
  try {
    settings = parseJsonc(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`couldn't read ${settingsFile}: ${err instanceof Error ? err.message : String(err)} (pass --settings <path>)`);
  }
  const { advisors, problems } = parseAdvisors(settings['snagboat.advisors'], settings['snagboat.advisor.providers']);
  for (const p of problems) console.error(`settings: ${p}`);
  const read = (file: string) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  };
  return ids.map((id) => {
    const advisor = advisors.find((a) => a.id === id);
    if (!advisor) throw new Error(`no advisor "${id}" in ${settingsFile} (have: ${advisors.map((a) => a.id).join(', ') || 'none'})`);
    return {
      advisor,
      prompts: (ability) => {
        const { problems: p, ...layers } = resolvePrompts(advisor, ability, read, os.homedir());
        for (const problem of p) console.error(`prompts: ${problem}`);
        return layers;
      },
    };
  });
}
