import type { WatchContext } from './watch.types.ts';

/**
 * Общие мелочи свёртки сторожа: потолки списков и словарей, сведение путей. Отдельно
 * от `reduce.ts`, чтобы поводы новых правил (`reduce-incidents.ts`) брали их без
 * кольца импортов.
 */

/** Потолок списков событий-поводов (спавны, записи, чтения панели, циклы, холодные записи). */
export const LIST_CAP = 20;
/** Потолок словарей проверок и чтений: вытесняется давнее. */
export const MAP_CAP = 100;
/** Короткое имя 8.3 (`RUSYAN~1`): сравнить с корнем панели можно только после разворота диском. */
const SHORT_NAME = /~\d/;
/** Абсолютный путь: `/…`, `C:/…`, `C:\…`, `\\сервер\…`. */
export const ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|[\\/])/;

export const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

export function capped<T>(list: T[], item: T, cap = LIST_CAP): T[] {
  list.push(item);
  if (list.length > cap) list.splice(0, list.length - cap);
  return list;
}

/** Словарь сверх потолка теряет записи с самым давним `lastAt`. */
export function bound(map: Record<string, { lastAt: number }>): void {
  const keys = Object.keys(map);
  if (keys.length <= MAP_CAP) return;
  keys
    .sort((a, b) => (map[a]?.lastAt ?? 0) - (map[b]?.lastAt ?? 0))
    .slice(0, keys.length - MAP_CAP)
    .forEach((key) => delete map[key]);
}

/**
 * Путь для сравнения: косые вперёд, без хвостовой косой. Регистр и `/c/…` Git
 * Bash → `c:/…` сводятся только на Windows: на Linux и macOS `/home/U` и
 * `/home/u` — разные каталоги, а `/c/` — обычная папка.
 */
export function normPath(path: string, platform: NodeJS.Platform = process.platform): string {
  const out = path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (platform !== 'win32') return out;
  const lower = out.toLowerCase();
  const bash = /^\/([a-z])\//.exec(lower);
  return bash ? `${bash[1]}:/${lower.slice(3)}` : lower;
}

/** `a/./b/../c` → `a/c`: относительный путь, выходящий из копии наверх, сравнивается по месту. */
function collapseDots(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '.') continue;
    if (part === '..' && parts.length > 1) parts.pop();
    else if (part !== '..') parts.push(part);
  }
  // Сведено до корня (`/a/..`, `c:/a/..`) — корень, не пустая строка и не голый диск (F-90).
  if (parts.length === 1 && (parts[0] === '' || /^[a-z]:$/i.test(parts[0] ?? ''))) {
    return `${parts[0]}/`;
  }
  return parts.join('/');
}

/**
 * Путь из поля инструмента или команды → абсолютный, сведённый: `~` — домашний
 * каталог, относительный — от каталога звена, короткое имя 8.3 — разворотом
 * диском (`realPath`, только если путь существует). Не к чему привязать — нет.
 */
export function absolutePath(raw: string, ctx: WatchContext): string | undefined {
  let path = raw.trim();
  if (!path) return undefined;
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) {
    if (!ctx.home) return undefined;
    path = `${ctx.home}${path.slice(1)}`;
  }
  if (!ABSOLUTE.test(path)) {
    if (!ctx.cwd) return undefined;
    path = `${ctx.cwd}/${path}`;
  }
  if (SHORT_NAME.test(path)) path = ctx.realPath?.(path) ?? path;
  return collapseDots(normPath(path));
}

export const under = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`);
