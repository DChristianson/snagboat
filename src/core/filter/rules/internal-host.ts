import type { Match, Rule } from '../types';
import { isPublicHost, numbered, spans } from './util';

/** A URL's host (after any user info). */
const URL_HOST = /\b(?:https?|wss?|ftp|ssh|git|svn):\/\/(?:[^\s/?#"'`<>)\]}@]*@)?(?<s>[^\s/?#"'`<>)\]}:@]+)/gi;
/**
 * A dotted host name on a top-level domain that's never public, outside a URL too. Fewer than
 * a URL's: .home, .private and .intra are as often a property in code (this.private).
 */
const BARE_HOST = /(?<![\w.@-])(?<s>[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)*\.(?:local|internal|lan|corp|intranet|localdomain|home\.arpa))(?![\w-]|\.[A-Za-z0-9])/gi;

export const internalHost: Rule = {
  id: 'internal-host',
  category: 'Network',
  describe: "Host names that aren't public (`.local`, `.internal`, `.lan`, `.corp` and the like), and a bare name in a URL (`http://buildbox/`). Not `localhost`.",
  becomes: '`[host-N]`',
  defaultAction: 'review',
  detect(text: string): Match[] {
    return [
      ...spans(URL_HOST, text, (h) => (isPublicHost(h) ? undefined : h.toLowerCase())),
      ...spans(BARE_HOST, text, (h) => h.toLowerCase()),
    ];
  },
  replace: numbered('host'),
};
