import { SetupConversation, SetupModel } from '@snagboat/schema';
import { checkNewAdvisor, writeNewAdvisor } from '../../advisor/newAdvisor';
import { parseSetupAnswer, SetupCatalog, setupMessages } from '../../advisor/setupConversation';
import { AdvisorSetupStore } from '../advisorSetups';
import { CoreAdvisorChoice, CoreAdvisors, PendingApproval } from './advisorModels';

/**
 * Setting up an advisor by conversation, in the core (docs/design/goal-tracking-lifecycle.md,
 * snagboat-79f.7.15). You pick a model first: a local model advisor in your settings offering "set up an
 * advisor" (nothing proceeds without one). Each of your turns is recorded, then the model is asked in the
 * background through CoreAdvisors.ask, under the set-up-advisor ability's own sending rules and approval:
 * the first request waits for you to approve its exact payload. You can switch models on any turn; each
 * answer records the model that gave it. When the model proposes an advisor you accept it (persona.md is
 * written as the + form writes it, with that model as the advisor's model, and the conversation moves to
 * the advisor's folder), revise it with a note (the conversation goes on), or discard the draft (its
 * record stays). Every front end (the advisor UI, an agent through MCP) uses these same calls.
 */

export class SetupError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface SetupView {
  setup: SetupConversation;
  /** Where the model's answer to your last turn stands, since the core started: asking (approval: waiting for yours), failed, or not sent. */
  ask?: { state: 'asking' | 'failed' | 'not-sent'; at: string; error?: string; approval?: PendingApproval };
  /** The models you can pick or switch to. */
  models: CoreAdvisorChoice[];
}

const MAX_TEXT = 4000;
const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT) : '');

export class AdvisorSetups {
  private readonly inFlight = new Set<string>();
  private readonly asks = new Map<string, { state: 'asking' | 'failed' | 'not-sent'; at: string; error?: string }>();

  constructor(
    readonly store: AdvisorSetupStore,
    private readonly models: CoreAdvisors,
    /** Where new advisors' folders go: ~/.snagboat/advisors. */
    private readonly advisorsDir: string,
    /** What the model may choose from, and which names are taken. */
    private readonly catalog: () => Promise<SetupCatalog>,
    private readonly now: () => Date = () => new Date(),
    private readonly log: (line: string) => void = () => undefined
  ) {}

  /** The models a conversation can use: local model advisors offering "set up an advisor". */
  choices(): CoreAdvisorChoice[] {
    return this.models.choices('set-up-advisor');
  }

  private pick(id: unknown): SetupModel {
    if (typeof id !== 'string' || !id) throw new SetupError(400, 'pick a model first: one of the local model advisors in your settings (snagboat.advisors)');
    const a = this.choices().find((c) => c.id === id);
    if (!a) throw new SetupError(400, `no local model advisor "${id}" offers setting up an advisor; pick one of: ${this.choices().map((c) => c.id).join(', ') || '(none: run a local model, or add one to snagboat.advisors)'}`);
    return { advisor: a.id, ...(a.model ? { model: a.model } : {}) };
  }

  view(id: string): SetupView | undefined {
    const setup = this.store.get(id) ?? undefined;
    if (!setup) return undefined;
    const a = this.asks.get(id);
    const approval = a?.state === 'asking' ? this.models.pendingApproval() : undefined;
    return { setup, ...(a ? { ask: { ...a, ...(approval ? { approval } : {}) } } : {}), models: this.choices() };
  }

  private mustView(id: string): SetupView {
    const v = this.view(id);
    if (!v) throw new SetupError(404, `no setup conversation ${id}`);
    return v;
  }

  private open(id: string): SetupConversation {
    const { setup } = this.mustView(id);
    if (setup.status !== 'open') throw new SetupError(409, `this conversation was ${setup.status}${setup.advisor ? ` (it made ${setup.advisor})` : ''}; start another`);
    if (this.inFlight.has(id)) throw new SetupError(409, 'the model is still answering your last turn');
    return setup;
  }

  /** A new conversation with the model you picked; your first turn too, when given. */
  async start(body: { model?: unknown; text?: unknown }): Promise<SetupView> {
    const model = this.pick(body.model);
    const setup = this.store.start(model);
    this.log(`setup ${setup.id}: started with ${model.advisor}`);
    if (clean(body.text)) return this.say(setup.id, { text: body.text });
    return this.mustView(setup.id);
  }

  /**
   * Your turn: your words, and a model to switch to if you name another. The model answers in the
   * background. With no text, asks again for an answer to your last turn (it failed, or wasn't sent).
   */
  async say(id: string, body: { text?: unknown; model?: unknown }): Promise<SetupView> {
    const setup = this.open(id);
    const switched = body.model !== undefined && body.model !== setup.model.advisor ? this.pick(body.model) : undefined;
    const text = clean(body.text);
    const last = setup.turns[setup.turns.length - 1];
    if (!text) {
      if (last?.from !== 'you') throw new SetupError(400, 'say something first');
      // Asking another model to answer your last turn: a line with the switch and no words.
      if (switched) this.store.append(id, { type: 'said', model: switched });
    } else {
      this.store.append(id, { type: 'said', text, ...(switched ? { model: switched } : {}) });
    }
    this.answerLater(id);
    return this.mustView(id);
  }

  /** What you do with the model's proposal: accept it, revise it with a note, or discard the draft. */
  async decide(id: string, body: { action?: unknown; note?: unknown; model?: unknown; turn?: unknown }): Promise<SetupView & { advisor?: { id: string; name: string } }> {
    const action = body.action;
    if (action !== 'accept' && action !== 'revise' && action !== 'discard') throw new SetupError(400, 'action is accept, revise or discard');
    const setup = this.open(id);
    if (action === 'discard') {
      this.store.append(id, { type: 'discarded' });
      this.log(`setup ${id}: discarded`);
      return this.mustView(id);
    }
    if (!setup.proposal) throw new SetupError(409, 'there is no proposal to accept or revise yet');
    if (body.turn !== undefined && body.turn !== setup.proposal.turn) throw new SetupError(409, 'that proposal is not the latest one');
    if (action === 'revise') {
      const note = clean(body.note);
      if (!note) throw new SetupError(400, 'say what to change: Revise needs a note');
      const switched = body.model !== undefined && body.model !== setup.model.advisor ? this.pick(body.model) : undefined;
      this.store.append(id, { type: 'revised', text: note, ...(switched ? { model: switched } : {}) });
      this.answerLater(id);
      return this.mustView(id);
    }
    // Accept: checked again as the + form checks it (rules and models may have changed since), then written.
    const catalog = await this.catalog();
    const { spec, problems } = checkNewAdvisor(setup.proposal.spec, catalog.rules.map((r) => r.id), this.models.advisors().map((a) => a.id));
    if (!spec) throw new SetupError(400, problems.join(' '));
    let made: { id: string; name: string };
    try {
      const a = writeNewAdvisor(this.advisorsDir, spec);
      made = { id: a.id, name: a.name };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SetupError(/already exists|built-in/.test(message) ? 409 : 500, message);
    }
    this.store.accept(id, made.id);
    this.log(`setup ${id}: accepted, added advisor ${made.id}`);
    return { ...this.mustView(id), advisor: made };
  }

  /** Your answer to the request waiting for approval (it may be another feature's: there is one at a time). False when none matches. */
  approve(approvalId: string, send: boolean): boolean {
    return this.models.decide(approvalId, send);
  }

  /** Asks in the background, logging a failure. */
  answerLater(id: string): void {
    void this.answer(id).catch((err) => this.log(`setup ${id}: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Asks the conversation's current model for its next turn. Undefined when it wasn't sent, or one is already under way. */
  async answer(id: string): Promise<SetupConversation | undefined> {
    if (this.inFlight.has(id)) return undefined;
    const setup = this.store.get(id);
    if (!setup || setup.status !== 'open') return undefined;
    this.inFlight.add(id);
    this.asks.set(id, { state: 'asking', at: this.now().toISOString() });
    try {
      const catalog = await this.catalog();
      const asked = await this.models.ask('set-up-advisor', async (ctx) => setupMessages(setup.turns, catalog, ctx.prompts), { advisorId: setup.model.advisor, json: true });
      if (!asked) {
        this.asks.set(id, { state: 'not-sent', at: this.now().toISOString() });
        return undefined;
      }
      const parsed = parseSetupAnswer(asked.completion.text, catalog, asked.advisor.id, this.models.advisors().map((a) => a.id));
      for (const p of parsed.problems) this.log(`setup ${id}: ${p}`);
      const model: SetupModel = { advisor: asked.advisor.id, ...(asked.advisor.model ? { model: asked.advisor.model } : {}) };
      const after = this.store.append(id, { type: 'answered', model, text: parsed.reply, ...(parsed.proposal ? { proposal: parsed.proposal } : {}), ...(parsed.problems.length ? { problems: parsed.problems } : {}) });
      this.asks.delete(id);
      return after;
    } catch (err) {
      this.asks.set(id, { state: 'failed', at: this.now().toISOString(), error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      this.inFlight.delete(id);
    }
  }
}
