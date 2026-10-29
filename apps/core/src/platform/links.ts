import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { reasonOf } from './os-kind.ts';

/**
 * Ссылки под корнем поиска (06 §Session permissions, F-87): symlink, junction и точка
 * монтирования Windows (все — reparse point, Node видит их ссылкой). Судья чтения не знает,
 * пойдёт ли инструмент поиска по ссылке, — ему нужен список ссылок поддерева с их целями.
 *
 * Обход ограничен бюджетом записей; не досмотрел (бюджет, нечитаемый каталог) — `complete:false`
 * с причиной, а не «ссылок нет» (F25). Внутрь `.git` и каталогов зависимостей (`node_modules`)
 * обход не спускается, если они сами не ссылки: ссылка с таким именем — тоже в списке.
 */

/** Каталоги, внутрь которых обход не идёт (сами они, если ссылки, проверяются как все). */
export const LINK_SCAN_SKIP: readonly string[] = ['.git', 'node_modules'];

/**
 * Записей на один поиск. Замер 28.10 (Windows, NTFS): 3,6 тыс. записей — 45 мс, 97,6 тыс. —
 * 0,95 с. Больше — поиск отказан (корень не досмотрен), а не пропущен.
 */
export const LINK_SCAN_BUDGET = 100_000;

export interface FoundLink {
  /** Где лежит ссылка (как найдена обходом). */
  at: string;
  /** Настоящая цель; `null` — не разрешается (висячая, петля, нет прав). */
  target: string | null;
}

export type LinkScan =
  | { complete: true; links: FoundLink[]; seen: number }
  | { complete: false; links: FoundLink[]; seen: number; reason: string };

function realOrNull(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

export function scanLinks(root: string, budget = LINK_SCAN_BUDGET): LinkScan {
  const links: FoundLink[] = [];
  const queue = [root];
  let seen = 0;
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      return { complete: false, links, seen, reason: `${dir} not readable: ${reasonOf(error)}` };
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > budget) {
        return { complete: false, links, seen, reason: `link scan budget ${budget} exceeded` };
      }
      const at = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) links.push({ at, target: realOrNull(at) });
      else if (entry.isDirectory() && !LINK_SCAN_SKIP.includes(entry.name)) queue.push(at);
    }
  }
  return { complete: true, links, seen };
}

/** Что лежит по пути (по цели ссылок); ошибка, кроме «нет такого», — `unknown`. */
export function pathKind(p: string): 'dir' | 'file' | 'missing' | 'unknown' {
  try {
    return statSync(p).isDirectory() ? 'dir' : 'file';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EINVAL' ? 'missing' : 'unknown';
  }
}

/**
 * Настоящий путь самого глубокого существующего префикса. Префикс есть (`lstat` видит его), а
 * `realpath` не проходит — висячая ссылка, петля, нет прав: `unknown`, а не путь «как написан».
 */
export function realExistingPrefix(
  p: string,
): { real: string } | { missing: true } | { unknown: string } {
  let head = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      lstatSync(head);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return { missing: true };
      tail.unshift(path.basename(head));
      head = parent;
      continue;
    }
    try {
      return { real: path.join(realpathSync.native(head), ...tail) };
    } catch (error) {
      return { unknown: `${head} does not resolve: ${reasonOf(error)}` };
    }
  }
}
