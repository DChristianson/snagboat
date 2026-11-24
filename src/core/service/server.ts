import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { NormalizedEvent, SessionSummary } from '@snagboat/schema';
import { captureLimitsFrom } from '../excerpt';
import { listUserStores, userDataDir, workspaceInfoOf, workspaceStoreDir } from '../userStore';
import { liveCore, readCoreFile, removeCoreFile, removeCoreRoute, writeCoreFile, writeCoreRoute } from './coreFile';
import { hookEvent, ingestHookSpool, openHookSpool, projectDirHeader } from './hooks';
import { ClaudeCollector, defaultProjectsDir } from './claudeCollector';
import { CopilotCollector } from './copilotCollector';
import { isWithinFolders, withRealPaths } from '../paths';
import { collectedWorkspace, knownWorkspaceFolders } from './workspaces';
import { ContainerCollectors } from './containerCollectors';
import { CheckpointStore } from '../checkpointStore';
import { effectiveSettings, loadConfig } from '../config';
import { isProcessAlive } from '../processes';
import { RETENTION_INTERVAL_MS, StoreWriter } from './storeWriter';
import { EventLog } from '../eventLog';
import { TodayAggregate } from '../aggregate';
import { FindingsService, WorkspaceFindings } from './findings';
import { FindingState, Response } from './responses';
import { SessionListItem, SessionPage, SessionPages } from './sessionPages';
import { NotWaiting, parseSuggestionAction, SuggestionsService } from './suggestions';
import { SuggestionsView } from '../../discovery/suggestionsController';
import { TestsGreen } from '../../outcomes/testsGreen';
import { GIT_OUTCOMES_INTERVAL_MS, GitOutcomesJob } from './gitOutcomesJob';
import { GIT_RECORDS_TICK_MS, GitRecordsJob } from './gitRecordsJob';
import { PLAN_RECORDS_TICK_MS, PlanRecordsJob } from './planRecordsJob';
import { LINKER_DEBOUNCE_MS, LINKER_FULL_PASS_MS, LinkerJob } from './linkerJob';
import { FINDINGS_FILE } from '../findingRecords';
import { plansView, PlansView } from '../plansView';
import { ADVISOR_PERIODS, loadAdvisorGoals } from '../../advisor/goals';
import { MEASURES } from '../../advisor/measures';
import { CoreAdvisors } from './advisorModels';
import { PERIOD_CHECK_MS, PeriodJob } from './periodJob';
import { AdvisorReports, ReviewError } from './advisorReports';
import { AdvisorSetups, SetupError } from './setupChats';
import { AdvisorSetupStore } from '../advisorSetups';
import { DEFAULT_PERSONAS } from '../../advisor/goals';
import { ExperimentStore } from '../experiments';
import { ProposalStore } from '../proposals';
import { advisorTemplates, checkNewAdvisor, CUE_COLORS, CUE_ICONS, writeNewAdvisor } from '../../advisor/newAdvisor';
import { builtInHeuristics } from '../../heuristics';
import { RuleStore } from '../../heuristics/ruleStore';
import { AdvisorReport, advisorReports, buckets, eventsIn, periods } from '../../advisor/report';
import { advisorBrief } from '../../advisor/brief';
import { navigatorAhead } from '../../advisor/ahead';
import { HEURISTICS_INTERVAL_MS } from '../../heuristics/engine';

const STREAM_BATCH = 500;
const STREAM_PING_MS = 15_000;
/** A response to a finding, from any front door (POST /findings/respond). */
export interface FindingResponseMessage {
  workspace: string;
  heuristicId: string;
  response: Response;
}

/** What this core offers beyond 3c-2's endpoints, so a client can tell an older core apart. */
const CORE_FEATURES = ['events-stream', 'flush', 'retention', 'findings', 'plans', 'remove-captured-text'];

/**
 * The core service (docs/design/architecture-rfc.md, step 3; handoff 3c-2):
 * one process per user that reads and writes the per-user store
 * (~/.snagboat/data) for every front door. Listens on 127.0.0.1 only and
 * publishes its port and admin token in ~/.snagboat/core.json.
 *
 * Tokens: the admin token in core.json reads every workspace (the explicit
 * cross-workspace scope, like the CLI's --all) and mints workspace tokens with
 * POST /tokens. A workspace token sees and writes only its workspaces: a VS
 * Code window gets one for its workspace and never sees another's data.
 * Tokens other than the admin token live only as long as the process.
 *
 * Endpoints:
 *   GET  /health               version, pid, start time
 *   POST /tokens               admin: { workspaces: [...] } -> { token }
 *   POST /events               one event or an array; workspace set from the token if missing
 *   GET  /sessions[?days=n&workspace=w]  sessions of the token's workspaces, newest first,
 *                              each with its outcome counts
 *   GET  /sessions/:id         one session, by id or unique id prefix
 *   GET  /sessions/:id/view[?workspace=w]
 *                              the session as the advisor UI draws it: its view (turns, tool
 *                              calls, findings) and its outcomes (RFC step 5b)
 *   GET  /events/stream[?changedSince=<iso>]
 *                              server-sent events: each batch written to the token's
 *                              workspaces, as a JSON array per message; with changedSince,
 *                              first every event in day files changed since then, then a
 *                              "replayed" message (3c-3c: a client window's live feed)
 *   POST /flush                waits for writes in flight, then ingests the spool of
 *                              workspaces no longer claimed (a window holding its folder)
 *   GET  /plans?workspace=w   the workspace's plan items (and its sibling worktrees'), each with its transitions
 *                              and its linked sessions, commits and branches, every link with its confidence
 *                              and evidence (plansView.ts); read-only
 *   GET  /findings[?workspace=w] the token's workspaces' findings and early warnings now (3c-3d);
 *                              a workspace token's stream also carries them ("findings" messages)
 *   GET  /advisors[?workspace=w&days=n&series=1&weeks=n]  each advisor's goal and measures (and, for one
 *                              workspace, its card's brief), this period against
 *                              the one before (RFC step 4c); its latest report's review,
 *                              or for a workspace token only how many proposals wait
 *   GET  /workspaces           the workspaces the token reads, most recently active first
 *   GET  /suggestions?workspace=w  the Suggestions view: discovery's candidates, thresholds, shell categories,
 *                              saved rules (step 5c-2); POST /suggestions { workspace, action, ... } acts on it
 *                              (any token, a reader's included: accepted rules and thresholds are yours)
 *   GET  /today?workspace=w     today's tokens, cache rate and milestones, and how many findings are showing (step 5d)
 *   GET  /advisors/:id/report  an advisor's latest period report (?id= for another) and the list of them;
 *                              POST asks for one now (admin or reader: reports cover every workspace)
 *   POST /advisors/:id/report/answer  ask the advisor's model again for an unanswered report (?id= for an older one)
 *   POST /proposals/:id        { mark: accept | discard | revise, note }: your mark, switchable until sent
 *   GET  /experiments          every experiment (?advisor=a,b&status=running|ended); POST /experiments/:id
 *                              { action: revert | keep | accept }: put back what it replaced, keep going (judged a
 *                              period later), or accept the result
 *   POST /advisors/:id/report/:rev  send that revision back (?id= for an older report): Accept report, or
 *                              Revise report when a proposal is marked revise (the model answers in the background)
 *   GET  /advisor-form         the + form's choices: measures, rules an advisor can speak for, templates (step 5c)
 *   POST /advisors             a new advisor from the form: ~/.snagboat/advisors/<id>/persona.md, never
 *                              overwriting one (any token, a reader's included: advisors are yours)
 *   GET  /advisor-setups       drafts of setup conversations (setting up an advisor by talking it through
 *                              with a model), newest first, and the models you can pick; ?advisor=<id> for the
 *                              conversation that advisor was made from
 *   POST /advisor-setups       { model, text? }: a new setup conversation with that model (required)
 *   GET  /advisor-setups/:id   one, with where the model's answer stands (and a request waiting for your approval)
 *   POST /advisor-setups/:id/messages  { text, model? }: your turn, switching model if you name another; the
 *                              model answers in the background (no text: ask again for your last turn)
 *   POST /advisor-setups/:id/proposal  { action: accept | revise | discard, note?, model? }: accept writes persona.md
 *                              and moves the conversation to the advisor's folder; revise goes on with your note
 *   POST /advisor-setups/:id/approval  { id, send }: your answer to the request waiting for approval
 *   POST /ui-links             admin: [{ workspace, allowHost }] -> a one-time code (2 minutes) and the advisor UI
 *                              address that uses it (http://127.0.0.1:<port>/ui/#<code>)
 *   POST /ui-session           no token: { code } -> a reader token (every workspace, read only), once
 *   GET  /ui/...               the advisor UI's files (RFC step 5a), no token; the page exchanges its code
 *   POST /findings/respond     { workspace, heuristicId, response }: useful, acknowledge, mute or unmute,
 *                              kept by the core (responses.ts) for every front door; the one write a reader
 *                              key may make
 *   POST /retention            applies the token's workspaces' retention now (a window whose
 *                              retention settings changed) -> { changed: <days> }
 *   POST /captured-text/remove  not a reader: removes every commit body (git.jsonl) and plan item
 *                              text (plan.jsonl) in the token's workspaces' folders, for Snagboat:
 *                              Remove Captured Text -> { removed: <lines> }
 *
 * POST /tokens takes { workspaces: [w], folders: [...] } for a saved multi-root workspace
 * (a .code-workspace file): projects in those folders are recorded under w while the token lives.
 * When the core is stopped on purpose (POST /shutdown: snagboat core stop), each open stream
 * gets a "stopping" message, so its client doesn't start another core in its place. Any other
 * exit (a signal, a crash) says nothing, and clients start a new core.
 *   POST /hook                 hook token (core.route): a Claude Code hook payload, with the
 *                              project dir header the hook script sends
 *   POST /shutdown             admin: stop the core
 *
 * It exits after idleMs with no requests and no open event stream (0: never).
 * It runs retention for the workspaces no window has claimed (storeWriter.ts).
 */

export class CoreRunningError extends Error {
  constructor(readonly port: number, readonly pid: number) {
    super(`a Snagboat core is already running (pid ${pid}, port ${port})`);
  }
}

export interface CoreOptions {
  home: string;
  version: string;
  /** 0 or absent: a free port. */
  port?: number;
  /** Exit after this long with no requests; 0 never. Default 30 minutes. */
  idleMs?: number;
  /** How often git outcomes are read (when collecting); default 6 hours, the first a minute after start. */
  gitOutcomesEveryMs?: number;
  /** How often the repository job (git.jsonl) checks which repositories are due; default 5 minutes, the first a minute after start. */
  gitRecordsTickMs?: number;
  /** How often the plan job (plan.jsonl) checks which projects are due; default 5 minutes, the first a minute after start. */
  planRecordsTickMs?: number;
  /** How often advisors' period reports are checked for being due; default hourly, the first a minute after start (0: never). */
  periodEveryMs?: number;
  /** fetch for the core's model requests (tests). */
  fetchImpl?: import('../../advisor/providers').FetchLike;
  /** The clock period reports use (tests). */
  now?: () => Date;
  /** How often followed workspaces' heuristics run with no new events; default 30 seconds. */
  heuristicsEveryMs?: number;
  /** How often to move spooled events of workspaces no longer claimed; default 30 seconds. */
  ingestEveryMs?: number;
  /** Stop a workspace's idle discovery worker after this long; default 15 minutes (SuggestionsService). */
  discoveryWorkerIdleMs?: number;
  /** Read Claude Code transcripts and Copilot CLI sessions for every project (default true; 3c-3b, 3c-3d). */
  collect?: boolean;
  /** Where Claude Code keeps its projects' transcripts; default ~/.claude/projects (SNAGBOAT_CLAUDE_PROJECTS_DIR). */
  claudeProjectsDir?: string;
  /** ~/.copilot/session-state, or SNAGBOAT_COPILOT_SESSIONS_DIR. */
  copilotSessionsDir?: string;
  /** How often to apply retention to the workspaces the core owns; default every 6 hours. */
  retentionEveryMs?: number;
  /** How long after writes or new git and plan records the linker runs (when collecting); default 5 seconds. */
  linkerDebounceMs?: number;
  /** How often the linker reads every workspace's events again and links them all (when collecting); default 6 hours, the first a minute after start. */
  linkerFullPassMs?: number;
  log?: (line: string) => void;
}

/**
 * What a token may do. admin: everything (core.json). A workspace token: read and write its
 * workspaces (a VS Code window). A reader (the browser advisor UI, step 5a): read every
 * workspace, write nothing.
 */
type Scope = { admin: true; reader?: false } | { admin: false; workspaces: string[]; reader?: false } | { admin: false; reader: true; workspaces: string[] };

/** Whether the scope may read this workspace. */
const sees = (scope: Scope, workspace: string) => scope.admin || scope.reader === true || scope.workspaces.includes(workspace);
/** Readers and the admin token name a workspace (or read all); a workspace token reads its own. */
const readsAll = (scope: Scope) => scope.admin || scope.reader === true;

/** How long a one-time UI link's code is good for. */
const UI_LINK_TTL_MS = 2 * 60_000;
/** A browser tab's read-only key ends after this long unused. */
const READER_IDLE_MS = 12 * 60 * 60_000;
/** At most this many browser keys at once; a new one ends the oldest. */
const MAX_READERS = 20;
/** The longest daily series GET /advisors draws. */
const MAX_SERIES_DAYS = 31;
/** The longest weekly series (an advisor's chart). */
const MAX_SERIES_WEEKS = 12;

const MAX_BODY = 16 * 1024 * 1024;
const DEFAULT_IDLE_MS = 30 * 60_000;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function isEvent(e: unknown): e is NormalizedEvent {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  const raw = o.raw as Record<string, unknown> | undefined;
  return (
    ['eventId', 'sessionId', 'agent', 'ts', 'kind', 'status'].every((k) => typeof o[k] === 'string') &&
    !!raw &&
    typeof raw === 'object' &&
    typeof raw.adapter === 'string' &&
    typeof raw.ref === 'string' &&
    (o.workspace === undefined || typeof o.workspace === 'string')
  );
}

function lockFile(home: string): string {
  return path.join(home, 'core.lock');
}

function takeLock(home: string): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile(home), 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = Number(fs.readFileSync(lockFile(home), 'utf8').trim());
      if (Number.isInteger(pid) && pid !== process.pid && isProcessAlive(pid)) throw new CoreRunningError(readCoreFile(home)?.port ?? 0, pid);
      fs.rmSync(lockFile(home), { force: true }); // left by a core that exited without stopping
    }
  }
  throw new Error(`couldn't take ${lockFile(home)}`);
}

function releaseLock(home: string): void {
  try {
    if (Number(fs.readFileSync(lockFile(home), 'utf8').trim()) === process.pid) fs.rmSync(lockFile(home), { force: true });
  } catch {
    // already gone
  }
}

function tokenEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export class CoreService {
  readonly token = crypto.randomBytes(32).toString('hex');
  /** Published in core.route for the hook script; good only for POST /hook. */
  readonly hookToken = crypto.randomBytes(32).toString('hex');
  readonly stopped: Promise<void>;
  private readonly server: http.Server;
  private readonly writer: StoreWriter;
  private readonly findings: FindingsService;
  private readonly sessionPages: SessionPages;
  private readonly suggestions: SuggestionsService;
  private readonly reports: AdvisorReports;
  private readonly experiments: ExperimentStore;
  private readonly setups: AdvisorSetups;
  /** links.jsonl for every workspace (linkerJob.ts); runs on its own only while collecting. */
  private readonly linker: LinkerJob;
  /** Streams that want findings, told of each change. */
  private readonly findingsListeners = new Set<(result: WorkspaceFindings) => void>();
  private readonly workspaceTokens = new Map<string, string[]>();
  /** Reader tokens for browser tabs (POST /ui-session), and the one-time codes that open them. */
  /** Reader tokens and when each was last used: they end after READER_IDLE_MS unused, and the oldest go past MAX_READERS. */
  private readonly readerTokens = new Map<string, number>();
  /** Hosts a front door asked the core to accept besides 127.0.0.1 and localhost: VS Code's forwarded address in a remote window. */
  private readonly extraHosts = new Set<string>();
  private readonly uiCodes = new Map<string, { expires: number; workspace?: string }>();
  private readonly uiDir = findUiDir();
  /** Folder -> the .code-workspace workspace it's part of, per token that registered them. */
  private readonly tokenFolders = new Map<string, Map<string, string>>();
  /** Ends each open event stream with "stopping"; resolves when it has closed. */
  private readonly stoppingStreams = new Set<() => Promise<void>>();
  private collector?: ClaudeCollector;
  private copilot?: CopilotCollector;
  /** Dev container transcripts: <folder>/.snagboat/claude-projects for each folder in config.json's containers.allow (containerCollectors.ts). */
  private containers?: ContainerCollectors;
  private readonly settingsCache = new Map<string, { at: number; values: Record<string, unknown> }>();
  private readonly startedAt = new Date().toISOString();
  private lastActivity = Date.now();
  /** Open GET /events/stream responses: a window that's a client keeps the core up. */
  private streams = 0;
  private timers: NodeJS.Timeout[] = [];
  private resolveStopped!: () => void;
  private stopping = false;
  private boundPort = 0;

  private constructor(private readonly opts: CoreOptions) {
    this.writer = new StoreWriter(opts.home);
    this.findings = new FindingsService({
      home: opts.home,
      onChange: (result) => {
        for (const listener of this.findingsListeners) listener(result);
      },
      // A .code-workspace window registered its folders with its token; its settings are its first folder's.
      settingsDir: (workspace) => {
        for (const folders of this.tokenFolders.values()) for (const [folder, w] of folders) if (w === workspace) return folder;
        return undefined;
      },
      log: (line) => this.log(line),
      record: (workspace, events) => {
        this.writer.write(events.map((e) => ({ ...e, workspace }))).catch((err) => this.log(`couldn't record a finding response: ${err instanceof Error ? err.message : String(err)}`));
      },
      // Each closed episode into the workspace's findings.jsonl, as it was shown (findingRecords.ts).
      store: (workspace, records) => {
        this.writer.appendRecords(path.join(workspaceStoreDir(opts.home, workspace), FINDINGS_FILE), records).catch((err) => this.log(`couldn't record a finding episode: ${err instanceof Error ? err.message : String(err)}`));
      },
      version: opts.version,
    });
    this.linker = new LinkerJob(opts.home, this.writer, { log: (line) => this.log(line), debounceMs: (opts.collect ?? true) ? (opts.linkerDebounceMs ?? LINKER_DEBOUNCE_MS) : 0 });
    this.writer.onWritten((workspace, events) => this.findings.ingest(workspace, events));
    this.sessionPages = new SessionPages(opts.home, this.findings);
    // One set of model advisors, so a request waiting for your approval is the same one wherever it shows.
    const models = new CoreAdvisors(opts.home, opts.fetchImpl, (line) => this.log(line));
    // An applied or reverted change reaches the running heuristics on their next run; run them now.
    this.experiments = new ExperimentStore(opts.home, opts.now, () => this.findings.tick());
    this.reports = new AdvisorReports(
      new PeriodJob(opts.home, opts.now, (line) => this.log(line), () => this.experiments.list()),
      new ProposalStore(opts.home, opts.now),
      models,
      () => this.experiments.list(),
      opts.now,
      (line) => this.log(line),
      async (_advisor, report, accepted) => {
        const started = await this.experiments.start(report, accepted);
        for (const x of started) this.log(`experiment ${x.id} started: ${x.title}`);
      }
    );
    this.suggestions = new SuggestionsService(opts.home, this.findings, (line) => this.log(line), { workerIdleMs: opts.discoveryWorkerIdleMs, advisors: models });
    this.setups = new AdvisorSetups(new AdvisorSetupStore(opts.home, opts.now), models, path.join(opts.home, 'advisors'), () => this.setupCatalog(), opts.now, (line) => this.log(line));
    // Outcomes (RFC step 4): tests going green, worked out from what's written and written back.
    const testsGreen = new TestsGreen();
    this.writer.onWritten((workspace, events) => {
      const outcomes = testsGreen.observe(events);
      if (outcomes.length === 0) return;
      this.writer.write(outcomes.map((o) => ({ ...o, workspace }))).catch((err) => this.log(`couldn't record outcomes: ${err instanceof Error ? err.message : String(err)}`));
    });
    this.stopped = new Promise((resolve) => (this.resolveStopped = resolve));
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  get port(): number {
    return this.boundPort;
  }

  /** Starts a core, unless one is already running for this home (CoreRunningError). A stale core.json is replaced. */
  static async start(opts: CoreOptions): Promise<CoreService> {
    const running = liveCore(opts.home);
    if (running && running.pid !== process.pid) throw new CoreRunningError(running.port, running.pid);
    // One core per home, even when two front doors start one at the same moment: the lock is created exclusively.
    takeLock(opts.home);
    const core = new CoreService(opts);
    try {
      await new Promise<void>((resolve, reject) => {
        core.server.once('error', reject);
        core.server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
      });
    } catch (err) {
      releaseLock(opts.home);
      throw err;
    }
    core.boundPort = (core.server.address() as { port: number }).port;
    writeCoreFile(opts.home, { port: core.boundPort, token: core.token, pid: process.pid, version: opts.version, startedAt: core.startedAt });
    writeCoreRoute(opts.home, core.boundPort, core.hookToken, process.pid);
    // From now on, hooks that find neither a window nor a running core are kept for the next core.
    openHookSpool(opts.home);
    core.log(`snagboat core ${opts.version} listening on 127.0.0.1:${core.boundPort} (pid ${process.pid})`);

    // Hooks spooled while no core ran, then events spooled for workspaces a window had claimed.
    // Each tick also picks up changes to containers.allow (dev containers' transcripts).
    const ingest = async () => {
      try {
        const hooks = await ingestHookSpool(opts.home, async (projectDir, payload, at) => void (await core.deliverHook(projectDir, payload, at)));
        if (hooks > 0) core.log(`read ${hooks} spooled hook(s)`);
        await core.containers?.refresh();
        const events = await core.writer.ingestSpool();
        if (events > 0) core.log(`ingested ${events} spooled event(s)`);
      } catch (err) {
        core.log(`spool ingest failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    // Retention for the workspaces the core owns (no window has them), after the spools are in.
    const retention = async () => {
      try {
        const days = await core.writer.runRetention();
        if (days > 0) core.log(`retention: rolled up or removed text from ${days} day(s)`);
      } catch (err) {
        core.log(`retention failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    void ingest().then(retention);
    // Advisors' period reports (goal tracking lifecycle): catch up on start, then check hourly.
    const periodEveryMs = opts.periodEveryMs ?? PERIOD_CHECK_MS;
    if (periodEveryMs > 0) {
      const runPeriods = () =>
        void core.reports.job
          .runDue()
          .then((written) => written.forEach((r) => core.reports.answerLater(r.advisor, r.id)))
          .catch((err) => core.log(`period reports failed: ${err instanceof Error ? err.message : String(err)}`));
      const firstPeriods = setTimeout(runPeriods, Math.min(60_000, periodEveryMs));
      core.timers.push(firstPeriods as unknown as NodeJS.Timeout);
      core.timers.push(setInterval(runPeriods, periodEveryMs));
    }
    core.timers.push(setInterval(ingest, opts.ingestEveryMs ?? 30_000));
    core.timers.push(setInterval(retention, opts.retentionEveryMs ?? RETENTION_INTERVAL_MS));
    // Heuristics such as "stalled" fire on the absence of events, so followed workspaces are also evaluated on a timer.
    core.timers.push(setInterval(() => core.findings.tick(), opts.heuristicsEveryMs ?? HEURISTICS_INTERVAL_MS));
    if (opts.collect ?? true) {
      const checkpoints = new CheckpointStore(path.join(userDataDir(opts.home), 'core'));
      await checkpoints.init();
      core.collector = new ClaudeCollector({
        projectsDir: opts.claudeProjectsDir ?? defaultProjectsDir(),
        checkpoints,
        workspaceFor: (projectDir) => core.workspaceFor(projectDir),
        captureContent: (projectDir) => core.settingsFor(projectDir).captureContent !== false,
        captureLimits: (projectDir) => captureLimitsFrom(core.settingsFor(projectDir)),
        deliver: (events, projectDir) => {
          // Collecting counts as activity: the core stays up while an agent is working.
          core.lastActivity = Date.now();
          // A window that claimed the workspace to write it reads this very transcript folder itself
          // when the project is its folder: drop. A session started in a subfolder it never reads,
          // or a client window holding the folder for a rewrite (it reads no transcripts): keep.
          return core.writer.write(events, (e, claim) => (!claim.hold && workspaceInfoOf(e.workspace!).folder === projectDir ? 'drop' : 'spool'));
        },
        log: (line) => core.log(line),
      });
      await core.collector.start();
      // Dev containers' transcripts, for the folders allowed in config.json (containerTranscripts.ts).
      core.containers = new ContainerCollectors({
        home: opts.home,
        checkpoints,
        hostProjectsDir: opts.claudeProjectsDir ?? defaultProjectsDir(),
        workspaceFor: (projectDir) => core.workspaceFor(projectDir),
        captureContent: (projectDir) => core.settingsFor(projectDir).captureContent !== false,
        captureLimits: (projectDir) => captureLimitsFrom(core.settingsFor(projectDir)),
        deliver: (events) => {
          // Collected events count as activity, as the host's do: the core stays up while an agent in a container works.
          core.lastActivity = Date.now();
          // No window reads a container's transcripts itself, so nothing is dropped for a claim: spooled for the window.
          return core.writer.write(events);
        },
        log: (line) => core.log(line),
      });
      await core.containers.refresh();
      core.copilot = new CopilotCollector({
        checkpoints,
        sessionsDir: opts.copilotSessionsDir,
        workspaceFor: (cwd) => core.workspaceFor(cwd),
        captureContent: (cwd) => core.settingsFor(cwd).captureContent !== false,
        captureLimits: (cwd) => captureLimitsFrom(core.settingsFor(cwd)),
        deliver: (events, cwd) => {
          core.lastActivity = Date.now();
          // A window of an earlier Snagboat writing its folder itself reads the Copilot sessions started inside it: drop those.
          return core.writer.write(events, (e, claim) => {
            const folder = workspaceInfoOf(e.workspace!).folder;
            return !claim.hold && folder && isWithinFolders(cwd, withRealPaths([folder])) ? 'drop' : 'spool';
          });
        },
        log: (line) => core.log(line),
      });
      await core.copilot.start();
      // Commit outcomes from git (RFC step 4b), for the workspaces it records.
      const gitJob = new GitOutcomesJob(opts.home, core.writer, (line) => core.log(line), undefined, core.linker);
      const runGitJob = () => void gitJob.run().catch((err) => core.log(`git outcomes failed: ${err instanceof Error ? err.message : String(err)}`));
      const first = setTimeout(runGitJob, Math.min(60_000, opts.gitOutcomesEveryMs ?? GIT_OUTCOMES_INTERVAL_MS));
      first.unref();
      core.timers.push(first as unknown as NodeJS.Timeout);
      core.timers.push(setInterval(runGitJob, opts.gitOutcomesEveryMs ?? GIT_OUTCOMES_INTERVAL_MS));
      // Commits, branches and checkouts into each workspace's git.jsonl: every few minutes while a session is active, hourly otherwise.
      const gitRecords = new GitRecordsJob(opts.home, core.writer, (line) => core.log(line));
      // New records: linked a few seconds later (only the repositories with changes).
      const tickGitRecords = () =>
        void gitRecords
          .run()
          .then((n) => n > 0 && core.linker.schedule())
          .catch((err) => core.log(`git records failed: ${err instanceof Error ? err.message : String(err)}`));
      const gitRecordsTickMs = opts.gitRecordsTickMs ?? GIT_RECORDS_TICK_MS;
      const firstRecords = setTimeout(tickGitRecords, Math.min(60_000, gitRecordsTickMs));
      firstRecords.unref();
      core.timers.push(firstRecords as unknown as NodeJS.Timeout);
      core.timers.push(setInterval(tickGitRecords, gitRecordsTickMs));
      // Plan items and their transitions into each workspace's plan.jsonl: from bd, a dev container's beads export, or the project's markdown.
      const planRecords = new PlanRecordsJob(opts.home, core.writer, { log: (line) => core.log(line) });
      const tickPlanRecords = () =>
        void planRecords
          .run()
          .then((n) => n > 0 && core.linker.schedule())
          .catch((err) => core.log(`plan records failed: ${err instanceof Error ? err.message : String(err)}`));
      const planRecordsTickMs = opts.planRecordsTickMs ?? PLAN_RECORDS_TICK_MS;
      const firstPlan = setTimeout(tickPlanRecords, Math.min(60_000, planRecordsTickMs));
      firstPlan.unref();
      core.timers.push(firstPlan as unknown as NodeJS.Timeout);
      core.timers.push(setInterval(tickPlanRecords, planRecordsTickMs));
      // The linker's full pass: every workspace's events read again (what retention removed goes), every repository linked.
      const fullLink = () => void core.linker.run({ full: true }).catch((err) => core.log(`linking failed: ${err instanceof Error ? err.message : String(err)}`));
      const linkerFullPassMs = opts.linkerFullPassMs ?? LINKER_FULL_PASS_MS;
      const firstLink = setTimeout(fullLink, Math.min(60_000, linkerFullPassMs));
      firstLink.unref();
      core.timers.push(firstLink as unknown as NodeJS.Timeout);
      core.timers.push(setInterval(fullLink, linkerFullPassMs));
    }
    const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    if (idleMs > 0) {
      core.timers.push(
        setInterval(() => {
          if (core.streams > 0) core.lastActivity = Date.now();
          if (Date.now() - core.lastActivity >= idleMs) {
            core.log(`idle for ${Math.round(idleMs / 1000)}s; stopping`);
            void core.stop();
          }
        }, Math.min(idleMs, 60_000))
      );
    }
    for (const t of core.timers) t.unref();
    return core;
  }

  /** Stops the core. final: stopped on purpose (snagboat core stop), so clients shouldn't start another. */
  async stop(opts: { final?: boolean } = {}): Promise<void> {
    if (this.stopping) return this.stopped;
    this.stopping = true;
    if (opts.final) {
      // Said and closed before the connections are cut, so each client hears it (and doesn't start another core).
      const said = [...this.stoppingStreams].map((say) => say());
      await Promise.race([Promise.all(said), new Promise((r) => setTimeout(r, 1_000).unref())]);
    }
    for (const t of this.timers) clearInterval(t);
    this.collector?.stop();
    this.containers?.stop();
    this.copilot?.stop();
    this.suggestions.dispose();
    this.linker.dispose();
    await this.findings.dispose().catch(() => undefined);
    removeCoreRoute(this.opts.home, process.pid);
    removeCoreFile(this.opts.home, process.pid);
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    await closed;
    releaseLock(this.opts.home);
    this.resolveStopped();
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  private scopeOf(req: http.IncomingMessage): Scope | undefined {
    const given = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    if (tokenEquals(given, this.token)) return { admin: true };
    for (const [token, workspaces] of this.workspaceTokens) if (tokenEquals(given, token)) return { admin: false, workspaces };
    const now = Date.now();
    for (const [token, used] of this.readerTokens) {
      if (now - used > READER_IDLE_MS) {
        this.readerTokens.delete(token);
        continue;
      }
      if (tokenEquals(given, token)) {
        this.readerTokens.set(token, now);
        return { admin: false, reader: true, workspaces: [] };
      }
    }
    return undefined;
  }

  private async readBody(req: http.IncomingMessage, max = MAX_BODY): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > max) throw new HttpError(413, 'request body too large');
      chunks.push(chunk as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'body is not JSON');
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.lastActivity = Date.now();
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    };
    try {
      // Only this machine's names for the core: a page elsewhere that renamed itself to 127.0.0.1 (DNS rebinding) is refused.
      if (!this.hostAllowed(req.headers.host)) {
        req.resume();
        return send(421, { error: 'requests must be addressed to 127.0.0.1 or localhost' });
      }
      if (req.method === 'POST' && req.url === '/hook') return send(200, await this.hook(req));
      // The advisor UI's files, and the exchange of a one-time code for a reader token: no token yet.
      if (req.method === 'GET' && (req.url === '/ui' || req.url?.startsWith('/ui/'))) return this.serveUi(req, res);
      if (req.method === 'POST' && req.url === '/ui-session') return send(200, this.uiSession(await this.readBody(req, 4096)));
      const scope = this.scopeOf(req);
      if (!scope) {
        req.resume();
        return send(401, { error: 'missing or unknown token' });
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /health') return send(200, { ok: true, version: this.opts.version, pid: process.pid, startedAt: this.startedAt, features: CORE_FEATURES });
      if (route === 'POST /retention') {
        req.resume();
        if (scope.reader) throw new HttpError(403, 'this token reads; it can\'t run retention');
        return send(200, { changed: await this.writer.runRetention((w) => sees(scope, w)) });
      }
      if (route === 'POST /captured-text/remove') {
        req.resume();
        if (scope.reader) throw new HttpError(403, 'this token reads; it can\'t remove captured text');
        return send(200, { removed: await this.writer.removeCapturedText((w) => sees(scope, w)) });
      }
      if (route === 'POST /tokens') return send(200, this.mintToken(scope, await this.readBody(req)));
      if (route === 'GET /events/stream') return this.stream(scope, url.searchParams.get('changedSince'), req, res);
      if (route === 'POST /flush') {
        req.resume();
        if (scope.reader) throw new HttpError(403, 'this token reads; it can\'t flush');
        return send(200, { ingested: await this.writer.flush() });
      }
      if (route === 'POST /events') return send(200, await this.postEvents(scope, await this.readBody(req)));
      if (route === 'GET /workspaces') return send(200, this.workspaces(scope));
      if (route === 'POST /ui-links') return send(200, this.uiLink(scope, await this.readBody(req).catch(() => ({}))));
      if (route === 'GET /advisors') return send(200, await this.advisors(scope, url.searchParams.get('workspace'), url.searchParams.get('days'), url.searchParams.get('series') === '1', url.searchParams.get('weeks')));
      if (route === 'GET /suggestions') return send(200, await this.suggestionsView(scope, url.searchParams.get('workspace')));
      if (route === 'POST /suggestions') return send(200, await this.suggestionsAct(scope, await this.readBody(req, 4096)));
      if (route === 'GET /today') return send(200, await this.today(scope, url.searchParams.get('workspace')));
      if (route === 'GET /experiments') return send(200, this.listExperiments(scope, url.searchParams));
      if (req.method === 'POST' && url.pathname.startsWith('/experiments/')) return send(200, await this.actOnExperiment(scope, decodeURIComponent(url.pathname.slice('/experiments/'.length)), await this.readBody(req, 4096)));
      const answerMatch = req.method === 'POST' ? /^\/advisors\/([^/]+)\/report\/answer$/.exec(url.pathname) : null;
      if (answerMatch) return send(202, this.askAgain(scope, decodeURIComponent(answerMatch[1]), url.searchParams.get('id')));
      const sendMatch = req.method === 'POST' ? /^\/advisors\/([^/]+)\/report\/(\d+)$/.exec(url.pathname) : null;
      if (sendMatch) return send(200, await this.sendReport(scope, decodeURIComponent(sendMatch[1]), url.searchParams.get('id'), Number(sendMatch[2])));
      if (req.method === 'POST' && url.pathname.startsWith('/proposals/')) return send(200, await this.markProposal(scope, decodeURIComponent(url.pathname.slice('/proposals/'.length)), await this.readBody(req, 8192)));
      if (url.pathname.startsWith('/advisors/') && url.pathname.endsWith('/report')) {
        const id = decodeURIComponent(url.pathname.slice('/advisors/'.length, -'/report'.length));
        if (req.method === 'GET') return send(200, this.periodReport(scope, id, url.searchParams.get('id')));
        if (req.method === 'POST') return send(201, await this.requestReport(scope, id));
      }
      if (route === 'GET /advisor-form') return send(200, await this.advisorForm());
      if (route === 'POST /advisors') return send(201, await this.addAdvisor(await this.readBody(req, 8192)));
      if (url.pathname === '/advisor-setups' || url.pathname.startsWith('/advisor-setups/')) return send(...(await this.advisorSetup(scope, req, url)));
      if (route === 'POST /findings/respond') return send(200, await this.respond(scope, await this.readBody(req, 4096)));
      if (route === 'GET /plans') return send(200, await this.plans(scope, url.searchParams.get('workspace')));
      if (route === 'GET /findings') return send(200, await this.currentFindings(scope, url.searchParams.get('workspace')));
      if (route === 'GET /sessions') return send(200, await this.sessions(scope, url.searchParams.get('days'), url.searchParams.get('workspace')));
      if (req.method === 'GET' && url.pathname.startsWith('/sessions/') && url.pathname.endsWith('/view')) {
        return send(200, await this.sessionPage(scope, decodeURIComponent(url.pathname.slice('/sessions/'.length, -'/view'.length)), url.searchParams.get('workspace')));
      }
      if (req.method === 'GET' && url.pathname.startsWith('/sessions/')) return send(200, await this.session(scope, decodeURIComponent(url.pathname.slice('/sessions/'.length))));
      if (route === 'POST /shutdown') {
        if (!scope.admin) throw new HttpError(403, 'only the admin token can stop the core');
        send(200, { stopping: true });
        setImmediate(() => void this.stop({ final: true }));
        return;
      }
      req.resume();
      send(404, { error: `no such endpoint: ${route}` });
    } catch (err) {
      req.resume();
      if (err instanceof HttpError) return send(err.status, { error: err.message });
      this.log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      send(500, { error: 'internal error' });
    }
  }

  /** A project folder's settings (config.json, .snagboat.json), cached for a few seconds: collectors ask per chunk. */
  settingsFor(dir: string): Record<string, unknown> {
    const hit = this.settingsCache.get(dir);
    if (hit && Date.now() - hit.at < 5_000) return hit.values;
    const values = effectiveSettings(this.opts.home, dir).values;
    this.settingsCache.set(dir, { at: Date.now(), values });
    return values;
  }

  /** The workspace a project's activity is recorded under, or undefined when it's not recorded (workspaces.ts). */
  workspaceFor(projectDir: string): string | undefined {
    const aliases = new Map<string, string>();
    for (const folders of this.tokenFolders.values()) for (const [folder, workspace] of folders) aliases.set(folder, workspace);
    return collectedWorkspace(this.opts.home, projectDir, knownWorkspaceFolders(this.opts.home, [...this.workspaceTokens.values()].flat()), aliases);
  }

  private async hook(req: http.IncomingMessage) {
    const given = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    if (!tokenEquals(given, this.hookToken) && !tokenEquals(given, this.token)) throw new HttpError(401, 'missing or unknown token');
    const projectDir = projectDirHeader(req.headers['x-snagboat-project-dir'], req.headers['x-snagboat-project-dir-hex']);
    if (!projectDir) throw new HttpError(400, 'missing X-Snagboat-Project-Dir');
    return this.deliverHook(projectDir, await this.readBody(req), new Date().toISOString());
  }

  /**
   * Records a hook for the workspace containing its project. Answers 200 even
   * when it records nothing (no known workspace, or a payload that isn't a hook
   * Snagboat records), so the script doesn't spool what would be dropped anyway.
   */
  async deliverHook(projectDir: string, payload: unknown, receivedAt: string) {
    const workspace = this.workspaceFor(projectDir);
    if (!workspace) return { recorded: false, reason: "the project's settings say not to record it" };
    const event = hookEvent(payload, receivedAt, this.settingsFor(projectDir).captureContent !== false);
    if (!event) return { recorded: false, reason: 'not a hook Snagboat records' };
    return { recorded: true, ...(await this.writer.write([{ ...event, workspace }])) };
  }

  private mintToken(scope: Scope, body: unknown): { token: string; workspaces: string[] } {
    if (!scope.admin) throw new HttpError(403, 'only the admin token can mint tokens');
    const workspaces = (body as { workspaces?: unknown })?.workspaces;
    if (!Array.isArray(workspaces) || workspaces.length === 0 || !workspaces.every((w) => typeof w === 'string' && w.length > 0)) {
      throw new HttpError(400, 'body must be { "workspaces": ["<workspace>", ...] }');
    }
    const folders = (body as { folders?: unknown })?.folders;
    if (folders !== undefined && (!Array.isArray(folders) || workspaces.length !== 1 || !folders.every((f) => typeof f === 'string' && path.isAbsolute(f)))) {
      throw new HttpError(400, 'folders must be absolute paths, for exactly one workspace');
    }
    const token = crypto.randomBytes(32).toString('hex');
    this.workspaceTokens.set(token, [...new Set(workspaces as string[])]);
    if (folders && folders.length > 0) this.tokenFolders.set(token, new Map((folders as string[]).map((f) => [f, workspaces[0] as string])));
    return { token, workspaces: this.workspaceTokens.get(token)! };
  }

  private async postEvents(scope: Scope, body: unknown) {
    const list = Array.isArray(body) ? body : [body];
    const events: NormalizedEvent[] = [];
    for (const [i, e] of list.entries()) {
      if (!isEvent(e)) throw new HttpError(400, `event ${i} is not a NormalizedEvent`);
      let workspace = e.workspace;
      if (scope.reader) throw new HttpError(403, 'this token reads; it can\'t write events');
      if (workspace === undefined) {
        if (scope.admin || scope.workspaces.length !== 1) throw new HttpError(400, `event ${i} needs a workspace`);
        workspace = scope.workspaces[0];
      } else if (!scope.admin && !scope.workspaces.includes(workspace)) {
        throw new HttpError(403, `event ${i} is for a workspace this token can't write`);
      }
      events.push({ ...e, workspace });
    }
    return this.writer.write(events);
  }

  /** GET /events/stream: a server-sent event per batch written to the scope's workspaces. */
  private stream(scope: Scope, changedSince: string | null, req: http.IncomingMessage, res: http.ServerResponse): void {
    const since = changedSince === null ? undefined : Date.parse(changedSince);
    if (since !== undefined && !Number.isFinite(since)) throw new HttpError(400, 'changedSince must be an ISO date');
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    const visible = (workspace: string) => sees(scope, workspace);
    const send = (events: NormalizedEvent[]) => {
      for (let i = 0; i < events.length; i += STREAM_BATCH) res.write(`data: ${JSON.stringify(events.slice(i, i + STREAM_BATCH))}\n\n`);
    };
    // Registered before the replay, so nothing written meanwhile falls between the two (the client drops repeats by eventId).
    const stop = this.writer.onWritten((workspace, events) => visible(workspace) && send(events));
    const ping = setInterval(() => res.write(': ping\n\n'), STREAM_PING_MS);
    ping.unref();
    this.streams += 1;
    const sayStopping = () => new Promise<void>((resolve) => {
      res.once('close', () => resolve());
      res.end('event: stopping\ndata: {}\n\n');
    });
    this.stoppingStreams.add(sayStopping);
    // A workspace token's stream also carries its workspaces' findings: each change, and the current ones to start.
    const stopFindings = readsAll(scope)
      ? undefined
      : this.followFindings(scope.workspaces, (result) => {
          if (!res.destroyed && visible(result.workspace)) res.write(`event: findings\ndata: ${JSON.stringify(result)}\n\n`);
        });
    res.on('close', () => {
      this.stoppingStreams.delete(sayStopping);
      stopFindings?.();
      stop();
      clearInterval(ping);
      this.streams -= 1;
      this.lastActivity = Date.now();
    });
    if (since === undefined) return;
    void (async () => {
      for (const store of this.visibleStores(scope)) {
        const log = new EventLog(store.dir);
        for (const day of await log.listDays()) {
          let mtime: number;
          try {
            mtime = fs.statSync(path.join(log.dir, `${day}.jsonl`)).mtimeMs;
          } catch {
            continue;
          }
          if (mtime >= since && !res.destroyed) send((await log.readDay(day)).map((e) => ({ ...e, workspace: store.workspace })));
        }
      }
      if (!res.destroyed) res.write('event: replayed\ndata: {}\n\n');
    })().catch((err) => this.log(`replay failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Follows the workspaces' findings for a stream; sends each one's current findings once it's followed. */
  private followFindings(workspaces: string[], send: (result: WorkspaceFindings) => void): () => void {
    this.findingsListeners.add(send);
    const unfollow: Array<() => void> = [];
    let stopped = false;
    for (const workspace of workspaces) {
      void this.findings
        .follow(workspace)
        .then(async (stop) => {
          if (stopped) return stop();
          unfollow.push(stop);
          const latest = await this.findings.latest(workspace);
          if (latest && !stopped) send(latest);
        })
        .catch((err) => this.log(`couldn't follow findings for ${workspace}: ${err instanceof Error ? err.message : String(err)}`));
    }
    return () => {
      stopped = true;
      this.findingsListeners.delete(send);
      for (const stop of unfollow) stop();
    };
  }

  /**
   * GET /advisors: each advisor's goal and measures over the token's workspaces (or the one named), the last
   * `days` (default 7) against the days before (RFC step 4c). The admin token names a workspace, or reads all.
   */
  private async advisors(scope: Scope, workspace: string | null, daysParam: string | null, series = false, weeksParam: string | null = null): Promise<{ days: number; workspaces: string[]; advisors: AdvisorReport[]; problems: string[] }> {
    const weeks = weeksParam === null ? undefined : Number(weeksParam);
    if (weeks !== undefined && (!Number.isInteger(weeks) || weeks < 2 || weeks > MAX_SERIES_WEEKS)) throw new HttpError(400, `weeks must be a whole number from 2 to ${MAX_SERIES_WEEKS}`);
    const days = daysParam === null ? 7 : Number(daysParam);
    if (!Number.isInteger(days) || days <= 0 || days > 366) throw new HttpError(400, 'days must be a whole number from 1 to 366');
    if (workspace !== null && !sees(scope, workspace)) throw new HttpError(400, `this token can't read ${workspace}`);
    const stores = this.visibleStores(scope).filter((s) => workspace === null || s.workspace === workspace);
    const { advisors, problems } = loadAdvisorGoals(path.join(this.opts.home, 'advisors'));
    const { current, previous } = periods(new Date(), days);
    const logs = stores.map((s) => new EventLog(s.dir));
    const now = new Date();
    const currentEvents = await eventsIn(logs, current);
    // A series per measure: by week for an advisor's chart (?weeks=), else by day for the cards' sparklines (?series=1).
    let seriesWindows;
    if (weeks !== undefined) seriesWindows = buckets(await eventsIn(logs, { from: new Date(now.getTime() - weeks * 7 * 86_400_000).toISOString(), to: new Date(now.getTime() + 1).toISOString() }), now, weeks, 7);
    else if (series && days <= MAX_SERIES_DAYS) seriesWindows = buckets(currentEvents, now, days, 1);
    const reports = advisorReports(advisors, currentEvents, await eventsIn(logs, previous), { now, ...(seriesWindows ? { series: seriesWindows } : {}) });
    // One workspace: each card's brief, from its live findings, recent notifications and (Navigator) the work ahead.
    if (workspace !== null && stores.length === 1) {
      const findingsNow = await this.findings.current(workspace);
      const live = findingsNow.findings;
      const notified = new Set(currentEvents.filter((e) => e.kind === 'outcome' && e.outcome?.type === 'notified' && Date.parse(e.ts) > now.getTime() - 2 * 3_600_000).map((e) => e.outcome!.heuristicId!));
      // Beads first, the agent's plan (its todo list) as fallback.
      const ahead = reports.some((r) => r.id === 'navigator') ? await navigatorAhead(stores[0].folder, currentEvents, now.getTime()) : undefined;
      for (const r of reports) r.brief = advisorBrief(r, live, notified, r.id === 'navigator' ? ahead : undefined, findingsNow.responses);
    }
    // Each advisor's latest period report: the review for tokens that read every workspace (reports cover them
    // all), only how many proposals wait for a workspace token (VS Code's findings view and status bar).
    for (const r of reports) {
      const v = this.reports.view(r.id);
      if (!v) continue;
      if (!readsAll(scope)) {
        if (v.review.unmarked) r.review = { unmarked: v.review.unmarked };
        continue;
      }
      r.review = { report: v.report.id, label: v.report.label, rev: v.review.rev, state: v.review.state, unmarked: v.review.unmarked, proposals: v.proposals.length };
      // Proposals waiting take "To surface" when there's no live finding to show.
      if (v.review.unmarked && r.brief && (r.brief.surface.kind === 'suggest' || r.brief.surface.kind === 'none')) {
        r.brief.surface = { kind: 'suggest', label: 'Proposals', text: `${v.review.unmarked} proposal${v.review.unmarked === 1 ? '' : 's'} waiting in the ${v.report.label} report.` };
      }
    }
    return { days, workspaces: stores.map((s) => s.workspace), advisors: reports, problems };
  }

  /** GET /suggestions?workspace=w: the Suggestions view (step 5c-2); discovery starts on the first ask. */
  private async suggestionsView(scope: Scope, workspace: string | null): Promise<SuggestionsView> {
    if (workspace === null) throw new HttpError(400, 'name the workspace: ?workspace=<workspace>');
    this.store(scope, workspace);
    return this.suggestions.view(workspace);
  }

  /**
   * POST /suggestions { workspace, action, ... }: Discover again, tweak a candidate's threshold, accept or
   * dismiss one, apply a threshold, remove a saved rule. Accepting rules and thresholds is one of the writes
   * a reader (browser) key may make, as the design pass agreed: they're yours, kept as VS Code keeps them.
   */
  private async suggestionsAct(scope: Scope, body: unknown): Promise<SuggestionsView> {
    const workspace = (body as { workspace?: unknown } | undefined)?.workspace;
    if (typeof workspace !== 'string') throw new HttpError(400, 'name the workspace');
    this.store(scope, workspace);
    const action = parseSuggestionAction(body);
    if (!action) throw new HttpError(400, 'no such action, or its fields are missing');
    try {
      return await this.suggestions.act(workspace, action);
    } catch (err) {
      if (err instanceof NotWaiting) throw new HttpError(409, err.message);
      throw err;
    }
  }

  /**
   * GET /today?workspace=w: today's tokens, cache rate and milestones in a workspace, and its findings now
   * (RFC step 5d: the Claude Code status line, which runs often, so this reads only today's day files).
   */
  private async today(scope: Scope, workspace: string | null): Promise<{ tokens: number; cacheRate?: number; milestones: number; findings: number; warnings: number }> {
    if (workspace === null) throw new HttpError(400, 'name the workspace: ?workspace=<workspace>');
    const store = this.store(scope, workspace);
    const today = new TodayAggregate();
    await today.rehydrateFrom(new EventLog(store.dir));
    const snap = today.snapshot();
    let cacheRead = 0;
    let input = 0;
    for (const a of Object.values(snap.perAgent)) {
      cacheRead += a.tokens.cacheRead;
      input += a.tokens.input + a.tokens.cacheRead + a.tokens.cacheCreation;
    }
    const now = await this.findings.current(workspace);
    const shown = now.findings.filter((f) => !now.muted.includes(f.heuristicId) && !now.responses[f.heuristicId]?.acknowledged);
    const heuristics = new Set(shown.map((f) => f.heuristicId));
    const warnings = new Set(shown.filter((f) => f.severity === 'warn').map((f) => f.heuristicId));
    return { tokens: snap.totalTokens, ...(input > 0 ? { cacheRate: (100 * cacheRead) / input } : {}), milestones: today.milestones(), findings: heuristics.size, warnings: warnings.size };
  }

  /** Built-in heuristics, saved rules (rules.json) and the user's settings rules: what a new advisor can speak for. */
  private async knownRules(): Promise<Array<{ id: string; title?: string }>> {
    const out = new Map<string, string | undefined>();
    for (const h of builtInHeuristics()) out.set(h.id, undefined);
    const store = new RuleStore(this.opts.home);
    await store.load().catch(() => undefined);
    const defaults = loadConfig(this.opts.home).config.defaults.rules;
    for (const doc of [...store.source().rules, ...(Array.isArray(defaults) ? defaults : [])]) {
      const d = doc as { id?: unknown; title?: unknown };
      if (typeof d.id === 'string') out.set(d.id, typeof d.title === 'string' ? d.title : undefined);
    }
    return [...out].map(([id, title]) => ({ id, ...(title ? { title } : {}) }));
  }

  /**
   * GET /advisors/:id/report[?id=<report id>]: an advisor's latest period report (or that one), and the list of
   * its reports. Reports cover every workspace, so only tokens that read every workspace (admin, reader) see them.
   */
  private periodReport(scope: Scope, advisor: string, reportId: string | null) {
    if (!readsAll(scope)) throw new HttpError(403, "period reports cover every workspace; this token reads only its own");
    if (!/^[a-z][a-z0-9-]*$/.test(advisor)) throw new HttpError(400, 'no such advisor');
    const view = this.reports.view(advisor, reportId ?? undefined);
    if (!view) throw new HttpError(404, reportId === null ? `${advisor} has no report yet` : `${advisor} has no report ${reportId}`);
    const all = this.reports.job.list(advisor);
    return { ...view, reports: all.map((r) => ({ id: r.id, label: r.label, from: r.from, to: r.to, trigger: r.trigger })) };
  }

  /** GET /experiments[?advisor=a,b][&status=running|ended]: every experiment, newest first. */
  private listExperiments(scope: Scope, q: URLSearchParams) {
    if (!readsAll(scope)) throw new HttpError(403, 'experiments are yours across every workspace; this token reads only its own');
    const advisors = (q.get('advisor') ?? '').split(',').filter(Boolean);
    const status = q.get('status');
    if (status !== null && status !== 'running' && status !== 'ended') throw new HttpError(400, 'status is running or ended');
    const experiments = this.experiments.list().filter((x) => (!advisors.length || advisors.includes(x.advisor)) && (status === null || x.status === status));
    // Each one's tracked measure now: from its advisor's latest report, in its scope.
    const now: Record<string, { report: string; value?: number; label?: string; unit?: string; better?: 'lower' | 'higher' }> = {};
    for (const x of experiments) {
      const r = this.reports.job.get(x.advisor);
      if (!r) continue;
      const measures = x.scope === 'global' ? r.measures : r.workspaces.find((w) => w.workspace === (x.scope as { workspace: string }).workspace)?.measures ?? [];
      const m = measures.find((y) => y.id === x.baseline.measure) ?? r.measures.find((y) => y.id === x.baseline.measure);
      const value = measures.find((y) => y.id === x.baseline.measure)?.value;
      now[x.id] = { report: r.id, ...(value !== undefined ? { value } : {}), ...(m ? { label: m.label, unit: m.unit, better: m.better } : {}) };
    }
    return { experiments, now };
  }

  /**
   * POST /experiments/:id { action }: revert (put back what the change replaced, and end it), keep (keep going:
   * judged again a period later), or accept (the result: the change stays, and it ends).
   */
  private async actOnExperiment(scope: Scope, id: string, body: unknown) {
    if (!readsAll(scope)) throw new HttpError(403, 'experiments are yours across every workspace; this token reads only its own');
    const action = (body as { action?: unknown } | undefined)?.action;
    if (action !== 'revert' && action !== 'keep' && action !== 'accept') throw new HttpError(400, 'action is revert, keep or accept');
    const x = this.experiments.get(id);
    if (!x) throw new HttpError(404, `no experiment ${id}`);
    try {
      if (action === 'revert') return { experiment: await this.experiments.revert(id) };
      if (action === 'accept') return { experiment: this.experiments.accept(id) };
      const period = this.reports.job.advisors().find((a) => a.id === x.advisor)?.period ?? 'weekly';
      const kept = this.experiments.keep(id, period);
      if (this.reports.proposals.get(x.advisor, x.proposal)) this.reports.proposals.mark(x.advisor, x.proposal, 'kept');
      return { experiment: kept };
    } catch (err) {
      throw new HttpError(409, err instanceof Error ? err.message : String(err));
    }
  }

  /** POST /advisors/:id/report/answer[?id=]: asks the advisor's model again for a report it hasn't answered (it failed, or you didn't send it). */
  private askAgain(scope: Scope, advisor: string, reportId: string | null) {
    if (!readsAll(scope)) throw new HttpError(403, 'period reports cover every workspace; this token reads only its own');
    const view = this.reports.view(advisor, reportId ?? undefined);
    if (!view) throw new HttpError(404, `${advisor} has no report ${reportId ?? 'yet'}`);
    if (view.report.revisions?.length) throw new HttpError(409, 'its model has answered this report already');
    if (!this.reports.job.advisors().find((a) => a.id === advisor)?.model) throw new HttpError(409, `${advisor} has no model: set "model" in its persona.md`);
    this.reports.answerLater(advisor, view.report.id);
    return { asking: true };
  }

  /** POST /proposals/:id { mark: accept | discard | revise, note }: your mark on a proposal, switchable until its revision is sent. */
  private markProposal(scope: Scope, id: string, body: unknown) {
    if (!readsAll(scope)) throw new HttpError(403, 'proposals are yours across every workspace; this token reads only its own');
    const b = (body ?? {}) as { mark?: unknown; note?: unknown };
    if (b.mark !== 'accept' && b.mark !== 'discard' && b.mark !== 'revise') throw new HttpError(400, 'mark is accept, discard or revise');
    try {
      return { proposal: this.reports.mark(id, b.mark, typeof b.note === 'string' ? b.note : undefined) };
    } catch (err) {
      if (err instanceof ReviewError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  /** POST /advisors/:id/report/:rev[?id=<report id>]: Accept report, or Revise report when a proposal is marked revise. */
  private async sendReport(scope: Scope, advisor: string, reportId: string | null, rev: number) {
    if (!readsAll(scope)) throw new HttpError(403, 'period reports cover every workspace; this token reads only its own');
    try {
      const { as, view } = await this.reports.send(advisor, reportId ?? undefined, rev);
      return { sent: as, ...view };
    } catch (err) {
      if (err instanceof ReviewError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  /** POST /advisors/:id/report: a report now, from the advisor's last one to now (admin or reader: advisors are yours). */
  private async requestReport(scope: Scope, advisor: string) {
    if (!readsAll(scope)) throw new HttpError(403, "period reports cover every workspace; this token reads only its own");
    try {
      // Periods that closed first are written and answered as the timer would.
      for (const r of await this.reports.job.runDue()) this.reports.answerLater(r.advisor, r.id);
      const report = await this.reports.job.request(advisor);
      // The model answers in the background (it may wait for your approval); GET shows its revision once it has.
      this.reports.answerLater(advisor, report.id);
      return { report };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpError(/^no advisor/.test(message) ? 404 : 500, message);
    }
  }

  /** The local model advisors in your user settings, which a goal advisor's `model` may name. */
  private modelAdvisors() {
    return new CoreAdvisors(this.opts.home, undefined, this.log).advisors();
  }

  /** GET /advisor-form: what the + form offers: measures, the rules an advisor can speak for, the built-ins as templates. */
  private async advisorForm() {
    const { advisors } = loadAdvisorGoals(path.join(this.opts.home, 'advisors'), () => undefined);
    return {
      measures: Object.entries(MEASURES).map(([id, m]) => ({ id, label: m.label, unit: m.unit, ...(m.notYet ? { notYet: m.notYet } : {}) })),
      rules: await this.knownRules(),
      templates: advisorTemplates(advisors),
      periods: ADVISOR_PERIODS,
      models: this.modelAdvisors().map((a) => ({ id: a.id, label: a.label, ...(a.model ? { model: a.model } : {}) })),
      colors: CUE_COLORS,
      icons: CUE_ICONS,
    };
  }

  /** What a setup conversation's model may choose from: the + form's measures and rules, and the advisor names taken. */
  private async setupCatalog() {
    const { advisors } = loadAdvisorGoals(path.join(this.opts.home, 'advisors'), () => undefined);
    let folders: string[] = [];
    try {
      folders = fs.readdirSync(path.join(this.opts.home, 'advisors'));
    } catch {
      // no advisors of yours yet
    }
    return {
      measures: Object.entries(MEASURES).map(([id, m]) => ({ id, label: m.label, unit: m.unit })),
      rules: await this.knownRules(),
      taken: [...new Set([...Object.keys(DEFAULT_PERSONAS), ...advisors.map((a) => a.id), ...folders])].sort(),
    };
  }

  /**
   * The /advisor-setups routes (setupChats.ts): setting up an advisor by conversation. Advisors are yours
   * across every workspace, so only tokens that read every workspace (admin, the advisor UI's) use them.
   */
  private async advisorSetup(scope: Scope, req: http.IncomingMessage, url: URL): Promise<[number, unknown]> {
    if (!readsAll(scope)) {
      req.resume();
      throw new HttpError(403, 'advisors are yours across every workspace; this token reads only its own');
    }
    const [, , rawId, action, extra] = url.pathname.split('/');
    const id = rawId === undefined ? undefined : decodeURIComponent(rawId);
    try {
      if (id === undefined || id === '') {
        if (req.method === 'GET') {
          const advisor = url.searchParams.get('advisor');
          if (advisor !== null) {
            const setup = this.setups.store.forAdvisor(advisor);
            if (!setup) throw new HttpError(404, `${advisor} was not set up by a conversation`);
            return [200, { setup }];
          }
          return [200, { drafts: this.setups.store.drafts(), models: this.setups.choices() }];
        }
        if (req.method === 'POST') return [201, await this.setups.start((await this.readBody(req, 8192)) as object)];
      } else if (extra === undefined && AdvisorSetupStore.isId(id)) {
        if (req.method === 'GET' && action === undefined) {
          const view = this.setups.view(id);
          if (!view) throw new HttpError(404, `no setup conversation ${id}`);
          return [200, view];
        }
        if (req.method === 'POST' && action === 'messages') return [202, await this.setups.say(id, (await this.readBody(req, 16384)) as object)];
        if (req.method === 'POST' && action === 'proposal') {
          const body = (await this.readBody(req, 8192)) as { action?: unknown };
          const view = await this.setups.decide(id, body);
          return [body.action === 'revise' ? 202 : view.advisor ? 201 : 200, view];
        }
        if (req.method === 'POST' && action === 'approval') {
          const b = (await this.readBody(req, 4096)) as { id?: unknown; send?: unknown };
          if (typeof b?.id !== 'string' || typeof b.send !== 'boolean') throw new HttpError(400, 'send { id, send: true | false }');
          if (!this.setups.view(id)) throw new HttpError(404, `no setup conversation ${id}`);
          if (!this.setups.approve(b.id, b.send)) throw new HttpError(409, 'no request is waiting for that approval');
          return [200, this.setups.view(id)];
        }
      }
      req.resume();
      throw new HttpError(404, `no such endpoint: ${req.method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof SetupError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  /**
   * POST /advisors: a new advisor from the + form (RFC step 5c), written as
   * ~/.snagboat/advisors/<id>/persona.md. Only ever a new folder; a reader (browser) key may make it,
   * as advisors are yours, not a workspace's.
   */
  private async addAdvisor(body: unknown): Promise<{ advisor: { id: string; name: string } }> {
    const { spec, problems } = checkNewAdvisor(body, (await this.knownRules()).map((r) => r.id), this.modelAdvisors().map((a) => a.id));
    if (!spec) throw new HttpError(400, problems.join(' '));
    try {
      const a = writeNewAdvisor(path.join(this.opts.home, 'advisors'), spec);
      this.log(`added advisor ${a.id}`);
      return { advisor: { id: a.id, name: a.name } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpError(/already exists|built-in/.test(message) ? 409 : 500, message);
    }
  }

  /**
   * POST /findings/respond { workspace, heuristicId, response }: Useful, Acknowledge, Mute or Unmute, from
   * any front door (the advisor UI, a VS Code window that's a client, the Claude Code plugin). The core keeps
   * it (responses.ts), and every stream on the workspace gets its findings again with it. The one write a
   * reader (browser) key may make.
   */
  private async respond(scope: Scope, body: unknown): Promise<{ heuristicId: string } & FindingState> {
    const b = (body ?? {}) as Partial<FindingResponseMessage>;
    if (typeof b.workspace !== 'string' || typeof b.heuristicId !== 'string' || !b.heuristicId || !['useful', 'acknowledge', 'mute', 'unmute'].includes(b.response as string)) {
      throw new HttpError(400, 'body must be { "workspace": "...", "heuristicId": "...", "response": "useful" | "acknowledge" | "mute" | "unmute" }');
    }
    if (!sees(scope, b.workspace)) throw new HttpError(400, `this token can't read ${b.workspace}`);
    if (!this.visibleStores(scope).some((s) => s.workspace === b.workspace)) throw new HttpError(404, `no workspace ${b.workspace} recorded`);
    return { heuristicId: b.heuristicId, ...(await this.findings.respond(b.workspace, b.heuristicId, b.response as Response)) };
  }

  /** GET /findings: the token's workspaces' findings now (the admin token names one with ?workspace=). */
  /** GET /plans?workspace=w (a workspace token may leave it out): its plans view, with the sibling worktrees the token reads. */
  private async plans(scope: Scope, workspace: string | null): Promise<PlansView> {
    const w = workspace ?? (!readsAll(scope) && scope.workspaces.length === 1 ? scope.workspaces[0] : null);
    if (w === null) throw new HttpError(400, 'name the workspace: ?workspace=<workspace>');
    this.store(scope, w);
    return plansView({ home: this.opts.home, workspace: w, visible: (x) => sees(scope, x) });
  }

  private async currentFindings(scope: Scope, workspace: string | null): Promise<WorkspaceFindings[]> {
    const list = readsAll(scope) ? (workspace ? [workspace] : []) : workspace ? scope.workspaces.filter((w) => w === workspace) : scope.workspaces;
    if (list.length === 0) throw new HttpError(400, readsAll(scope) ? 'name the workspace: ?workspace=<workspace>' : `this token can't read ${workspace}`);
    return Promise.all(list.map((w) => this.findings.current(w)));
  }

  /**
   * Whether a Host header names this machine: 127.0.0.1, localhost or [::1], on any port (a
   * remote VS Code window forwards the core to another port), or a host a front door added with
   * the admin token (a Codespaces address). What stops DNS rebinding is the name: a page that
   * points its own name at 127.0.0.1 still sends that name.
   */
  private hostAllowed(host: string | undefined): boolean {
    if (!host) return false;
    if (/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host)) return true;
    return this.extraHosts.has(host.toLowerCase());
  }

  /** POST /ui-links (admin): a one-time code, good for two minutes, and the address that uses it. */
  private uiLink(scope: Scope, body: unknown): { code: string; url: string; expiresAt: string } {
    if (!scope.admin) throw new HttpError(403, 'only the admin token can open the advisor UI');
    const now = Date.now();
    for (const [code, c] of this.uiCodes) if (c.expires < now) this.uiCodes.delete(code);
    const code = crypto.randomBytes(24).toString('base64url');
    // The workspace to show first, kept with the code rather than put in the address.
    const workspace = (body as { workspace?: unknown })?.workspace;
    // A remote VS Code window's forwarded address for the core (vscode.env.asExternalUri), to accept from now on.
    const allowHost = (body as { allowHost?: unknown })?.allowHost;
    if (typeof allowHost === 'string' && /^[a-z0-9.-]+(:\d+)?$/i.test(allowHost)) this.extraHosts.add(allowHost.toLowerCase());
    this.uiCodes.set(code, { expires: now + UI_LINK_TTL_MS, ...(typeof workspace === 'string' && workspace ? { workspace } : {}) });
    // The code rides in the fragment, which a browser never sends to a server or in a Referer. Bare (base64url
    // only), so nothing that opens links (VS Code's openExternal) re-encodes it.
    return { code, url: `http://127.0.0.1:${this.boundPort}/ui/#${code}`, expiresAt: new Date(now + UI_LINK_TTL_MS).toISOString() };
  }

  /** POST /ui-session { code }: the code, once, for a reader token (every workspace, read only). */
  private uiSession(body: unknown): { token: string; workspace?: string } {
    const code = (body as { code?: unknown })?.code;
    const link = typeof code === 'string' ? this.uiCodes.get(code) : undefined;
    if (typeof code === 'string') this.uiCodes.delete(code);
    if (link === undefined || link.expires < Date.now()) throw new HttpError(401, 'that link has expired or was already used; open the advisor UI again with snagboat open');
    const token = crypto.randomBytes(32).toString('hex');
    while (this.readerTokens.size >= MAX_READERS) this.readerTokens.delete(this.readerTokens.keys().next().value!);
    this.readerTokens.set(token, Date.now());
    return { token, ...(link.workspace ? { workspace: link.workspace } : {}) };
  }

  /** GET /workspaces: the workspaces this token reads, most recently active first. */
  private workspaces(scope: Scope): Array<{ workspace: string; folder?: string; lastDay?: string }> {
    return this.visibleStores(scope)
      .map((s) => {
        let lastDay: string | undefined;
        try {
          lastDay = fs.readdirSync(path.join(s.dir, 'events')).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().pop()?.slice(0, 10);
        } catch {
          // no events yet
        }
        return { workspace: s.workspace, ...(s.folder ? { folder: s.folder } : {}), ...(lastDay ? { lastDay } : {}) };
      })
      .sort((a, b) => (b.lastDay ?? '').localeCompare(a.lastDay ?? '') || a.workspace.localeCompare(b.workspace));
  }

  /** GET /ui/...: the advisor UI's files, with a policy that lets the page load only its own files and talk only to the core. */
  private serveUi(req: http.IncomingMessage, res: http.ServerResponse): void {
    req.resume();
    const security = {
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    };
    const pathname = new URL(req.url ?? '/ui/', 'http://127.0.0.1').pathname;
    if (pathname === '/ui') {
      res.writeHead(308, { Location: '/ui/', ...security }).end();
      return;
    }
    const name = pathname === '/ui/' ? 'index.html' : pathname.slice('/ui/'.length);
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
    const type = types[path.extname(name)];
    const file = type ? uiFile(this.uiDir, name) : undefined;
    let body: Buffer | undefined;
    try {
      if (file) body = fs.readFileSync(file);
    } catch {
      body = undefined;
    }
    if (!body) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...security }).end(this.uiDir ? 'Not found' : 'The advisor UI files are missing from this install');
      return;
    }
    res.writeHead(200, { 'Content-Type': type!, ...security }).end(body);
  }

  private visibleStores(scope: Scope) {
    const stores = listUserStores(this.opts.home);
    return stores.filter((s) => sees(scope, s.workspace));
  }

  private async sessions(scope: Scope, daysParam: string | null, workspace: string | null = null): Promise<Array<SessionListItem & { workspace: string }>> {
    let days: number | undefined;
    if (daysParam !== null) {
      days = Number(daysParam);
      if (!Number.isFinite(days) || days <= 0) throw new HttpError(400, 'days must be a positive number');
    }
    const stores = workspace === null ? this.visibleStores(scope) : [this.store(scope, workspace)];
    const all: Array<SessionListItem & { workspace: string }> = [];
    for (const store of stores) for (const s of await this.sessionPages.list(store.workspace)) all.push({ ...s, workspace: store.workspace });
    const since = days === undefined ? '' : new Date(Date.now() - days * 86_400_000).toISOString();
    return all.filter((s) => s.lastTs >= since).sort((a, b) => b.lastTs.localeCompare(a.lastTs));
  }

  private async session(scope: Scope, id: string): Promise<SessionListItem & { workspace: string }> {
    if (!id) throw new HttpError(404, 'session id missing');
    const found = (await this.sessions(scope, null)).filter((s) => s.sessionId === id || s.sessionId.startsWith(id));
    if (found.length === 0) throw new HttpError(404, `no session ${id}`);
    const exact = found.filter((s) => s.sessionId === id);
    if (exact.length === 1) return exact[0];
    if (found.length > 1) throw new HttpError(409, `${id} matches ${found.length} sessions; give more of the id`);
    return found[0];
  }

  /** GET /sessions/:id/view: one session as its page draws it (step 5b), found by id or unique prefix. */
  private async sessionPage(scope: Scope, id: string, workspace: string | null): Promise<SessionPage> {
    let found: { workspace: string; sessionId: string };
    if (workspace !== null) {
      this.store(scope, workspace);
      found = { workspace, sessionId: id };
    } else found = await this.session(scope, id);
    const page = await this.sessionPages.page(found.workspace, found.sessionId);
    if (!page) throw new HttpError(404, `no session ${id} in this workspace`);
    return page;
  }

  /** A workspace this token reads that has a store, or 404. */
  private store(scope: Scope, workspace: string) {
    if (!sees(scope, workspace)) throw new HttpError(403, `this token can't read ${workspace}`);
    const store = this.visibleStores(scope).find((s) => s.workspace === workspace);
    if (!store) throw new HttpError(404, `no store for ${workspace}`);
    return store;
  }
}

/**
 * The file for a /ui/ name, or undefined: plain names under media/ui (no folders, no ..), Snagboat's
 * shared page files under media/ (MEDIA_FILES), and drawings/<name>.js or .css under media/drawings.
 */
function uiFile(ui: string | undefined, name: string): string | undefined {
  if (!ui) return undefined;
  const drawing = /^drawings\/([a-z0-9][a-z0-9-]*\.(?:js|css))$/i.exec(name);
  if (drawing) return path.join(ui, '..', 'drawings', drawing[1]);
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(name)) return undefined;
  return MEDIA_FILES.includes(name) ? path.join(ui, '..', name) : path.join(ui, name);
}

/**
 * Files from media/ beside media/ui that the advisor UI loads too: the theme and base styles, and
 * VS Code's Suggestions tab with its helpers (step 5c-2).
 */
const MEDIA_FILES = ['theme.css', 'base.css', 'shared.js', 'suggestions.js'];

/**
 * media/ui, found from wherever the core runs: dist/snagboat.js (in the repo, or in the installed
 * extension, whose VSIX ships media/) or compiled tests under out/.
 */
function findUiDir(): string | undefined {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const ui = path.join(dir, 'media', 'ui');
    if (fs.existsSync(path.join(ui, 'index.html'))) return ui;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
