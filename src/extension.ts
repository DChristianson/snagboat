import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { EventBus } from './core/eventBus';
import { EventLog } from './core/eventLog';
import { Aggregate, AggregateSnapshot, TodayAggregate } from './core/aggregate';
import { EventStore, ReadonlyEventStore } from './core/eventStore';
import { CheckpointStore } from './core/checkpointStore';
import { DailyHistory } from './core/dailyHistory';
import { SessionIndex } from './core/sessions';
import { SessionController } from './ui/sessionController';
import { FindingReplay } from './heuristics/replay';
import { runBackfill } from './backfill/command';
import { runRelabel } from './backfill/relabel';
import { buildDigest, digestForReading } from './advisor/digest';
import { sessionDigestInput } from './advisor/source';
import { Advisor } from './advisor/advisor';
import { AuditLog } from './advisor/audit';
import { proposeMessages } from './advisor/propose';
import { hasCapturedText, withoutCapturedText } from './core/excerpt';
import { ContextLimits, ModelContextMarks } from './core/contextLimits';
import { AggregateStore, EventSink, RetentionPolicy, applyRetention, oldestKeptDay } from './core/retention';
import { HealthRegistry } from './core/health';
import { makeAdapterContext } from './core/adapterContext';
import { AgentAdapter, NormalizedEvent, NormalizedEventKind } from './core/types';
import { renderStatusBar } from './ui/statusBar';
import { buildBreakdownLines, formatCount } from './ui/format';
import { buildDetailState, TIMELINE_LIMIT } from './ui/detailModel';
import { DetailPanel } from './ui/detailPanel';
import { EditTrackerAdapter } from './adapters/edit-tracker';
import { ClaudeCodeAdapter } from './adapters/claude-code';
import { removeHooksConfigured } from './adapters/claude-code/hooksConfig';
import { CopilotAdapter } from './adapters/copilot';
import { FindingsRegistry } from './heuristics/findingsRegistry';
import { HeuristicsEngine } from './heuristics/engine';
import { builtInHeuristics, heuristicSettings, heuristicSettingsSection, settingsRuleSource } from './heuristics/index';
import { Finding, Heuristic } from './heuristics/types';
import { buildRuleSet } from './heuristics/rule';
import { ruleHeuristic } from './heuristics/ruleHeuristic';
import { RuleStore } from './heuristics/ruleStore';
import { setShellSubCategories } from './core/toolCategory';
import { runDiscovery } from './discovery/discover';
import { SuggestionsController } from './ui/suggestionsController';
import { exportRules, importRules } from './ui/ruleTransfer';

const POLL_INTERVAL_MS = 30_000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const MUTED_HEURISTICS_KEY = 'snagboat.mutedHeuristics';
// Global: saved rules are shared by every workspace, so a dismissed suggestion stays dismissed everywhere.
const DISMISSED_SUGGESTIONS_KEY = 'snagboat.dismissedSuggestions';

// Generous placeholder sizing, comfortably covering every planned heuristic's
// short window (minutes) without yet reading heuristic settings -- revisited
// once those settings exist and can drive this properly.
const EVENT_STORE_WINDOW_MS = 24 * 60 * 60 * 1000;
const EVENT_STORE_MAX_EVENTS = 5000;

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

export interface SnagboatTestApi {
  getAggregateSnapshot(): AggregateSnapshot;
  getTodaySnapshot(): AggregateSnapshot;
  getEventStore(): ReadonlyEventStore;
  getContextLimits(): Record<string, ModelContextMarks>;
  getSessions(): SessionController;
  getFindings(): Finding[];
}

export async function activate(context: vscode.ExtensionContext): Promise<SnagboatTestApi> {
  const storageUri = context.storageUri ?? context.globalStorageUri;
  await vscode.workspace.fs.createDirectory(storageUri);
  const storageDir = storageUri.fsPath;

  const eventLog = new EventLog(storageDir);
  await eventLog.init();
  const checkpoints = new CheckpointStore(storageDir);
  await checkpoints.init();

  const aggregateStore = new AggregateStore(storageDir);
  await aggregateStore.init();

  // Prune before rehydrating, so nothing past retention is ever loaded.
  try {
    await applyRetention(eventLog, aggregateStore, retentionPolicy(), todayKey());
  } catch (err) {
    console.error('snagboat: retention failed on activation', err);
  }

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
  const contextLimits = new ContextLimits(context.globalStorageUri.fsPath);
  await contextLimits.load();
  // Seed from recent history already in memory (new events update it as they arrive).
  for (const event of eventStore.query()) contextLimits.observe(event);
  context.subscriptions.push({ dispose: () => void contextLimits.dispose() });

  const health = new HealthRegistry();

  const outputChannel = vscode.window.createOutputChannel('Snagboat');
  context.subscriptions.push(outputChannel);

  // Saved rules and shell sub-categories, shared by every workspace, plus any written in settings.
  const ruleStore = new RuleStore(context.globalStorageUri.fsPath);
  let ruleStoreError: string | undefined;
  try {
    await ruleStore.load();
  } catch (err) {
    ruleStoreError = `saved rules couldn't be read and are off until the file is fixed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const findings = new FindingsRegistry(context.workspaceState.get<string[]>(MUTED_HEURISTICS_KEY, []));
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
  const runHeuristics = (kind?: NormalizedEventKind) => {
    const now = new Date().toISOString();
    const results = kind ? engine.tickFor(kind, now) : engine.tick(now);
    for (const [id, list] of results) findings.report(id, list);
  };

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'snagboat.openDetail';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const sessions = new SessionController(sessionIndex, eventLog, () => contextLimits.all(), {
    active: () => findings.list(),
    newReplay: () => new FindingReplay(heuristics, heuristicSettings, contextLimitFor),
    muted: () => findings.mutedHeuristics(),
  });
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
    propose: async (build) => {
      const asked = await advisor.ask('propose', async (p) => proposeMessages(build(p.policy)), { title: 'proposing heuristics' });
      if (!asked) return undefined;
      const warning = Advisor.cutWarning(asked, 'dismiss candidates you don\'t need and ask again, which sends less');
      return { text: asked.completion.text, provider: asked.provider.label, model: asked.provider.model, ...(warning ? { warning } : {}) };
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
  const audit = new AuditLog(context.globalStorageUri.fsPath);
  void audit.prune(retentionPolicy().rawDays, new Date().toISOString()).catch(() => undefined);
  const advisor = new Advisor({ secrets: context.secrets, globalState: context.globalState, audit, output: outputChannel, digestInput });

  const detailPanel = new DetailPanel(context.extensionUri, {
    suggestions,
    explain: (req) => advisor.explain(req),
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
    setMuted: (heuristicId, muted) => {
      findings.setMuted(heuristicId, muted);
      void context.workspaceState.update(MUTED_HEURISTICS_KEY, findings.mutedHeuristics());
    },
  });
  context.subscriptions.push(detailPanel);

  const refresh = () => {
    renderStatusBar(statusBarItem, aggregate.snapshot(), health.list(), todayAggregate.snapshot(), findings.visible(), findings.worst());
    detailPanel.scheduleUpdate();
  };
  refresh();
  health.onChange(refresh);
  findings.onChange(refresh);

  const bus = new EventBus();
  // Retention runs, aggregate merges from the sink, and Clear Event Log all
  // touch the same files, so they share one queue and never interleave.
  let retentionQueue: Promise<void> = Promise.resolve();
  const enqueueStorageOp = (op: () => Promise<void>) => {
    retentionQueue = retentionQueue.then(op).catch((err) => console.error('snagboat: storage operation failed', err));
  };
  // Like enqueueStorageOp, but the caller sees the operation's result or failure.
  const runStorageOp = (op: () => Promise<void>): Promise<void> => {
    const run = retentionQueue.then(op);
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
      aggregate.reset();
      todayAggregate.reset();
      dailyHistory.reset();
      sessionIndex.reset();
      eventStore.reset();
      loggedIds.clear();
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
    contextLimits.observe(event);
    // An event older than all retention isn't stored, so it's left out of the
    // all-time totals and chart too; they'd otherwise drop on the next reload.
    if (sink.write(event)) {
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
  bus.onEvent(handleEvent);

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
    })
  );

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
    vscode.commands.registerCommand('snagboat.previewDigest', async () => {
      const sessionId = await pickSession('Preview the advisor digest of a session (most recent first)');
      if (!sessionId) return;
      const pick = await vscode.window.showQuickPick(
        advisor.providers().map((p) => ({
          label: p.label,
          description: p.kind === 'local' ? 'on this machine' : p.baseUrl,
          detail: `Sends ${[p.policy.prompts && 'prompts', p.policy.replies && 'replies', p.policy.sessionNames && 'session names'].filter(Boolean).join(', ') || 'no text'}; paths ${p.policy.paths}`,
          policy: p.policy,
        })),
        { placeHolder: 'As sent to which provider?' }
      );
      if (!pick) return;
      const input = await digestInput(sessionId);
      if (!input) return;
      const content = `// Snagboat advisor digest, as ${pick.label} would receive it. Indented here for reading; it's sent without indentation.\n${digestForReading(buildDigest(input, pick.policy))}\n`;
      const doc = await vscode.workspace.openTextDocument({ language: 'jsonc', content });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand('snagboat.explainSession', async () => {
      const sessionId = await pickSession('Explain a session (most recent first)');
      if (sessionId) await advisor.explain({ sessionId });
    }),
    vscode.commands.registerCommand('snagboat.setAdvisorKey', () => advisor.setKey())
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
      const clearOp = retentionQueue.then(async () => {
        await aggregateStore.clear();
        await eventLog.clear();
        aggregate.reset();
        todayAggregate.reset();
        dailyHistory.reset();
        sessionIndex.reset();
        sessions.close();
        eventStore.reset();
        loggedIds.clear();
      });
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

  const adapters: AgentAdapter[] = [new EditTrackerAdapter(), new ClaudeCodeAdapter(), new CopilotAdapter(path.join(context.globalStorageUri.fsPath, 'copilot-structure'))];
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

  return {
    getAggregateSnapshot: () => aggregate.snapshot(),
    getTodaySnapshot: () => todayAggregate.snapshot(),
    getEventStore: () => eventStore,
    getFindings: () => findings.list(),
    getContextLimits: () => contextLimits.all(),
    getSessions: () => sessions,
  };
}

export function deactivate() {}
