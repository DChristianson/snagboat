import * as net from 'net';
import type { Match, Rule } from '../types';
import { numbered, spans } from './util';

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`(?<![\\w.])(?:${OCTET}\\.){3}${OCTET}(?![\\w]|\\.\\d)`, 'g');
/** Candidates only: isReportableIp decides. */
const IPV6 = /(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])/g;

/** An address worth asking about: anything but loopback and unspecified. */
export function isReportableIp(text: string): boolean {
  const v = net.isIP(text);
  if (v === 4) return !text.startsWith('127.') && text !== '0.0.0.0';
  if (v === 6) {
    const t = text.toLowerCase();
    return t !== '::1' && t !== '::' && !/^0{0,4}(?::0{0,4}){6}:0{0,3}[01]$/.test(t);
  }
  return false;
}

export const ip: Rule = {
  id: 'ip',
  category: 'Network',
  describe: 'IPv4 and IPv6 addresses, except loopback and unspecified (`127.0.0.1`, `::1`, `0.0.0.0`).',
  becomes: '`[ip-N]`',
  defaultAction: 'review',
  detect(text: string): Match[] {
    const ok = (s: string) => (isReportableIp(s) ? s.toLowerCase() : undefined);
    return [...spans(IPV4, text, ok), ...(text.includes(':') ? spans(IPV6, text, ok) : [])];
  },
  replace: numbered('ip'),
};
