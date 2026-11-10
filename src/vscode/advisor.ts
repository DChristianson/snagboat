import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AdvisorConfig, approvalKey, Capability, CAPABILITY_LABELS, describeAdvisor, LEGACY_DEFAULT_SETTINGS, parseAdvisors } from '../advisor/advisors';
import { AuditLog } from '../advisor/audit';
import { buildDigest, DigestInput, DigestPolicy } from '../advisor/digest';
import { defaultPromptFiles, promptDir, PromptLayers, resolvePrompts } from '../advisor/prompts';
import { ModelTiers, proposeTacticsMessages } from '../advisor/proposeTactics';
import { SessionFocus, summarizeSessionMessages } from '../advisor/summarizeSession';
import { ChatMessage, complete, completionBody, Completion, FetchLike, listModels, promptWasCut } from '../advisor/providers';

const APPROVED_KEY = 'snagboat.advisor.approved';
const secretKey = (id: string) => `snagboat.advisor.key.${id}`;

export interface AdvisorDeps {
  secrets: vscode.SecretStorage;
  globalState: vscode.Memento;
  audit: AuditLog;
  output: vscode.OutputChannel;
  /** A stored session (optionally one turn) as digest input; undefined if it's gone. */
  digestInput(sessionId: string, turnId?: string): Promise<DigestInput | undefined>;
}

export type { Capability } from '../advisor/advisors';

/** What a request is built for: the advisor asked, the ability, what it may receive for it, and its prompt layers. */
export interface AskContext {
  advisor: AdvisorConfig;
  ability: Capability;
  policy: DigestPolicy;
  /** The advisor's persona and this ability's instruction, where they replace Snagboat's defaults. */
  prompts: PromptLayers;
}

/** An answer, with the advisor (and model) that gave it and what it was asked. */
export interface Asked {
  completion: Completion;
  advisor: AdvisorConfig;
  messages: ChatMessage[];
}

/** What Explain was asked about, from the Sessions tab or a command. */
export interface ExplainRequest {
  sessionId: string;
  turnId?: string;
  heuristicId?: string;
}

export interface AskOptions {
  title: string;
  json?: boolean;
  /** Never prompt, pick, or ask for approval; skip instead (for requests made while you work). */
  quiet?: boolean;
  /** A particular advisor instead of the ability's default. */
  advisorId?: string;
}

/** A prompt file's text, or undefined when there is none. */
function readPromptFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('snagboat.advisor');
}

/**
 * The advisor's VS Code side: picks the advisor for an ability, gets its key
 * from SecretStorage, shows the exact payload before an advisor's first
 * request, audits hosted requests, and shows answers labelled as model output.
 */
export class Advisor {
  constructor(private readonly deps: AdvisorDeps, private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike) {}

  /** Every advisor from settings; problems go to the output channel. */
  advisors(): AdvisorConfig[] {
    const { advisors, problems } = parseAdvisors(config().get('advisors'), config().get('providers'));
    for (const p of problems) this.deps.output.appendLine(`Advisor: ${p}`);
    return advisors;
  }

  /** The advisors offering an ability, the default first. */
  offering(ability: Capability): AdvisorConfig[] {
    const id = this.defaultId(ability);
    return this.advisors()
      .filter((a) => a.abilities[ability])
      .sort((a, b) => (a.id === id ? -1 : b.id === id ? 1 : 0));
  }

  /** The id of the advisor an ability uses unless another is picked: `snagboat.advisor.defaults`, or the older per-capability setting. */
  defaultId(ability: Capability): string {
    const defaults = config().get<Record<string, unknown>>('defaults', {});
    const set = defaults[ability];
    if (typeof set === 'string' && set.trim()) return set.trim();
    const legacy = Object.entries(LEGACY_DEFAULT_SETTINGS).find(([, c]) => c === ability)?.[0];
    return (legacy && config().get<string>(legacy)) || 'local';
  }

  private advisorFor(ability: Capability, advisorId?: string): AskContext | string {
    const id = advisorId ?? this.defaultId(ability);
    const a = this.advisors().find((x) => x.id === id);
    if (!a) return `no advisor "${id}" in snagboat.advisors or snagboat.advisor.providers`;
    const offered = a.abilities[ability];
    if (!offered) return `${a.label} doesn't offer "${ability}"`;
    const { problems, ...prompts } = resolvePrompts(a, ability, readPromptFile, os.homedir());
    for (const p of problems) this.deps.output.appendLine(`Advisor: ${p}`);
    return { advisor: a, ability, policy: offered.policy, prompts };
  }

  /**
   * Snagboat: Write Default Advisor Prompts: writes an advisor's default
   * persona and the instruction for each ability it offers to
   * ~/.snagboat/advisors/<id>/, to edit from.
   */
  async writeDefaultPrompts(): Promise<void> {
    const advisors = this.advisors();
    const a = advisors.length === 1 ? advisors[0] : (await vscode.window.showQuickPick(advisors.map((x) => ({ label: x.label, description: x.id, a: x })), { placeHolder: 'Write default prompts for which advisor?' }))?.a;
    if (!a) return;
    const dir = promptDir(os.homedir(), a.id);
    const files = defaultPromptFiles(a);
    const existing = files.filter((f) => fs.existsSync(path.join(dir, f.name))).map((f) => f.name);
    let write = files;
    if (existing.length > 0) {
      const choice = await vscode.window.showWarningMessage(`${dir} already has ${existing.join(', ')}.`, { modal: true, detail: 'Overwrite them with the defaults, or write only the missing files?' }, 'Overwrite', 'Only Missing');
      if (!choice) return;
      if (choice === 'Only Missing') write = files.filter((f) => !existing.includes(f.name));
    }
    await fs.promises.mkdir(dir, { recursive: true });
    for (const f of write) await fs.promises.writeFile(path.join(dir, f.name), f.text);
    void vscode.window.showInformationMessage(`Snagboat: wrote ${write.length ? write.map((f) => f.name).join(', ') : 'nothing'} to ${dir}. Edit them; Snagboat reads them on each request.`);
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(dir, 'persona.md')), { preview: false });
  }

  /** Lets you pick among the advisors offering an ability; undefined when there's nothing to choose or you didn't. */
  async pickAdvisor(ability: Capability, placeHolder = `Which advisor? (${CAPABILITY_LABELS[ability]})`): Promise<string | undefined> {
    const offering = this.offering(ability);
    if (offering.length === 0) {
      void vscode.window.showErrorMessage(`Snagboat: no advisor offers "${ability}".`, 'Open Settings').then((c) => c && vscode.commands.executeCommand('workbench.action.openSettings', 'snagboat.advisor'));
      return undefined;
    }
    const defaultId = this.defaultId(ability);
    const pick = await vscode.window.showQuickPick(
      offering.map((a) => ({ label: a.label, description: `${a.id === defaultId ? 'default · ' : ''}${a.locality === 'local' ? 'on this machine' : a.baseUrl}${a.model ? ` · ${a.model}` : ''}`, id: a.id })),
      { placeHolder }
    );
    return pick?.id;
  }

  private async apiKey(a: AdvisorConfig): Promise<string | undefined | null> {
    if (a.locality === 'local') return undefined;
    const key = await this.deps.secrets.get(secretKey(a.id));
    if (key) return key;
    const choice = await vscode.window.showWarningMessage(`Snagboat: ${a.label} needs your API key before anything is sent.`, 'Set API Key');
    if (choice) await this.setKey(a.id);
    return null;
  }

  /** Snagboat: Set Advisor API Key: stores a hosted advisor's key in VS Code's SecretStorage. */
  async setKey(advisorId?: string): Promise<void> {
    const hosted = this.advisors().filter((a) => a.locality === 'hosted');
    if (hosted.length === 0) {
      void vscode.window.showInformationMessage('Snagboat: no hosted advisors are configured; add one to snagboat.advisors. Local advisors need no key.');
      return;
    }
    const a = advisorId ? hosted.find((x) => x.id === advisorId) : (await vscode.window.showQuickPick(hosted.map((x) => ({ label: x.label, description: x.baseUrl, a: x })), { placeHolder: 'Which advisor?' }))?.a;
    if (!a) return;
    const key = await vscode.window.showInputBox({ prompt: `API key for ${a.label} (${a.baseUrl}); kept in VS Code's secret storage`, password: true, ignoreFocusOut: true });
    if (key === undefined) return;
    if (key.trim()) await this.deps.secrets.store(secretKey(a.id), key.trim());
    else await this.deps.secrets.delete(secretKey(a.id));
    void vscode.window.showInformationMessage(`Snagboat: ${key.trim() ? 'saved' : 'removed'} the API key for ${a.label}.`);
  }

  /** Lets you pick from the advisor's models when none is set, and saves the choice in the setting it came from. */
  private async model(a: AdvisorConfig, apiKey: string | undefined): Promise<string | undefined> {
    if (a.model) return a.model;
    let models: string[];
    try {
      models = await listModels(a, apiKey, this.fetchImpl);
    } catch (err) {
      void vscode.window.showErrorMessage(`Snagboat: couldn't list ${a.label}'s models (${a.baseUrl}): ${err instanceof Error ? err.message : String(err)}. Is it running? You can also set "model" in snagboat.${a.source === 'advisors' ? 'advisors' : 'advisor.providers'}.`);
      return undefined;
    }
    if (models.length === 0) {
      void vscode.window.showErrorMessage(`Snagboat: ${a.label} has no models. For Ollama, pull one first (ollama pull <model>).`);
      return undefined;
    }
    const model = await vscode.window.showQuickPick(models, { placeHolder: `Which ${a.label} model should it use?` });
    if (!model) return undefined;
    const setting = a.source === 'advisors' ? 'advisors' : 'providers';
    const inspected = config().inspect<unknown[]>(setting);
    const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    const current = (target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue ?? inspected?.defaultValue) ?? [];
    await config().update(setting, (current as Array<Record<string, unknown>>).map((x) => (x.id === a.id ? { ...x, model } : x)), target);
    return model;
  }

  private isApproved(a: AdvisorConfig): boolean {
    return this.deps.globalState.get<Record<string, string>>(APPROVED_KEY, {})[a.id] === approvalKey(a);
  }

  /** Before an advisor's first request (or after its URL or sending rules change), shows the payload and asks. */
  private async approved(a: AdvisorConfig, body: string): Promise<boolean> {
    if (this.isApproved(a)) return true;
    const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(JSON.parse(body), null, 2) });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    const where = a.locality === 'local' ? 'a model on this machine' : `${a.baseUrl}, off this machine`;
    const choice = await vscode.window.showWarningMessage(
      `Send this to ${a.label}?`,
      {
        modal: true,
        detail: `The open document is exactly what will be sent to ${where}. This is the first request with ${a.label}'s current address and sending rules; you won't be asked again until they change. Snagboat: Preview Advisor Digest shows a payload any time.`,
      },
      'Send'
    );
    if (choice !== 'Send') return false;
    const approvals = this.deps.globalState.get<Record<string, string>>(APPROVED_KEY, {});
    await this.deps.globalState.update(APPROVED_KEY, { ...approvals, [a.id]: approvalKey(a) });
    return true;
  }

  /**
   * One request for an ability: the advisor set for it (or the one asked
   * for), its key and model, your approval of the exact payload, then the
   * answer, audited if hosted. Undefined when you stopped it or it failed
   * (already reported).
   */
  async ask(ability: Capability, build: (ctx: AskContext) => Promise<ChatMessage[] | undefined>, opts: AskOptions): Promise<Asked | undefined> {
    if (opts.quiet) return this.askQuietly(ability, build, opts);
    const found = this.advisorFor(ability, opts.advisorId);
    if (typeof found === 'string') {
      void vscode.window.showErrorMessage(`Snagboat: ${found}.`, 'Open Settings').then((c) => c && vscode.commands.executeCommand('workbench.action.openSettings', 'snagboat.advisor'));
      return undefined;
    }
    const { advisor: a } = found;
    const apiKey = await this.apiKey(a);
    if (apiKey === null) return undefined;
    const model = await this.model(a, apiKey);
    if (!model) return undefined;
    const messages = await build(found);
    if (!messages) return undefined;
    const body = completionBody(model, messages, opts.json);
    if (!(await this.approved(a, body))) return undefined;
    const advisor = { ...a, model };
    try {
      const completion = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Snagboat: ${opts.title} with ${a.label} (${model})…`, cancellable: false }, () =>
        complete(advisor, messages, apiKey, this.fetchImpl, opts.json)
      );
      await this.auditRequest(advisor, ability, body, 'ok');
      return { completion, advisor, messages };
    } catch (err) {
      await this.auditRequest(advisor, ability, body, 'error');
      void vscode.window.showErrorMessage(`Snagboat: ${a.label} (${a.baseUrl}) didn't answer: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /**
   * For requests made while you work (the live nudge line): never a prompt,
   * picker, or approval dialog. If the advisor still needs a key, a model, or
   * your approval, it doesn't ask, and says why in the output.
   */
  private async askQuietly(ability: Capability, build: (ctx: AskContext) => Promise<ChatMessage[] | undefined>, opts: AskOptions): Promise<Asked | undefined> {
    const skip = (why: string) => {
      this.deps.output.appendLine(`Advisor: skipped ${opts.title}: ${why}`);
      return undefined;
    };
    const found = this.advisorFor(ability, opts.advisorId);
    if (typeof found === 'string') return skip(found);
    const { advisor: a } = found;
    if (!a.model) return skip(`${a.label} has no model set yet; use Explain once to pick one`);
    const apiKey = a.locality === 'hosted' ? await this.deps.secrets.get(secretKey(a.id)) : undefined;
    if (a.locality === 'hosted' && !apiKey) return skip(`${a.label} needs an API key`);
    if (!this.isApproved(a)) return skip(`you haven't approved what ${a.label} receives yet; use Explain once to see and approve it`);
    const messages = await build(found);
    if (!messages) return undefined;
    const body = completionBody(a.model, messages, opts.json);
    try {
      const completion = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Snagboat: ${opts.title}…` }, () => complete(a, messages, apiKey, this.fetchImpl, opts.json));
      await this.auditRequest(a, ability, body, 'ok');
      return { completion, advisor: a, messages };
    } catch (err) {
      await this.auditRequest(a, ability, body, 'error');
      return skip(`${a.label} didn't answer: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A warning to show above an answer whose prompt the server cut to fit its context window, or ''. */
  static cutWarning(asked: Asked, smaller: string): string {
    const { completion, advisor: a, messages } = asked;
    if (!promptWasCut(completion, messages)) return '';
    return `${a.label} read only ${completion.promptTokens?.toLocaleString()} tokens of a longer request, so it saw only part of it and may miss things. Its context window is too small: ${a.locality === 'local' ? 'for Ollama, restart it with a larger one (for example `OLLAMA_CONTEXT_LENGTH=16384 ollama serve`), or ' : ''}${smaller}.`;
  }

  /** How an answer is labelled. */
  static label(asked: Asked): string {
    return describeAdvisor(asked.advisor);
  }

  /** Explain (summarize) a session, turn, or finding, with the ability's default advisor or the one given. */
  async explain(req: ExplainRequest, advisorId?: string): Promise<void> {
    let focus: SessionFocus = { kind: 'session' };
    let gone = false;
    const asked = await this.ask(
      'summarize-session',
      async ({ policy, prompts }) => {
        const input = await this.deps.digestInput(req.sessionId, req.turnId);
        if (!input) {
          gone = true;
          return undefined;
        }
        const digest = buildDigest(input, policy);
        if (req.heuristicId) focus = { kind: 'finding', heuristicId: req.heuristicId, summary: digest.findings.find((f) => f.heuristic === req.heuristicId)?.summary ?? '' };
        else if (req.turnId) focus = { kind: 'turn', turn: digest.turns[0]?.turn ?? 0 };
        return summarizeSessionMessages(digest, focus, prompts);
      },
      { title: 'explaining', advisorId }
    );
    if (gone) void vscode.window.showWarningMessage('Snagboat: that session is no longer in the log.');
    if (!asked) return;
    const f = focus as SessionFocus;
    const about = f.kind === 'session' ? 'this session' : f.kind === 'turn' ? `turn ${f.turn}` : `the ${f.heuristicId} finding`;
    const header = `> **Model output** from ${Advisor.label(asked)}, ${new Date().toLocaleString()}. Explaining ${about} of session \`${req.sessionId.slice(0, 8)}\` from Snagboat's digest. It's a suggestion: check it against the session.\n\n`;
    const cut = Advisor.cutWarning(asked, 'explain a turn or finding instead, which sends much less');
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: header + (cut ? `> **Warning:** ${cut}\n\n` : '') + asked.completion.text + '\n' });
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  }

  /** Tactics for a session: whether model use and prompt tactics could be refined, with the ability's default advisor or the one given. */
  async tactics(sessionId: string, advisorId?: string): Promise<void> {
    let gone = false;
    const asked = await this.ask(
      'propose-tactics',
      async ({ policy, prompts }) => {
        const input = await this.deps.digestInput(sessionId);
        if (!input) {
          gone = true;
          return undefined;
        }
        return proposeTacticsMessages([buildDigest(input, policy)], prompts, Advisor.modelTiers());
      },
      { title: 'proposing tactics', advisorId }
    );
    if (gone) void vscode.window.showWarningMessage('Snagboat: that session is no longer in the log.');
    if (!asked) return;
    const header = `> **Model output** from ${Advisor.label(asked)}, ${new Date().toLocaleString()}. Tactics for session \`${sessionId.slice(0, 8)}\` from Snagboat's digest. Suggestions to judge against the session; nothing is changed.\n\n`;
    const cut = Advisor.cutWarning(asked, 'ask about a shorter session, which sends less');
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: header + (cut ? `> **Warning:** ${cut}\n\n` : '') + asked.completion.text + '\n' });
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  }

  /** `snagboat.advisor.modelTiers`, when set. */
  static modelTiers(): ModelTiers | undefined {
    const v = config().get<Record<string, unknown>>('modelTiers', {});
    const tiers = Object.fromEntries(Object.entries(v).filter(([k, t]) => k.trim() && typeof t === 'string' && t.trim()).map(([k, t]) => [k.trim(), (t as string).trim()]));
    return Object.keys(tiers).length > 0 ? tiers : undefined;
  }

  private async auditRequest(a: AdvisorConfig, ability: Capability, body: string, outcome: 'ok' | 'error'): Promise<void> {
    if (a.locality !== 'hosted') return;
    const entry = AuditLog.entryFor(body, { ts: new Date().toISOString(), provider: a.id, kind: a.kind, baseUrl: a.baseUrl, model: a.model, capability: ability, outcome }, config().get<boolean>('auditPayloads', false));
    await this.deps.audit.append(entry).catch((err) => this.deps.output.appendLine(`Advisor: couldn't write the audit log: ${String(err)}`));
  }
}
