import type { Match, Rule } from '../types';
import { spans } from './util';

/** Semicolon connection strings' passwords: Server=db;User Id=sa;Password=<s>; */
const PASSWORD = /(?:^|[;"'\s])(?:password|pwd)\s*=\s*(?!\[redacted)(?<s>[^;"'\r\n]+)/gi;

export const connectionString: Rule = {
  id: 'connection-string',
  category: 'Credentials',
  describe: 'Passwords in connection strings (`Server=...;Password=...`).',
  becomes: '`[secret]`',
  defaultAction: 'review',
  detect(text: string): Match[] {
    return spans(PASSWORD, text, (s) => s.trim() || undefined).map((m) => ({ ...m, end: m.start + text.slice(m.start, m.end).trimEnd().length }));
  },
  replace(): string {
    return '[secret]';
  },
};
