import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { EventBus } from './core/eventBus';
import { OUTCOMES_ADAPTER, TestsGreen } from './outcomes/testsGreen';
import { loadAdvisorGoals } from './advisor/goals';
import { snagboatHome } from './core/userStore';
import { findCore } from './core/service/lifecycle';
import { coreRequest } from './core/service/coreFile';
import { advisorReports, eventsIn, periods } from './advisor/report';
import { EventLog } from './core/eventLog';
import { Aggregate, AggregateSnapshot, TodayAggregate } from './core/aggregate';
import { EventStore, ReadonlyEventStore } from './core/eventStore';
import { CheckpointStore } from './core/checkpointStore';
import { DailyHistory } from './core/dailyHistory';
import { SessionIndex } from '@snagboat/schema';
import { SessionController } from './ui/sessionController';
import { FindingReplay } from './heuristics/replay';
import { setHost } from './core/host';
import { runBackfill } from './vscode/backfillCommand';
import { runRelabel } from './vscode/relabelCommand';
import { buildDigest, digestForReading, DigestPolicy } from './advisor/digest';
import { PromptLayers } from './advisor/prompts';
import { ChatMessage } from './advisor/providers';
import { sessionDigestInput } from './advisor/source';
import { Advisor, Capability } from './vscode/advisor';
import { CAPABILITY_LABELS } from './advisor/advisors';
import { AuditLog } from './advisor/audit';
import { EffectivenessInput, proposeHeuristicsMessages } from './advisor/proposeHeuristics';
import { heuristicEffectiveness } from './review/effectiveness';
import { nudgeLine, nudgeLineMessages, proposeNudgesMessages } from './advisor/proposeNudges';
import { proposeTacticsMessages } from './advisor/proposeTactics';
import { headlineLine, headlineMessages } from './advisor/summarizeSession';
import { Headliner, HeadlineEntry } from './advisor/headlines';
import { positiveNumberOr } from './heuristics/settings';
import { AdvisorLimit, Nudge, Nudger, NudgeSettings, NotifyLevel } from './nudges/nudger';
import { episodeResponse, ResponseEpisode, ResponseLog, ResponseTracker } from './heuristics/responses';
import { buildReview, isoWeek, renderReview, Review } from './review/review';
import { advisorSection, summarizeWeekMessages } from './advisor/summarizeWeek';
import * as os from 'os';
import * as fs from 'fs';
import { hasCapturedText, withoutCapturedText } from './core/excerpt';
import { ContextLimits, ModelContextMarks } from './core/contextLimits';
import { AggregateStore, EventSink, RetentionPolicy, applyRetention, oldestKeptDay } from './core/retention';
import { HealthRegistry } from './core/health';
import { makeAdapterContext } from './core/adapterContext';
import { AgentAdapter, NormalizedEvent, NormalizedEventKind } from '@snagboat/schema';
import { renderStatusBar } from './ui/statusBar';
import { buildBreakdownLines, formatCount } from './ui/format';
import { buildDetailState, TIMELINE_LIMIT } from './ui/detailModel';
import { DetailPanel } from './ui/detailPanel';
import { EditTrackerAdapter } from './vscode/editTracker';
import { vscodeHost } from './vscode/host';
import { resolveStorage, watchPerUserStoreSetting } from './vscode/storage';
import { syncSettingsToConfig } from './vscode/configSync';
import { ClaudeCodeAdapter } from './adapters/claude-code';
import { removeHooksConfigured } from './adapters/claude-code/hooksConfig';
import { CopilotAdapter } from './adapters/copilot';
import { FindingsRegistry } from './heuristics/findingsRegistry';
import { EVENT_STORE_MAX_EVENTS, EVENT_STORE_WINDOW_MS, HEURISTICS_INTERVAL_MS as POLL_INTERVAL_MS, HeuristicsEngine } from './heuristics/engine';
import { builtInHeuristics, heuristicSettings, heuristicSettingsSection, settingsRuleSource } from './heuristics/index';
import { Finding, Heuristic, Progress } from './heuristics/types';
import type { WorkspaceFindings } from './core/service/findings';
import { buildRuleSet } from './heuristics/rule';
import { ruleHeuristic } from './heuristics/ruleHeuristic';
import { RuleStore } from './heuristics/ruleStore';
import { setShellSubCategories } from '@snagboat/schema';
import { runDiscovery } from './discovery/discover';
import { SuggestionsController } from './ui/suggestionsController';
import { exportRules, importRules } from './ui/ruleTransfer';

const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
/** A finding that passed unanswered in less time than this isn't recorded as an outcome: it flickered. */
const MIN_PASSED_EPISODE_MS = 30_000;
const MUTED_HEURISTICS_KEY = 'snagboat.mutedHeuristics';
// Global: saved rules are shared by every workspace, so a dismissed suggestion stays dismissed everywhere.
const DISMISSED_SUGGESTIONS_KEY = 'snagboat.dismissedSuggestions';
const RESPONDING_SINCE_KEY = 'snagboat.respondingSince';
const HEADLINES_KEY = 'snagboat.headlines';
/** Headlines are asked for sessions that ended within this many days. */
const HEADLINE_DAYS = 7;
const HEADLINE_INTERVAL_MS = 60_000;
/** After a quiet ask is skipped (no model, key, or approval yet), wait this long before trying again. */
const HEADLINE_BACKOFF_MS = 30 * 60_000;
/** The review's tactics section: this many of the costliest sessions, this many turns each. */
const REVIEW_TACTICS_SESSIONS = 2;
const REVIEW_TACTICS_TURNS = 20;


function retentionPolicy(): RetentionPolicy {
  const config = vscode.workspace.getConfiguration('snagboat.retention');
  return {
    rawDays: config.get<number>('rawDays', 90),
    aggregateDays: config.get<number>('aggregateDays', -1),
    textDays: config.get<number>('textDays', 30),
  };
}

function captureContentEnabled(): boolean {
  return vscode.workspace.getConfiguration('snagboat').get<boolean>('captureContent', true);
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * What the integration suite reads. Returned from activate only in a test run:
 * VS Code hands activate's result to any extension that asks for this one, and
 * this reaches the event store, with its targets and captured text.
 */
export interface SnagboatTestApi {
  getAggregateSnapshot(): AggregateSnapshot;
  getTodaySnapshot(): AggregateSnapshot;
  getEventStore(): ReadonlyEventStore;
  /** core: a client of the core (3c-3c); per-user: writes the per-user store itself; vscode: VS Code's storage. */
  getStorageMode(): 'core' | 'per-user' | 'vscode';
  getContextLimits(): Record<string, ModelContextMarks>;
  getSessions(): SessionController;
  getFindings(): Finding[];
  /** VS Code's storage folder for this window (context.storageUri), whichever store the setting picks. */
  getVsCodeStorageDir(): string | undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<SnagboatTestApi | undefined> {
  // The engine reads settings and workspace folders through the host (docs/design/architecture-rfc.md, step 2).
  setHost(vscodeHost);
  // VS Code's per-window storage, or the per-user store (snagboat.storage.perUserStore).
  const storage = await resolveStorage(context);
  const storageDir = storage.storageDir;
  context.subscriptions.push(watchPerUserStoreSetting());
  // The core and the CLI read settings from ~/.snagboat/config.json; this window keeps it current.
  if (storage.perUser) context.subscriptions.push(syncSettingsToConfig(context));
  // With the core running (3c-3c), it collects and writes this workspace's folder; this window follows it.
  const core = storage.core;
  if (core) context.subscriptions.push({ dispose: () => core.close() });

  const eventLog = new EventLog(storageDir, { workspace: storage.workspace });
  await eventLog.init();
  const checkpoints = new CheckpointStore(storageDir);
  await checkpoints.init();

  const aggregateStore = new AggregateStore(storageDir);
  await aggregateStore.init();

  // Prune before rehydrating, so nothing past retention is ever loaded. The core prunes the folders it writes.
  if (!core) {
    try {
      await applyRetention(eventLog, aggregateStore, retentionPolicy(), todayKey());
    } catch (err) {
      console.error('snagboat: retention failed on activation', err);
    }
  }

  // The core's feed replays the days written after this, so nothing falls between the read and the feed.
  const readAt = new Date(Date.now() - 2_000).toISOString();
  // The raw log is read once and shared by everything rehydrated from it.
  const logged = await eventLog.snapshot();
  const aggregate = new Aggregate();
  await aggregate.rehydrateFrom(logged, aggregateStore);
  const todayAggregate = new TodayAggregate();
  await todayAggregate.rehydrateFrom(logged);
  const dailyHistory = new DailyHistory();
  await dailyHistory.rehydrateFrom(logged, aggregateStore);
  // Sessions in the retained raw log.
  const sessionIndex = new SessionIndex();
  // Ids already logged, so an event delivered again (a source re-read after a
  // lost checkpoint) isn't logged or counted twice.
  const loggedIds = new Set<string>();
  for (const event of await logged.readAll()) {
    sessionIndex.ingest(event);
    loggedIds.add(event.eventId);
  }

  const eventStore = new EventStore({ windowMs: EVENT_STORE_WINDOW_MS, maxEvents: EVENT_STORE_MAX_EVENTS });
  await eventStore.rehydrateFrom(logged);

  // Shared by every workspace, so it lives in global storage, not this workspace's.
  const contextLimits = new ContextLimits(storage.sharedDir);
  await contextLimits.load();
  // Seed from recent history already in memory (new events update it as they arrive).
  for (const event of eventStore.query()) contextLimits.observe(event);
  context.subscriptions.push({ dispose: () => void contextLimits.dispose() });

  const health = new HealthRegistry();

  const outputChannel = vscode.window.createOutputChannel('Snagboat');
  context.subscriptions.push(outputChannel);

  // Saved rules and shell sub-categories, shared by every workspace, plus any written in settings.
  const ruleStore = new RuleStore(storage.rulesDir);
  let ruleStoreError: string | undefined;
  try {
    await ruleStore.load();
  } catch (err) {
    ruleStoreError = `saved rules couldn't be read and are off until the file is fixed: ${err instanceof Error ? err.message : String(err)}`;
  }

  // How you respond to findings (acknowledge, mute, or let them pass), for the review.
  const responseLog = new ResponseLog(storageDir);
  void responseLog.prune(retentionPolicy().rawDays, new Date().toISOString()).catch(() => undefined);
  if (!context.workspaceState.get<string>(RESPONDING_SINCE_KEY)) void context.workspaceState.update(RESPONDING_SINCE_KEY, new Date().toISOString());
  // Each ended episode is also an outcome (RFC step 4: finding usefulness), once the bus exists to carry it.
  let recordResponse: (episode: ResponseEpisode, refs: string[]) => void = () => undefined;
  const responses = new ResponseTracker((episode, refs) => {
    responseLog.append(episode);
    recordResponse(episode, refs);
  });
  context.subscriptions.push({ dispose: () => responseLog.appendNow(responses.drain()) });
  const findings = new FindingsRegistry(context.workspaceState.get<string[]>(MUTED_HEURISTICS_KEY, []), responses);
  const contextLimitFor = (model: string | undefined) => (model ? contextLimits.get(model)?.limit : undefined);
  let heuristics: Heuristic[] = [];
  let ruleProblems: string[] = [];
  let activeCategories: string | undefined;
  /** Set once the extension is up: offers to relabel past shell calls when the shell categories in use change. */
  let onCategoriesChanged: (() => void) | undefined;
  let engine = new HeuristicsEngine(heuristics, eventStore, heuristicSettings, contextLimitFor);
  /** Rebuilds the heuristics from the built-ins and the current rules; findings of rules that are gone are cleared. */
  const loadRules = () => {
    const ruleSet = buildRuleSet([ruleStore.source(), settingsRuleSource()]);
    setShellSubCategories(ruleSet.categories);
    const categories = JSON.stringify(ruleSet.categories);
    if (activeCategories !== undefined && categories !== activeCategories) onCategoriesChanged?.();
    activeCategories = categories;
    const next = [...builtInHeuristics(), ...ruleSet.rules.map(ruleHeuristic)];
    for (const h of heuristics) if (!next.some((n) => n.id === h.id)) findings.report(h.id, []);
    heuristics = next;
    engine = new HeuristicsEngine(heuristics, eventStore, heuristicSettings, contextLimitFor);
    ruleProblems = [...(ruleStoreError ? [ruleStoreError] : []), ...ruleSet.problems];
    for (const problem of ruleProblems) outputChannel.appendLine(`Rules: ${problem}`);
    health.report('rules', 'invalid', ruleProblems.length > 0 ? `${ruleProblems.length} rule or tool category problem${ruleProblems.length === 1 ? '' : 's'}; see the Snagboat output` : undefined);
  };
  loadRules();
  // Live nudges (opt-in): notifications for findings and early warnings, at most one per turn.
  // The advisors' notify limits (persona.md front matter, RFC step 4c), re-read at most once a minute.
  let advisorLimits: { at: number; limits: AdvisorLimit[] } | undefined;
  const limitsNow = (): AdvisorLimit[] => {
    if (!advisorLimits || Date.now() - advisorLimits.at > 60_000) {
      const { advisors, problems } = loadAdvisorGoals(path.join(snagboatHome(), 'advisors'));
      if (problems.length > 0 && !advisorLimits) for (const problem of problems) outputChannel.appendLine(`Advisors: ${problem}`);
      advisorLimits = { at: Date.now(), limits: advisors.map((a) => ({ advisor: a.id, rules: a.notify.rules, ...(a.notify.maxPerHour !== undefined ? { maxPerHour: a.notify.maxPerHour } : {}) })) };
    }
    return advisorLimits.limits;
  };
  const nudgeSettings = (): NudgeSettings => {
    const config = vscode.workspace.getConfiguration('snagboat.nudges');
    const quiet = config.get<unknown>('quiet', []);
    return {
      notify: config.get<NotifyLevel>('notify', 'off'),
      quiet: Array.isArray(quiet) ? quiet.filter((q): q is string => typeof q === 'string') : [],
      muted: findings.mutedHeuristics(),
      limits: limitsNow(),
    };
  };
  const nudger = new Nudger((refs) => {
    const wanted = new Set(refs);
    const events = eventStore.query().filter((e) => wanted.has(e.eventId));
    const inTurn = events.filter((e) => e.turnId).pop();
    return inTurn ? { sessionId: inTurn.sessionId, turnId: inTurn.turnId } : events[0] ? { sessionId: events[0].sessionId } : undefined;
  });
  /** The advisor's line for a finding in the tooltip, while that finding lasts. */
  const advice = new Map<string, { line: string; model: string }>();
  let showNudge: (nudge: Nudge) => void = () => undefined;
  // As a client of the core (3c-3d), the core works out findings and early warnings; this window applies them.
  // Until the core's first findings arrive, and whenever its stream is down, this window evaluates them itself,
  // so they neither wait on the core nor freeze while it's gone.
  let coreProgress: Progress[] = [];
  let fromCore = new Set<string>();
  let coreFindingsLive = false;
  const applyCoreFindings = (result: WorkspaceFindings) => {
    coreFindingsLive = true;
    const byId = new Map<string, Finding[]>();
    for (const f of result.findings) byId.set(f.heuristicId, [...(byId.get(f.heuristicId) ?? []), f]);
    // Also clears what this window found itself while the core was away.
    for (const id of new Set([...fromCore, ...heuristics.map((h) => h.id), ...byId.keys()])) findings.report(id, byId.get(id) ?? []);
    fromCore = new Set(byId.keys());
    coreProgress = result.progress;
    runHeuristics();
    refresh();
  };
  const runHeuristics = (kind?: NormalizedEventKind) => {
    const now = new Date().toISOString();
    if (!core || !coreFindingsLive) {
      const results = kind ? engine.tickFor(kind, now) : engine.tick(now);
      for (const [id, list] of results) findings.report(id, list);
    }
    const settings = nudgeSettings();
    if (settings.notify === 'off') return;
    const active = new Map<string, Finding[]>();
    for (const f of findings.list()) active.set(f.heuristicId, [...(active.get(f.heuristicId) ?? []), f]);
    for (const id of [...advice.keys()]) if (!active.has(id)) advice.delete(id);
    for (const nudge of nudger.update(active, core && coreFindingsLive ? coreProgress : engine.progress(now), settings)) showNudge(nudge);
  };

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'snagboat.openDetail';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Session headlines (opt-in): one line per ended session, asked quietly of the summarize-session advisor, one at a time.
  const headliner = new Headliner(context.workspaceState.get<Record<string, HeadlineEntry>>(HEADLINES_KEY, {}), (cache) => Promise.resolve(context.workspaceState.update(HEADLINES_KEY, cache)));
  const sessions = new SessionController(
    sessionIndex,
    eventLog,
    () => contextLimits.all(),
    {
      active: () => findings.list(),
      newReplay: () => new FindingReplay(heuristics, heuristicSettings, contextLimitFor),
      muted: () => findings.mutedHeuristics(),
    },
    { headline: (id) => headliner.get(id) }
  );
  // Discovery reads only this workspace's history; each workspace's log is separate.
  const discoveryDays = () => Math.max(1, vscode.workspace.getConfiguration('snagboat.discovery').get<number>('days', 30));
  const discoverySource = () => vscode.workspace.name ?? 'this window';
  const loadDiscoveryEvents = async () => {
    const since = new Date(Date.now() - (discoveryDays() - 1) * 86_400_000).toISOString().slice(0, 10);
    const logged = await eventLog.snapshot();
    const events: NormalizedEvent[] = [];
    for (const day of await logged.listDays()) if (day >= since) events.push(...(await logged.readDay(day)));
    return events;
  };
  const discoveryOptions = () => ({ existing: heuristics, settingsFor: heuristicSettings, contextLimit: contextLimitFor });
  const rulesChanged = () => {
    loadRules();
    runHeuristics();
    refresh();
    // The core reads the same rules (config.json, already synced, and rules.json); have it evaluate now.
    void core?.findings();
  };
  const suggestions = new SuggestionsController({
    loadEvents: loadDiscoveryEvents,
    options: discoveryOptions,
    store: ruleStore,
    settingsRules: settingsRuleSource,
    rulesChanged: () => rulesChanged(),
    applySetting: (heuristic, setting, value) => Promise.resolve(vscode.workspace.getConfiguration(heuristicSettingsSection(heuristic)).update(setting, value, vscode.ConfigurationTarget.Global)),
    dismissed: () => context.globalState.get<string[]>(DISMISSED_SUGGESTIONS_KEY, []),
    setDismissed: (ids) => Promise.resolve(context.globalState.update(DISMISSED_SUGGESTIONS_KEY, ids)),
    sessionName: (id) => sessionIndex.get(id)?.name,
    propose: async (build, advisorId) => {
      const asked = await advisor.ask('propose-heuristics', async ({ policy, prompts }) => proposeHeuristicsMessages(build(policy), prompts), { title: 'proposing heuristics', advisorId });
      if (!asked) return undefined;
      const warning = Advisor.cutWarning(asked, 'dismiss candidates you don\'t need and ask again, which sends less');
      return { text: asked.completion.text, provider: asked.advisor.label, model: asked.advisor.model, ...(warning ? { warning } : {}) };
    },
    advisorCount: () => advisor.offering('propose-heuristics').length,
    effectiveness: async (events): Promise<EffectivenessInput[]> => {
      const since = events.reduce((min, e) => (e.ts < min ? e.ts : min), new Date().toISOString());
      const episodes = (await responseLog.readAll()).filter((e) => e.startedAt >= since);
      const titles = new Map(ruleStore.list('rules').map((r) => [r.doc.id, typeof r.doc.title === 'string' ? r.doc.title : r.doc.id]));
      return heuristicEffectiveness(events, heuristics, heuristicSettings, contextLimitFor, episodes, findings.mutedHeuristics()).rows.map((r) => ({
        id: r.id,
        ...(titles.has(r.id) ? { title: titles.get(r.id) } : {}),
        builtIn: !r.id.includes(':'),
        episodes: r.episodes,
        warnings: r.warnings,
        sessions: r.sessions,
        ...(r.response ? { acknowledged: r.response.acknowledged, medianMinutesToAcknowledge: r.response.medianMinutesToAcknowledge, expiredUnacknowledged: r.response.expiredUnacknowledged } : {}),
        muted: r.muted,
      }));
    },
    roots: () => roots(),
    source: discoverySource,
    days: discoveryDays,
    now: () => new Date().toISOString(),
  });

  const roots = () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const digestInput = async (sessionId: string, turnId?: string) => {
    const summary = sessionIndex.get(sessionId);
    if (!summary) return undefined;
    await eventLog.flush();
    return sessionDigestInput(summary, eventLog, new FindingReplay(heuristics, heuristicSettings, contextLimitFor), { roots: roots(), contextLimit: contextLimitFor, sessionName: summary.name, ...(turnId ? { turnId } : {}) });
  };
  const audit = new AuditLog(storage.sharedDir);
  void audit.prune(retentionPolicy().rawDays, new Date().toISOString()).catch(() => undefined);
  const advisor = new Advisor({ secrets: context.secrets, globalState: context.globalState, audit, output: outputChannel, digestInput });

  const detailPanel = new DetailPanel(context.extensionUri, {
    suggestions,
    explain: (req) => advisor.explain(req),
    tactics: (sessionId) => advisor.tactics(sessionId),
    pickAdvisor: (ability) => advisor.pickAdvisor(ability),
    buildState: (isOpenable) =>
      buildDetailState({
        now: new Date().toISOString(),
        capture: { enabled: captureContentEnabled(), retentionDays: Math.max(1, Math.min(retentionPolicy().textDays, retentionPolicy().rawDays)) },
        today: todayAggregate.snapshot(),
        recentEvents: eventStore.lastN(TIMELINE_LIMIT + 1),
        findings: findings.views(),
        muted: findings.mutedHeuristics(),
        daily: dailyHistory.tokensByDay(),
        isOpenable,
        sessionName: (id) => sessionIndex.get(id)?.name,
      }),
    sessions,
    today: todayKey,
    acknowledge: (heuristicId) => findings.acknowledge(heuristicId),
    useful: (heuristicId) => findings.markUseful(heuristicId),
    setMuted: (heuristicId, muted) => {
      findings.setMuted(heuristicId, muted);
      void context.workspaceState.update(MUTED_HEURISTICS_KEY, findings.mutedHeuristics());
    },
  });
  context.subscriptions.push(detailPanel);

  const withAdvice = (list: Finding[]): Finding[] =>
    list.map((f) => {
      const a = advice.get(f.heuristicId);
      return a ? { ...f, suggestedAction: [f.suggestedAction, `advisor (model output, ${a.model}): ${a.line}`].filter(Boolean).join(' · ') } : f;
    });
  const refresh = () => {
    renderStatusBar(statusBarItem, aggregate.snapshot(), health.list(), todayAggregate.snapshot(), withAdvice(findings.visible()), findings.worst());
    detailPanel.scheduleUpdate();
  };
  refresh();
  health.onChange(refresh);
  findings.onChange(refresh);

  const bus = new EventBus();
  const testsGreen = new TestsGreen();
  recordResponse = (episode, refs) => {
    const response = episodeResponse(episode);
    const endedAt = episode.endedAt;
    if (!endedAt) return;
    // A finding that came and went within seconds unanswered says nothing about its use: it flickered (as when a
    // window hands its findings over to the core, or back). Wait for the report that ended it to finish, too.
    if (response === 'passed' && Date.parse(endedAt) - Date.parse(episode.startedAt) < MIN_PASSED_EPISODE_MS) return;
    queueMicrotask(() => {
      // A rule you deleted ended its episode by going away, not by passing.
      if (!heuristics.some((h) => h.id === episode.heuristicId) && !fromCore.has(episode.heuristicId)) return;
      // Filed in the session of the finding's latest event; a finding with none in reach isn't recorded.
      const wanted = new Set(refs);
      const ref = eventStore.query().filter((e) => wanted.has(e.eventId)).pop();
      if (!ref) return;
      bus.publish({
        eventId: `outcome:finding_response:${episode.heuristicId}:${episode.startedAt}`,
        sessionId: ref.sessionId,
        agent: ref.agent,
        ts: endedAt,
        kind: 'outcome',
        status: 'unknown',
        outcome: { type: 'finding_response', heuristicId: episode.heuristicId, response, refs },
        raw: { adapter: OUTCOMES_ADAPTER, ref: `finding:${episode.heuristicId}:${episode.startedAt}` },
      });
    });
  };
  // Retention runs, aggregate merges from the sink, and Clear Event Log all
  // touch the same files, so they share one queue and never interleave.
  let retentionQueue: Promise<void> = Promise.resolve();
  const enqueueStorageOp = (op: () => Promise<void>) => {
    retentionQueue = retentionQueue.then(op).catch((err) => console.error('snagboat: storage operation failed', err));
  };
  // Like enqueueStorageOp, but the caller sees the operation's result or failure. With the core, the
  // operation runs with this workspace's folder held, so the core writes nothing there meanwhile.
  const holding = (op: () => Promise<void>) => (core ? () => core.hold(storageDir, op) : op);
  const runStorageOp = (op: () => Promise<void>): Promise<void> => {
    const run = retentionQueue.then(holding(op));
    retentionQueue = run.catch(() => undefined);
    return run;
  };
  const sink = new EventSink(eventLog, aggregateStore, retentionPolicy, todayKey, enqueueStorageOp);

  // While the log is reloaded from disk (after a backfill), live events wait
  // here, so none is counted twice or missed by the half-rebuilt state.
  let heldEvents: NormalizedEvent[] | undefined;
  const reloadFromLog = async () => {
    heldEvents = [];
    try {
      const openSession = sessions.openSessionId;
      const explored = sessions.exploredSessionIds;
      sessions.closeExplorer(); // so explore() below re-reads them from the reloaded log
      aggregate.reset();
      todayAggregate.reset();
      dailyHistory.reset();
      sessionIndex.reset();
      eventStore.reset();
      loggedIds.clear();
      testsGreen.reset();
      const logged = await eventLog.snapshot();
      await aggregate.rehydrateFrom(logged, aggregateStore);
      await todayAggregate.rehydrateFrom(logged);
      await dailyHistory.rehydrateFrom(logged, aggregateStore);
      for (const event of await logged.readAll()) {
        sessionIndex.ingest(event);
        loggedIds.add(event.eventId);
        contextLimits.observe(event);
      }
      await eventStore.rehydrateFrom(logged);
      if (openSession) await sessions.open(openSession);
      if (explored.length > 0) await sessions.explore(explored);
    } finally {
      const held = heldEvents;
      heldEvents = undefined;
      for (const event of held) handleEvent(event);
      runHeuristics();
      refresh();
    }
  };

  const handleEvent = (event: NormalizedEvent) => {
    if (heldEvents) {
      heldEvents.push(event);
      return;
    }
    if (loggedIds.has(event.eventId)) return;
    loggedIds.add(event.eventId);
    // A window writing its own folder works out outcomes too (the core does for its clients).
    if (!core) for (const outcome of testsGreen.observe([event])) queueMicrotask(() => bus.publish(outcome));
    contextLimits.observe(event);
    // An event older than all retention isn't stored, so it's left out of the
    // all-time totals and chart too; they'd otherwise drop on the next reload.
    // The core sends only what it stored.
    if (core || sink.write(event)) {
      aggregate.apply(event);
      dailyHistory.apply(event);
      sessionIndex.ingest(event);
      sessions.ingest(event);
    }
    todayAggregate.apply(event);
    eventStore.ingest(event);
    runHeuristics(event.kind);
    refresh();
  };
  if (core) {
    // What this window's own adapters see (edits, Copilot) goes to the core, and comes back on its feed.
    let outgoing: NormalizedEvent[] = [];
    bus.onEvent((event) => {
      outgoing.push(event);
      if (outgoing.length > 1) return;
      setImmediate(() => {
        const batch = outgoing;
        outgoing = [];
        core.post(batch).catch((err) => {
          console.error('snagboat: events could not be sent to the core or spooled', err);
          health.report('core', 'post', `events could not be sent to the core: ${err instanceof Error ? err.message : String(err)}`);
        });
      });
    });
  } else {
    bus.onEvent(handleEvent);
  }

  // Catch a stalled/over-budget condition immediately on activation (e.g. the
  // workspace was already idle before this window opened), rather than
  // waiting for the first timer tick.
  runHeuristics();
  const pollTimer = setInterval(() => {
    runHeuristics();
    refresh();
  }, POLL_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });

  // Long-lived windows cross midnight, so retention reruns hourly as well as
  // whenever its settings change. Runs are serialized so two never race over
  // the same files.
  const runRetention = () => {
    if (core) {
      // The core prunes the folders it writes; this window then reloads, so nothing it pruned stays in memory.
      retentionQueue = retentionQueue
        .then(async () => {
          if ((await core.retention()) > 0) await reloadFromLog();
        })
        .catch((err) => console.error('snagboat: retention failed', err));
      return retentionQueue;
    }
    retentionQueue = retentionQueue
      .then(async () => {
        const result = await applyRetention(eventLog, aggregateStore, retentionPolicy(), todayKey());
        for (const daily of result.dropped) {
          aggregate.applyDaily(daily, -1);
          dailyHistory.removeDay(daily.date);
        }
        if (result.dropped.length > 0) refresh();
        // Text just aged out on disk may still be held in memory (the recent-events window, an open session).
        if (result.textRemoved.length > 0) await reloadFromLog();
      })
      .catch((err) => console.error('snagboat: retention failed', err));
    return retentionQueue;
  };
  const retentionTimer = setInterval(runRetention, RETENTION_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(retentionTimer) });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('snagboat.retention')) runRetention();
      if (e.affectsConfiguration('snagboat.captureContent')) detailPanel.scheduleUpdate();
      if (e.affectsConfiguration('snagboat.rules') || e.affectsConfiguration('snagboat.toolCategories')) rulesChanged();
      // The core reads heuristics' thresholds from config.json (synced already); have it evaluate now.
      else if (core && (e.affectsConfiguration('snagboat.heuristics') || e.affectsConfiguration('snagboat.tokenBudget'))) void core.findings();
    })
  );

  const reviewFile = (week: string) => {
    const configured = vscode.workspace.getConfiguration('snagboat.advisor').get<string>('reviewDirectory', '');
    const dir = configured ? configured.replace(/^~(?=$|\/)/, os.homedir()) : path.join(os.homedir(), '.snagboat', 'reviews');
    return path.join(dir, `${week}-${discoverySource().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace'}.md`);
  };
  /** Writes this week's review of the last 7 days, without a model. */
  const writeReview = async (): Promise<{ file: string; review: Review }> => {
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
    await eventLog.flush();
    const logged = await eventLog.snapshot();
    const events: NormalizedEvent[] = [];
    for (const day of await logged.listDays()) if (day >= from.slice(0, 10)) events.push(...(await logged.readDay(day)).filter((e) => e.ts >= from));
    const discovery = runDiscovery(await loadDiscoveryEvents(), discoveryOptions()).result;
    const review = buildReview({
      workspace: discoverySource(),
      from,
      to,
      events,
      heuristics,
      settingsFor: heuristicSettings,
      contextLimit: contextLimitFor,
      savedRules: ruleStore.list('rules').map((r) => ({ id: r.doc.id, title: typeof r.doc.title === 'string' ? r.doc.title : r.doc.id, provenance: r.provenance })),
      responses: (await responseLog.readAll()).filter((e) => e.startedAt >= from),
      respondingSince: context.workspaceState.get<string>(RESPONDING_SINCE_KEY),
      muted: findings.mutedHeuristics(),
      discovery,
      notifying: nudgeSettings().notify !== 'off',
    });
    // The advisors' measures (RFC step 4c): this week against the one before, from the same log.
    const weeks = periods(new Date(to), 7);
    const goals = loadAdvisorGoals(path.join(snagboatHome(), 'advisors'));
    for (const problem of goals.problems) outputChannel.appendLine(`Advisors: ${problem}`);
    review.advisors = advisorReports(goals.advisors, await eventsIn([logged], weeks.current), await eventsIn([logged], weeks.previous));
    const file = reviewFile(isoWeek(to));
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, renderReview(review));
    return { file, review };
  };
  /** The abilities a review asks for, each appended to the file as its own labelled section. */
  const REVIEW_ABILITIES: Array<{ ability: Capability; title: string; progress: string; build: (r: Review, prompts: PromptLayers, policy: DigestPolicy) => Promise<ChatMessage[] | undefined> }> = [
    { ability: 'summarize-week', title: "The advisor's summary of the week", progress: 'summarizing the week', build: async (r, prompts, policy) => summarizeWeekMessages(r, prompts, policy) },
    { ability: 'propose-nudges', title: 'The advisor on how findings were shown', progress: 'reviewing how findings were shown', build: async (r, prompts, policy) => proposeNudgesMessages(r, prompts, policy) },
    {
      ability: 'propose-tactics',
      title: 'The advisor on tactics to try',
      progress: 'proposing tactics',
      // The costliest sessions' digests, a few turns each, under this ability's sending rules.
      build: async (r, prompts, policy) => {
        const digests = [];
        for (const s of r.usage.costliest.slice(0, REVIEW_TACTICS_SESSIONS)) {
          const input = await digestInput(s.sessionId);
          if (input) digests.push(buildDigest({ ...input, maxTurns: REVIEW_TACTICS_TURNS }, policy));
        }
        return digests.length > 0 ? proposeTacticsMessages(digests, prompts, Advisor.modelTiers()) : undefined;
      },
    },
  ];
  /**
   * Asks for the advisor's part of a written review: the week's summary and the
   * nudge review, from the ability's default advisor, or from one advisor for
   * whichever of the two it offers.
   */
  const askReview = async (written: { file: string; review: Review }, advisorId?: string) => {
    let appended = false;
    for (const { ability, title, progress, build } of REVIEW_ABILITIES) {
      if (advisorId && !advisor.advisors().find((a) => a.id === advisorId)?.abilities[ability]) continue;
      const asked = await advisor.ask(ability, ({ prompts, policy }) => build(written.review, prompts, policy), { title: progress, advisorId });
      if (!asked) continue;
      const warning = Advisor.cutWarning(asked, 'its context window is too small for a week of data');
      await fs.promises.appendFile(written.file, advisorSection(title, asked.completion.text, Advisor.label(asked), warning || undefined));
      appended = true;
    }
    if (appended) await vscode.window.showTextDocument(vscode.Uri.file(written.file), { preview: false });
  };
  /** Offers the advisor's review of a written one; another advisor can be asked when several offer it. */
  const offerAdvisorReview = async (written: { file: string; review: Review }, message: string) => {
    const several = REVIEW_ABILITIES.some(({ ability }) => advisor.offering(ability).length > 1);
    const choice = await vscode.window.showInformationMessage(message, 'Open', 'Ask the Advisor', ...(several ? ['Ask Another Advisor'] : []));
    if (choice === 'Open') await vscode.window.showTextDocument(vscode.Uri.file(written.file), { preview: false });
    else if (choice === 'Ask the Advisor') await askReview(written);
    else if (choice === 'Ask Another Advisor') {
      const id = await pickReviewAdvisor();
      if (id) await askReview(written, id);
    }
  };
  /** Any advisor offering either of the review's abilities. */
  const pickReviewAdvisor = async (): Promise<string | undefined> => {
    const seen = new Set<string>();
    const options = REVIEW_ABILITIES.flatMap(({ ability }) => advisor.offering(ability)).filter((a) => !seen.has(a.id) && seen.add(a.id));
    const pick = await vscode.window.showQuickPick(
      options.map((a) => ({ label: a.label, description: `${a.locality === 'local' ? 'on this machine' : a.baseUrl}${a.model ? ` · ${a.model}` : ''}`, detail: REVIEW_ABILITIES.filter(({ ability }) => a.abilities[ability]).map(({ ability }) => CAPABILITY_LABELS[ability]).join('; '), id: a.id })),
      { placeHolder: 'Which advisor should review the week?' }
    );
    return pick?.id;
  };
  // Weekly review, opt-in: once per ISO week, the first time a window is open, without a model.
  const weeklyReview = async () => {
    if (!vscode.workspace.getConfiguration('snagboat.advisor').get<boolean>('weeklyReview', false)) return;
    const file = reviewFile(isoWeek(new Date().toISOString()));
    if (fs.existsSync(file)) return;
    try {
      void offerAdvisorReview(await writeReview(), "Snagboat: wrote this week's review.");
    } catch (err) {
      outputChannel.appendLine(`Review: couldn't write the weekly review: ${String(err)}`);
    }
  };
  showNudge = (nudge: Nudge) => {
    // Each notification shown is an outcome (Lookout's measures), filed in its session.
    const wanted = new Set(nudge.eventRefs);
    const ref = nudge.sessionId ? undefined : eventStore.query().filter((e) => wanted.has(e.eventId)).pop();
    const notifiedSession = nudge.sessionId ?? ref?.sessionId;
    if (notifiedSession) {
      const at = new Date().toISOString();
      queueMicrotask(() =>
        bus.publish({
          eventId: `outcome:notified:${nudge.heuristicId}:${at}`,
          sessionId: notifiedSession,
          agent: ref?.agent ?? eventStore.query({ sessionId: notifiedSession }).at(-1)?.agent ?? 'claude-code',
          ts: at,
          kind: 'outcome',
          status: 'unknown',
          outcome: { type: 'notified', heuristicId: nudge.heuristicId, refs: nudge.eventRefs.slice(0, 20), ...(nudge.advisor ? { advisor: nudge.advisor } : {}) },
          raw: { adapter: OUTCOMES_ADAPTER, ref: `notified:${nudge.heuristicId}` },
        })
      );
    }
    const text = `Snagboat: ${nudge.summary}${nudge.suggestedAction ? `. ${nudge.suggestedAction}` : ''}`;
    const actions = [...(nudge.sessionId ? ['Show in Session'] : []), ...(nudge.sessionId ? ['Explain'] : []), ...(nudge.early ? [] : ['Useful', 'Acknowledge']), 'Mute'];
    const shown = nudge.severity === 'warn' ? vscode.window.showWarningMessage(text, ...actions) : vscode.window.showInformationMessage(text, ...actions);
    void shown.then((choice) => {
      if (choice === 'Show in Session' && nudge.sessionId) detailPanel.show({ sessionId: nudge.sessionId });
      else if (choice === 'Explain' && nudge.sessionId) void advisor.explain({ sessionId: nudge.sessionId, ...(nudge.turnId ? { turnId: nudge.turnId } : {}), ...(nudge.early ? {} : { heuristicId: nudge.heuristicId }) });
      else if (choice === 'Useful') findings.markUseful(nudge.heuristicId);
      else if (choice === 'Acknowledge') findings.acknowledge(nudge.heuristicId);
      else if (choice === 'Mute') {
        findings.setMuted(nudge.heuristicId, true);
        void context.workspaceState.update(MUTED_HEURISTICS_KEY, findings.mutedHeuristics());
      }
    });
    // The advisor's one line, opt-in, only for findings in one turn, and only quietly: no prompts mid-work.
    if (nudge.early || !nudge.sessionId || !nudge.turnId || !vscode.workspace.getConfiguration('snagboat.nudges').get<boolean>('advisor', false)) return;
    const { sessionId, turnId } = nudge;
    void advisor
      .ask(
        'propose-nudges',
        async ({ policy, prompts }) => {
          const input = await digestInput(sessionId, turnId);
          if (!input) return undefined;
          const digest = buildDigest(input, policy);
          return nudgeLineMessages(digest, nudge.heuristicId, digest.findings.find((f) => f.heuristic === nudge.heuristicId)?.summary ?? '', false, prompts);
        },
        { title: `asking the advisor about ${nudge.heuristicId}`, quiet: true }
      )
      .then((asked) => {
        const line = asked && nudgeLine(asked.completion.text);
        if (!asked || !line || !findings.list().some((f) => f.heuristicId === nudge.heuristicId)) return;
        advice.set(nudge.heuristicId, { line, model: asked.advisor.model });
        refresh();
      });
  };

  const weeklyTimer = setInterval(() => void weeklyReview(), RETENTION_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(weeklyTimer) });

  let headlining = false;
  let headlineBackoffUntil = 0;
  const headlineTick = async () => {
    if (headlining || Date.now() < headlineBackoffUntil || !vscode.workspace.getConfiguration('snagboat.advisor').get<boolean>('headlines', false)) return;
    const now = new Date().toISOString();
    const idleMinutes = positiveNumberOr(heuristicSettings('stalled').minutes, 15);
    const all = sessionIndex.list();
    await headliner.prune(new Set(all.map((s) => s.sessionId)));
    const [due] = headliner.due(all, now, idleMinutes, HEADLINE_DAYS);
    if (!due) return;
    headlining = true;
    try {
      const asked = await advisor.ask(
        'summarize-session',
        async ({ policy, prompts }) => {
          const input = await digestInput(due.sessionId);
          return input ? headlineMessages(buildDigest(input, policy), prompts) : undefined;
        },
        { title: `headlining session ${due.sessionId.slice(0, 8)}`, quiet: true }
      );
      if (!asked) {
        headlineBackoffUntil = Date.now() + HEADLINE_BACKOFF_MS;
        return;
      }
      await headliner.record(due.sessionId, due.lastTs, headlineLine(asked.completion.text), asked.advisor.model, now);
      detailPanel.scheduleUpdate();
    } finally {
      headlining = false;
    }
  };
  const headlineTimer = setInterval(() => void headlineTick(), HEADLINE_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(headlineTimer) });
  // A minute in, so activation and catching up on transcripts come first.
  const firstWeekly = setTimeout(() => void weeklyReview(), 60_000);
  context.subscriptions.push({ dispose: () => clearTimeout(firstWeekly) });

  const pickSession = async (placeHolder: string): Promise<string | undefined> => {
    const recent = sessionIndex.list().slice(0, 40);
    if (recent.length === 0) {
      void vscode.window.showInformationMessage('Snagboat: no agent sessions recorded yet.');
      return undefined;
    }
    const agentName = (a: string) => (a === 'claude-code' ? 'Claude Code' : a === 'copilot' ? 'Copilot' : a);
    const pick = await vscode.window.showQuickPick(
      recent.map((s) => ({
        label: `${agentName(s.agent)} \u00b7 ${new Date(s.firstTs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
        description: `${s.prompts} prompts \u00b7 ${formatCount(s.tokens)} tokens`,
        detail: `${s.models.join(', ') || 'no model calls'} \u00b7 session ${s.sessionId.slice(0, 8)}`,
        sessionId: s.sessionId,
      })),
      { placeHolder, matchOnDescription: true, matchOnDetail: true }
    );
    return pick?.sessionId;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('snagboat.showBreakdown', () => {
      outputChannel.clear();
      outputChannel.appendLine(buildBreakdownLines(aggregate.snapshot(), health.list(), findings.visible(), todayAggregate.snapshot()).join('\n'));
      const limits = Object.entries(contextLimits.all()).sort(([a], [b]) => a.localeCompare(b));
      if (limits.length > 0) {
        outputChannel.appendLine('\nContext by model (all workspaces):');
        for (const [model, marks] of limits) {
          const parts = [marks.largestSeen !== undefined ? `largest seen ${marks.largestSeen.toLocaleString()}` : undefined, marks.limit !== undefined ? `limit ${marks.limit.toLocaleString()} (auto-compaction)` : undefined].filter(Boolean);
          outputChannel.appendLine(`  ${model}: ${parts.join(', ')}`);
        }
      }
      if (ruleProblems.length > 0) {
        outputChannel.appendLine('\nRule problems (these were ignored):');
        for (const problem of ruleProblems) outputChannel.appendLine(`  ${problem}`);
      }
      outputChannel.show();
    }),
    vscode.commands.registerCommand('snagboat.openDetail', () => detailPanel.show()),
    vscode.commands.registerCommand('snagboat.openSession', async () => {
      const sessionId = await pickSession('Open a session (most recent first)');
      if (sessionId) detailPanel.show({ sessionId });
    }),
    vscode.commands.registerCommand('snagboat.openAdvisorUi', async () => {
      // The advisor UI (RFC step 5a) is served by the core, which runs with the per-user store on.
      if (!core) {
        void vscode.window.showInformationMessage('Snagboat: the advisor UI is served by the core service, which runs with snagboat.storage.perUserStore on (User settings, then reload).');
        return;
      }
      const info = await findCore(snagboatHome());
      if (!info) {
        void vscode.window.showWarningMessage('Snagboat: the core service isn\'t answering; reload the window to start it again.');
        return;
      }
      // In a remote window (dev container, SSH, Codespaces) VS Code forwards the core's port, and the browser reaches
      // it under another address: ask for that address, and have the core accept it.
      const external = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${info.port}/`));
      const forwarded = external.authority.toLowerCase() !== `127.0.0.1:${info.port}`;
      const res = await coreRequest(info.port, info.token, 'POST', '/ui-links', { ...(storage.workspace ? { workspace: storage.workspace } : {}), ...(forwarded ? { allowHost: external.authority } : {}) });
      if (res.status !== 200) {
        void vscode.window.showErrorMessage(`Snagboat: the core couldn't open the advisor UI: ${JSON.stringify(res.body)}`);
        return;
      }
      const { code } = res.body as { code: string };
      await vscode.env.openExternal(external.with({ path: '/ui/', fragment: code }));
    }),
    vscode.commands.registerCommand('snagboat.revealEventLog', async () => {
      // Shows the daily files' folder in the file manager (to load them into the
      // web demo), creating nothing: activation makes the folder, so an empty
      // one means nothing has been logged yet either.
      const dir = eventLog.dir;
      if (!fs.existsSync(dir) || (await eventLog.listDays()).length === 0) {
        void vscode.window.showInformationMessage(`Snagboat: no events have been logged yet (the event log folder is ${dir}).`);
        return;
      }
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
    }),
    vscode.commands.registerCommand('snagboat.previewDigest', async () => {
      const sessionId = await pickSession('Preview the advisor digest of a session (most recent first)');
      if (!sessionId) return;
      const describePolicy = (p: { prompts: boolean; replies: boolean; sessionNames: boolean; paths: string }) =>
        `sends ${[p.prompts && 'prompts', p.replies && 'replies', p.sessionNames && 'session names'].filter(Boolean).join(', ') || 'no text'}; paths ${p.paths}`;
      // One entry per advisor and ability, since each ability can have its own sending rules.
      const pick = await vscode.window.showQuickPick(
        advisor.advisors().flatMap((a) =>
          (Object.entries(a.abilities) as Array<[Capability, { policy: typeof a.policy }]>).map(([ability, { policy }]) => ({
            label: a.label,
            description: `${CAPABILITY_LABELS[ability]} · ${a.locality === 'local' ? 'on this machine' : a.baseUrl}`,
            detail: describePolicy(policy),
            policy,
            ability,
          }))
        ),
        { placeHolder: 'As sent to which advisor, for which ability?', matchOnDescription: true }
      );
      if (!pick) return;
      const input = await digestInput(sessionId);
      if (!input) return;
      const content = `// Snagboat advisor digest, as ${pick.label} would receive it for "${pick.ability}". Indented here for reading; it's sent without indentation.\n${digestForReading(buildDigest(input, pick.policy))}\n`;
      const doc = await vscode.workspace.openTextDocument({ language: 'jsonc', content });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand('snagboat.explainSession', async () => {
      const sessionId = await pickSession('Explain a session (most recent first)');
      if (sessionId) await advisor.explain({ sessionId });
    }),
    vscode.commands.registerCommand('snagboat.tacticsSession', async () => {
      const sessionId = await pickSession('Propose tactics for a session (most recent first)');
      if (sessionId) await advisor.tactics(sessionId);
    }),
    vscode.commands.registerCommand('snagboat.explainSessionWith', async () => {
      const advisorId = await advisor.pickAdvisor('summarize-session', 'Which advisor should explain it?');
      if (!advisorId) return;
      const sessionId = await pickSession('Explain a session (most recent first)');
      if (sessionId) await advisor.explain({ sessionId }, advisorId);
    }),
    vscode.commands.registerCommand('snagboat.setAdvisorKey', () => advisor.setKey()),
    vscode.commands.registerCommand('snagboat.writeAdvisorPrompts', () => advisor.writeDefaultPrompts()),
    vscode.commands.registerCommand('snagboat.writeReview', async () => {
      const written = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Snagboat: writing the review…' }, () => writeReview());
      await vscode.window.showTextDocument(vscode.Uri.file(written.file), { preview: false });
      void offerAdvisorReview(written, 'Snagboat: wrote the review.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('snagboat.backfill', () =>
      runBackfill({
        eventLog,
        runStorageOp,
        reloadFromLog,
        oldestRawDay: () => oldestKeptDay(todayKey(), retentionPolicy().rawDays),
        captureContent: captureContentEnabled,
        output: outputChannel,
      })
    ),
    vscode.commands.registerCommand('snagboat.relabelShellCalls', () => runRelabel({ eventLog, runStorageOp, reloadFromLog })),
    vscode.commands.registerCommand('snagboat.removeClaudeHooks', async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) {
        vscode.window.showInformationMessage('Snagboat: no workspace folder is open.');
        return;
      }
      let picked = [...folders];
      if (folders.length > 1) {
        const items = await vscode.window.showQuickPick(
          folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
          { canPickMany: true, placeHolder: "Folders to remove Snagboat's Claude Code hooks from" }
        );
        if (!items || items.length === 0) return;
        picked = items.map((i) => i.folder);
      }
      const choice = await vscode.window.showWarningMessage(
        `Remove Snagboat's Claude Code hooks from ${picked.map((f) => f.name).join(', ')}?`,
        {
          modal: true,
          detail:
            "Removes Snagboat's entries from .claude/settings.json, leaving other hooks and settings alone, and turns off snagboat.claudeCode.configureHooks for the folder so they aren't added back. Token usage still comes from transcripts; hook events (tool calls and turn ends) stop.",
        },
        'Remove'
      );
      if (choice !== 'Remove') return;
      const removed: string[] = [];
      const failed: string[] = [];
      for (const folder of picked) {
        try {
          // Off first, so the adapter doesn't add the hooks back meanwhile.
          await vscode.workspace.getConfiguration('snagboat', folder.uri).update('claudeCode.configureHooks', false, vscode.ConfigurationTarget.WorkspaceFolder);
          if (await removeHooksConfigured(folder.uri.fsPath)) removed.push(folder.name);
        } catch (err) {
          failed.push(`${folder.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (failed.length > 0) vscode.window.showErrorMessage(`Snagboat: couldn't remove hooks from ${failed.join('; ')}`);
      if (failed.length < picked.length) {
        vscode.window.showInformationMessage(
          removed.length > 0 ? `Snagboat: removed its Claude Code hooks from ${removed.join(', ')}.` : 'Snagboat: no Snagboat hooks were found; they won\'t be added to these folders.'
        );
      }
    }),
    vscode.commands.registerCommand('snagboat.discover', async () => {
      detailPanel.show({ tab: 'suggestions' });
      await suggestions.discover();
    }),
    vscode.commands.registerCommand('snagboat.exportRules', () => exportRules(ruleStore)),
    vscode.commands.registerCommand('snagboat.importRules', () =>
      importRules({
        store: ruleStore,
        score: async (rules) => runDiscovery(await loadDiscoveryEvents(), discoveryOptions()).score(rules),
        workspace: discoverySource(),
        days: discoveryDays(),
        now: () => new Date().toISOString(),
        rulesChanged,
        output: outputChannel,
      })
    ),
    vscode.commands.registerCommand('snagboat.removeCapturedText', async () => {
      const turnOff = 'Remove and Turn Off Capture';
      const choice = await vscode.window.showWarningMessage(
        "Remove all captured prompts and reply excerpts from this workspace's event log?",
        { modal: true, detail: 'Every event is kept; only its prompt text and reply excerpt are removed. Session names are kept. This cannot be undone.' },
        'Remove',
        turnOff
      );
      if (!choice) return;
      // Off first, so nothing new is captured while the log is being cleaned.
      if (choice === turnOff) await vscode.workspace.getConfiguration('snagboat').update('captureContent', false, vscode.ConfigurationTarget.Global);
      let days = 0;
      try {
        await runStorageOp(async () => {
          await eventLog.flush();
          for (const day of await eventLog.listDays()) {
            if (!(await eventLog.readDay(day)).some(hasCapturedText)) continue;
            await eventLog.rewriteDay(day, (events) => events.map(withoutCapturedText));
            days += 1;
          }
          await reloadFromLog();
        });
      } catch (err) {
        vscode.window.showErrorMessage(`Snagboat: failed to remove captured text: ${String(err)}`);
        return;
      }
      vscode.window.showInformationMessage(`Snagboat: removed captured text from ${days} day(s) of events${choice === turnOff ? ' and turned capture off' : ''}.`);
    }),
    vscode.commands.registerCommand('snagboat.clearLog', async () => {
      const choice = await vscode.window.showWarningMessage(
        'Delete all Snagboat event logs and daily aggregates for this workspace? This cannot be undone.',
        { modal: true, detail: 'Adapter checkpoints are kept, so already-seen transcript and log history is not re-imported.' },
        'Delete'
      );
      if (choice !== 'Delete') return;
      // Queued behind any in-flight retention run so the two never touch the same files at once.
      // In-memory state is reset in the same continuation as the last file
      // delete, so no event can land between the wipe and the reset.
      const clearOp = retentionQueue.then(holding(async () => {
        await aggregateStore.clear();
        await eventLog.clear();
        await responseLog.clear();
        aggregate.reset();
        todayAggregate.reset();
        dailyHistory.reset();
        sessionIndex.reset();
        sessions.close();
        sessions.closeExplorer();
        eventStore.reset();
        loggedIds.clear();
        testsGreen.reset();
      }));
      retentionQueue = clearOp.catch(() => undefined);
      try {
        await clearOp;
      } catch (err) {
        vscode.window.showErrorMessage(`Snagboat: failed to clear event log: ${String(err)}`);
        return;
      }
      runHeuristics();
      refresh();
      vscode.window.showInformationMessage('Snagboat: event log cleared.');
    })
  );

  onCategoriesChanged = () => {
    void vscode.window
      .showInformationMessage('Snagboat: shell categories changed. New shell calls get them; relabel past ones in this workspace too?', 'Relabel')
      .then((choice) => choice === 'Relabel' && vscode.commands.executeCommand('snagboat.relabelShellCalls'));
  };

  const adapters: AgentAdapter[] = [new EditTrackerAdapter(), new ClaudeCodeAdapter({ collect: !core }), new CopilotAdapter(path.join(storage.sharedDir, 'copilot-structure'), { cli: !core })];
  for (const adapter of adapters) {
    const adapterCtx = makeAdapterContext(adapter.agentId, bus, checkpoints, health, captureContentEnabled);
    await adapter.init(adapterCtx);
    await adapter.start();
  }
  context.subscriptions.push({
    dispose: () => {
      for (const adapter of adapters) {
        adapter.stop();
      }
    },
  });
  // Following the core starts once everything that handles its events is in place.
  core?.follow(
    {
      onEvents: (events) => events.forEach(handleEvent),
      onFindings: applyCoreFindings,
      // Useful, Acknowledge or Mute from the advisor UI: this window keeps the finding's episode, so it records them.
      onRespond: (r) => {
        if (r.response === 'useful') findings.markUseful(r.heuristicId);
        else if (r.response === 'acknowledge') findings.acknowledge(r.heuristicId);
        else {
          findings.setMuted(r.heuristicId, true);
          void context.workspaceState.update(MUTED_HEURISTICS_KEY, findings.mutedHeuristics());
        }
      },
      onLost: () => {
        coreFindingsLive = false;
        fromCore = new Set();
        runHeuristics();
        refresh();
      },
    },
    readAt
  );
  // Last, so the claim on the per-user store's folder outlasts the writes made while shutting down.
  context.subscriptions.push({ dispose: () => storage.release?.() });

  // Dev/test-only: emits a synthetic Claude Code turn (35 tokens) through the full
  // bus -> log -> aggregate -> status bar pipeline; the integration suite relies on
  // it. Hidden from the command palette (package.json menus.commandPalette) since it
  // writes a fake event into the user's real log; still callable via executeCommand.
  context.subscriptions.push(
    vscode.commands.registerCommand('snagboat._emitTestEvent', () => {
      bus.publish({
        eventId: crypto.randomUUID(),
        sessionId: 'dev-test-session',
        agent: 'claude-code',
        ts: new Date().toISOString(),
        kind: 'turn_stop',
        status: 'unknown',
        model: 'claude-sonnet-5',
        tokens: { input: 10, output: 20, cacheRead: 5, cacheCreation: 0 },
        raw: { adapter: 'dev-test', ref: 'manual' },
      });
    })
  );

  if (context.extensionMode !== vscode.ExtensionMode.Test) return undefined;
  return {
    getAggregateSnapshot: () => aggregate.snapshot(),
    getTodaySnapshot: () => todayAggregate.snapshot(),
    getEventStore: () => eventStore,
    getFindings: () => findings.list(),
    getContextLimits: () => contextLimits.all(),
    getSessions: () => sessions,
    getVsCodeStorageDir: () => context.storageUri?.fsPath,
    getStorageMode: () => (core ? 'core' : storage.perUser ? 'per-user' : 'vscode'),
  };
}

export function deactivate() {}
