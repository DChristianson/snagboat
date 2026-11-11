import { SessionIndex, SessionSummary } from '@snagboat/schema';
import { EventLog } from './eventLog';

/** The sessions in one store's raw event log (the folder holding events/), read from disk. */
export async function storeSessions(dir: string): Promise<SessionSummary[]> {
  const log = new EventLog(dir);
  const index = new SessionIndex();
  for (const day of await log.listDays()) for (const e of await log.readDay(day)) index.ingest(e);
  return index.list();
}
