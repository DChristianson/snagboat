import type { Match, Rule } from '../types';
import { numbered, spans } from './util';

const MAC = /(?<![0-9A-Za-z:-])[0-9A-Fa-f]{2}([:-])(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}(?![0-9A-Za-z:-])/g;

export const mac: Rule = {
  id: 'mac',
  category: 'Network',
  describe: 'MAC addresses.',
  becomes: '`[mac-N]`',
  defaultAction: 'review',
  detect(text: string): Match[] {
    return spans(MAC, text, (s) => s.toLowerCase().replace(/-/g, ':'));
  },
  replace: numbered('mac'),
};
