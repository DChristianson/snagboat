import * as fs from 'fs';
import * as os from 'os';
import { AdvisorConfig, approvalKey, Capability, LEGACY_DEFAULT_SETTINGS, parseAdvisors } from '../../advisor/advisors';
import { PromptLayers, resolvePrompts } from '../../advisor/prompts';
import { ChatMessage, complete, completionBody, Completion, FetchLike, listModels } from '../../advisor/providers';
import { DigestPolicy } from '../../advisor/digest';
import { readApprovals, writeApprovals } from '../advisorApprovals';
import { loadConfig } from '../config';

/**
 * Advisor models in the core (RFC step 5c-2b). Decided November 11, 2026: the core asks local models
 * only (an address on this machine, such as Ollama), so it holds no API keys; hosted advisors stay
 * VS Code's. Advisors come from your user settings only (config.json's defaults, as a VS Code window
 * copies them, or as you write them there), never a project's or a repository's .snagboat.json, so a
 * folder you open can't point the core at a model. Before an advisor's first request with its current
 * address and sending rules, the request waits for you to see the exact payload in the advisor UI and
 * approve it; approvals are shared with VS Code (advisorApprovals.ts).
 */

export interface AskContext {
  advisor: AdvisorConfig;
  policy: DigestPolicy;
  prompts: PromptLayers;
}

/** A request waiting for your approval, as the page shows it. */
export interface PendingApproval {
  id: string;
  advisor: string;
  model: string;
  /** The exact request body, pretty-printed. */
  payload: string;
}

export interface CoreAdvisorChoice {
  id: string;
  label: string;
  model?: string;
}

export type Asked = { completion: Completion; advisor: AdvisorConfig & { model: string } };

let nextId = 1;
/** How long a request waits for your approval before it isn't sent. */
export const APPROVAL_WAIT_MS = 10 * 60_000;

export class CoreAdvisors {
  private pending?: PendingApproval & { decide: (send: boolean) => void };

  constructor(
    private readonly home: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly log: (line: string) => void = () => undefined
  ) {}

  /** The advisors the core may ask: local models from your user settings (or the default local one). */
  advisors(): AdvisorConfig[] {
    const d = loadConfig(this.home).config.defaults;
    const { advisors, problems } = parseAdvisors(d['advisors'], d['advisor.providers']);
    for (const p of problems) this.log(`advisor: ${p}`);
    return advisors.filter((a) => a.kind === 'model' && a.locality === 'local');
  }

  /** The local advisors offering an ability, the default first. */
  offering(ability: Capability): AdvisorConfig[] {
    const id = this.defaultId(ability);
    return this.advisors()
      .filter((a) => a.abilities[ability])
      .sort((a, b) => (a.id === id ? -1 : b.id === id ? 1 : 0));
  }

  choices(ability: Capability): CoreAdvisorChoice[] {
    return this.offering(ability).map((a) => ({ id: a.id, label: a.label, ...(a.model ? { model: a.model } : {}) }));
  }

  private defaultId(ability: Capability): string {
    const d = loadConfig(this.home).config.defaults;
    const defaults = d['advisor.defaults'];
    const set = defaults && typeof defaults === 'object' ? (defaults as Record<string, unknown>)[ability] : undefined;
    if (typeof set === 'string' && set.trim()) return set.trim();
    const legacy = Object.entries(LEGACY_DEFAULT_SETTINGS).find(([, c]) => c === ability)?.[0];
    const old = legacy ? d[`advisor.${legacy}`] : undefined;
    return typeof old === 'string' && old ? old : 'local';
  }

  /** The request waiting for your approval, if any. */
  pendingApproval(): PendingApproval | undefined {
    if (!this.pending) return undefined;
    const { decide: _decide, ...shown } = this.pending;
    return shown;
  }

  /** Your answer to the waiting request: send it (and remember the approval) or not. False when none matches. */
  decide(id: string, send: boolean): boolean {
    if (!this.pending || this.pending.id !== id) return false;
    const { decide } = this.pending;
    // Gone from the view at once, so the reply to this answer shows the request going out (or dropped).
    this.pending = undefined;
    decide(send);
    return true;
  }

  /**
   * One request for an ability, to the advisor named (or the ability's default local one). Waits for your
   * approval of the exact payload before the first request. Throws with a plain-words message; undefined
   * when you didn't send it.
   */
  async ask(ability: Capability, build: (ctx: AskContext) => Promise<ChatMessage[] | undefined>, opts: { advisorId?: string; json?: boolean } = {}): Promise<Asked | undefined> {
    const list = this.offering(ability);
    const a = opts.advisorId ? list.find((x) => x.id === opts.advisorId) : list[0];
    if (!a) {
      throw new Error(
        opts.advisorId
          ? `no local advisor "${opts.advisorId}" offers that; the advisor UI asks only models on this machine (hosted ones stay in VS Code)`
          : 'no local advisor offers that. Run a local model (for example Ollama), or add one to snagboat.advisors in your user settings; hosted advisors stay in VS Code'
      );
    }
    const { problems, ...prompts } = resolvePrompts(a, ability, (f) => {
      try {
        return fs.readFileSync(f, 'utf8');
      } catch {
        return undefined;
      }
    }, os.homedir());
    for (const p of problems) this.log(`advisor: ${p}`);
    let model = a.model;
    if (!model) {
      let models: string[];
      try {
        models = await listModels(a, undefined, this.fetchImpl);
      } catch (err) {
        throw new Error(`couldn't list ${a.label}'s models at ${a.baseUrl} (${err instanceof Error ? err.message : String(err)}). Is it running?`);
      }
      if (!models.length) throw new Error(`${a.label} has no models. For Ollama, pull one first (ollama pull <model>).`);
      // The first; set "model" in snagboat.advisors to choose another.
      model = models[0];
    }
    const messages = await build({ advisor: a, policy: a.abilities[ability]!.policy, prompts });
    if (!messages) return undefined;
    const body = completionBody(model, messages, opts.json);
    if (readApprovals(this.home)[a.id] !== approvalKey(a)) {
      if (this.pending) throw new Error('another request is waiting for your approval; answer it first');
      const send = await new Promise<boolean>((resolve) => {
        // Not sent if nobody answers (the tab was closed): a waiting request would hold up every other.
        const timer = setTimeout(() => {
          this.pending = undefined;
          resolve(false);
        }, APPROVAL_WAIT_MS);
        timer.unref?.();
        this.pending = {
          id: String(nextId++),
          advisor: a.label,
          model,
          payload: JSON.stringify(JSON.parse(body), null, 2),
          decide: (yes) => {
            clearTimeout(timer);
            resolve(yes);
          },
        };
      });
      if (!send) return undefined;
      writeApprovals(this.home, { ...readApprovals(this.home), [a.id]: approvalKey(a) });
    }
    const advisor = { ...a, model };
    try {
      return { completion: await complete(advisor, messages, undefined, this.fetchImpl, opts.json), advisor };
    } catch (err) {
      throw new Error(`${a.label} (${a.baseUrl}) didn't answer: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
