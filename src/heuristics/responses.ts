import * as fs from 'fs';
import * as path from 'path';
import { FindingResponse } from '@snagboat/schema';
import { Finding } from './types';

/**
 * How you responded to findings: one record per episode (a heuristic
 * reporting, until it stops), with when it was marked useful, acknowledged
 * or muted. The review reads these to see which findings get noticed. Heuristic
 * ids, severities, and times only: no summaries or targets.
 */
export interface ResponseEpisode {
  heuristicId: string;
  /** The worst severity it reached. */
  severity: 'info' | 'warn';
  startedAt: string;
  /** Unset if it was still reporting when the window closed. */
  endedAt?: string;
  acknowledgedAt?: string;
  mutedAt?: string;
  /** You marked it useful (which also acknowledges it). */
  usefulAt?: string;
}

/** How an episode was met, strongest first: useful, muted, acknowledged, else it passed (RFC step 4's finding usefulness). */
export function episodeResponse(episode: ResponseEpisode): FindingResponse {
  if (episode.usefulAt) return 'useful';
  if (episode.mutedAt) return 'muted';
  if (episode.acknowledgedAt) return 'acknowledged';
  return 'passed';
}

/**
 * Follows the findings registry and writes each episode when it ends (or the
 * window closes). An ended episode also comes with the events its findings
 * last named, for the outcome it records.
 */
export class ResponseTracker {
  private open = new Map<string, ResponseEpisode>();
  private refs = new Map<string, string[]>();

  constructor(private readonly write: (episode: ResponseEpisode, refs: string[]) => void, private readonly now: () => string = () => new Date().toISOString()) {}

  reported(heuristicId: string, findings: Finding[]): void {
    const episode = this.open.get(heuristicId);
    if (findings.length === 0) {
      if (episode) {
        this.open.delete(heuristicId);
        const refs = this.refs.get(heuristicId) ?? [];
        this.refs.delete(heuristicId);
        this.write({ ...episode, endedAt: this.now() }, refs);
      }
      return;
    }
    this.refs.set(heuristicId, [...new Set(findings.flatMap((f) => f.eventRefs))]);
    const severity = findings.some((f) => f.severity === 'warn') ? 'warn' : 'info';
    if (!episode) this.open.set(heuristicId, { heuristicId, severity, startedAt: this.now() });
    else if (severity === 'warn') episode.severity = 'warn';
  }

  acknowledged(heuristicId: string): void {
    const episode = this.open.get(heuristicId);
    if (episode && !episode.acknowledgedAt) episode.acknowledgedAt = this.now();
  }

  useful(heuristicId: string): void {
    const episode = this.open.get(heuristicId);
    if (!episode) return;
    episode.usefulAt ??= this.now();
    episode.acknowledgedAt ??= episode.usefulAt;
  }

  muted(heuristicId: string, muted: boolean): void {
    const episode = this.open.get(heuristicId);
    if (muted && episode && !episode.mutedAt) episode.mutedAt = this.now();
  }

  /** The episodes still open, without an end, for writing as the window closes. */
  drain(): ResponseEpisode[] {
    const open = [...this.open.values()].map((e) => ({ ...e }));
    this.open.clear();
    this.refs.clear();
    return open;
  }
}

/** Episodes as JSON lines in workspace storage, alongside the event log; kept for rawDays. */
export class ResponseLog {
  readonly file: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(storageDir: string) {
    this.file = path.join(storageDir, 'finding-responses.jsonl');
  }

  append(episode: ResponseEpisode): void {
    this.pending = this.pending
      .then(() => fs.promises.appendFile(this.file, `${JSON.stringify(episode)}\n`))
      .catch((err) => console.error('snagboat: failed to record a finding response', err));
  }

  /** Synchronous, for deactivation, when there's no waiting on promises. */
  appendNow(episodes: ResponseEpisode[]): void {
    if (episodes.length > 0) fs.appendFileSync(this.file, episodes.map((e) => `${JSON.stringify(e)}\n`).join(''));
  }

  async readAll(): Promise<ResponseEpisode[]> {
    await this.pending;
    let text: string;
    try {
      text = await fs.promises.readFile(this.file, 'utf8');
    } catch {
      return [];
    }
    const out: ResponseEpisode[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as ResponseEpisode);
      } catch {
        // a torn line from a crash; skip it
      }
    }
    return out;
  }

  /** Drops episodes that started before `days` ago. */
  async prune(days: number, now: string): Promise<void> {
    const cutoff = new Date(Date.parse(now) - days * 86_400_000).toISOString();
    const all = await this.readAll();
    const kept = all.filter((e) => e.startedAt >= cutoff);
    if (kept.length === all.length) return;
    await fs.promises.writeFile(this.file, kept.map((e) => `${JSON.stringify(e)}\n`).join(''));
  }

  async clear(): Promise<void> {
    await this.pending;
    await fs.promises.rm(this.file, { force: true });
  }
}

export interface ResponseStats {
  episodes: number;
  warnings: number;
  acknowledged: number;
  /** Marked useful (each also counts as acknowledged). */
  useful: number;
  /** Median minutes from appearing to acknowledged, over acknowledged episodes. */
  medianMinutesToAcknowledge?: number;
  /** Ended on their own, never acknowledged or muted: nobody acted on them. */
  expiredUnacknowledged: number;
  muted: number;
}

/** Per heuristic, how its episodes were met. */
export function responseStats(episodes: ResponseEpisode[]): Map<string, ResponseStats> {
  const out = new Map<string, ResponseStats>();
  const ackMinutes = new Map<string, number[]>();
  for (const e of episodes) {
    const s = out.get(e.heuristicId) ?? { episodes: 0, warnings: 0, acknowledged: 0, useful: 0, expiredUnacknowledged: 0, muted: 0 };
    s.episodes += 1;
    if (e.severity === 'warn') s.warnings += 1;
    if (e.acknowledgedAt) {
      s.acknowledged += 1;
      ackMinutes.set(e.heuristicId, [...(ackMinutes.get(e.heuristicId) ?? []), (Date.parse(e.acknowledgedAt) - Date.parse(e.startedAt)) / 60_000]);
    }
    if (e.usefulAt) s.useful += 1;
    if (e.mutedAt) s.muted += 1;
    if (e.endedAt && !e.acknowledgedAt && !e.mutedAt) s.expiredUnacknowledged += 1;
    out.set(e.heuristicId, s);
  }
  for (const [id, minutes] of ackMinutes) {
    const sorted = minutes.sort((a, b) => a - b);
    out.get(id)!.medianMinutesToAcknowledge = Math.round(sorted[Math.floor((sorted.length - 1) / 2)] * 10) / 10;
  }
  return out;
}
