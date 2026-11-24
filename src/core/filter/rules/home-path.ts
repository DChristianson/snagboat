import type { FilterContext, Match, Rule } from '../types';
import { escapeRegExp, spans } from './util';

// A home folder's name: up to the next separator or delimiter.
const NAME = `[^/\\\\\\s"'\`<>|;,:)\\]}]+`;
const POSIX = new RegExp(`(?<![\\w.~/\\\\-])(?<![A-Za-z]:)(?:file://)?(?<home>/(?:Users|home)/(?!Shared(?![^/\\\\\\s]))${NAME})`, 'g');
const WINDOWS = new RegExp(`(?<![\\w/\\\\])(?:file:///)?(?<home>[A-Za-z]:[\\\\/](?:Users|Documents and Settings)[\\\\/]${NAME})`, 'gi');
const TILDE = /(?<![\w~/\\.-])~[A-Za-z_][A-Za-z0-9_.-]*(?=\/)/g;

export const homePath: Rule = {
  id: 'home-path',
  category: 'Local directories',
  describe: 'Home folders, anyone\'s: `/Users/<name>`, `/home/<name>`, `C:\\Users\\<name>`, in `file://` URLs too, `~<name>`, and this machine\'s home wherever it is.',
  becomes: '`~`',
  defaultAction: 'review',
  detect(text: string, ctx: FilterContext): Match[] {
    // This machine's home, wherever it is (a test's, a container's /root), as written.
    const own = ctx.homes
      .filter((h) => text.includes(h))
      .flatMap((h) => spans(new RegExp(`(?<![\\w.~/\\\\-])(?:file://)?${escapeRegExp(h)}(?![\\w.-])`, 'g'), text, () => h));
    if (!/Users|home|~|Documents and Settings/i.test(text)) return own;
    return [
      ...own,
      ...spans(POSIX, text, (_s, m) => m.groups!.home),
      ...spans(WINDOWS, text, (_s, m) => m.groups!.home.replace(/\//g, '\\').replace(/^[a-z]/, (c) => c.toUpperCase())),
      ...spans(TILDE, text),
    ];
  },
  replace(): string {
    return '~';
  },
};
