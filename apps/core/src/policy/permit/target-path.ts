import { hostname } from 'node:os';
import { currentOs } from '../../platform/os-kind.ts';
import { joinPath } from '../../platform/paths.ts';

/**
 * Путь цели read/edit в той форме, которую откроет файловая система (core-s2 F-126). Win32
 * открывает один и тот же файл под многими написаниями: `\\?\C:\…`, `\\.\C:\…`,
 * `\\localhost\C$\…`, `\\127.0.0.1\c$\…`, `\\<имя машины>\C$\…`, поток `token::$DATA` /
 * `token:s`, хвостовые точки и пробелы `token.`. Здесь они сводятся к `C:\…`; остальные пути
 * UNC и устройств (`\\?\GLOBALROOT`, `\\?\Volume{…}`, чужой сервер) судья не разрешает —
 * сравнить их с путями платформы нельзя. На POSIX путь не меняется.
 */

export type Canonical = { path: string } | { refuse: string };

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?|0:0:0:0:0:0:0:1)$/i;

function isLocalHost(host: string): boolean {
  return LOOPBACK.test(host) || host.toLowerCase() === hostname().toLowerCase() || host === '.';
}

/** Сегмент без потока NTFS и хвостовых точек и пробелов (`.` и `..` не трогаются). */
function cleanSegment(segment: string): string {
  if (segment === '.' || segment === '..') return segment;
  const noStream = segment.includes(':') ? segment.slice(0, segment.indexOf(':')) : segment;
  const trimmed = noStream.replace(/[. ]+$/, '');
  return trimmed === '' ? noStream : trimmed;
}

export function canonicalTarget(target: string, os = currentOs()): Canonical {
  if (os !== 'win32') return { path: target };
  let t = target.replace(/\//g, '\\');
  const device = /^\\\\[?.]\\(.*)$/s.exec(t);
  if (device) {
    const rest = device[1] as string;
    if (/^UNC\\/i.test(rest)) t = `\\\\${rest.slice(4)}`;
    else if (/^[A-Za-z]:(\\|$)/.test(rest)) t = rest;
    else return { refuse: `device path ${target}` };
  }
  const unc = /^\\\\([^\\]+)\\([^\\]+)(\\.*)?$/s.exec(t);
  if (unc) {
    const share = /^([A-Za-z])\$$/.exec(unc[2] as string);
    if (!isLocalHost(unc[1] as string) || !share) return { refuse: `network path ${target}` };
    t = `${share[1]}:${unc[3] ?? '\\'}`;
  } else if (t.startsWith('\\\\')) {
    return { refuse: `network path ${target}` };
  }
  const drive = /^[A-Za-z]:/.exec(t)?.[0] ?? '';
  const rest = t.slice(drive.length).split('\\').map(cleanSegment).join('\\');
  // Одна часть — `join` её нормализует (`.`/`..`, двойные разделители) по правилам win32.
  return { path: joinPath('win32', drive + rest) };
}

/** Буквальный каталог перед первым знаком маски (`~/x/**` → `~/x`); маски нет — сам путь. */
export function literalPrefix(target: string): string {
  const at = target.search(/[*?[{]/);
  if (at < 0) return target;
  const head = target.slice(0, at);
  const cut = Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\'));
  return cut < 0 ? '' : head.slice(0, cut) || head.slice(0, cut + 1);
}
