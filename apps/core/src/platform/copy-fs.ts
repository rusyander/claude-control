import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  utimesSync,
  type Stats,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { currentOs, reasonOf, type OsKind } from './os-kind.ts';
import { longForm } from './paths.ts';
import { DEFAULT_RETRY, retryTransient } from './safe-io/retry.ts';

/**
 * Диск копии (04:97-98): обход свёрнутого каталога основной копии, перенос файла вместе с его
 * временем, чтение назад, настоящий путь копии. Ссылки не проходятся и не копируются: файл за
 * ссылкой лежит в основной копии, и запись «в копию» через неё правила бы оригинал (P04).
 */

/** Файлы под каталогом (пути от `root`, прямые слеши); запретные каталоги и ссылки не заходятся. */
export function listFilesUnder(root: string, dir: string, never: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(join(root, rel));
    } catch {
      // Нечитаемый каталог — его файлов в плане нет; копия назовёт то, что не легло, по чтению назад.
      return;
    }
    for (const name of names) {
      const relPath = rel ? `${rel}/${name}` : name;
      const info = lstatSync(join(root, relPath), { throwIfNoEntry: false });
      if (!info || info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (!never.has(name)) walk(relPath);
      } else if (info.isFile()) {
        out.push(relPath);
      }
    }
  };
  walk(dir.replace(/\\/g, '/').replace(/\/+$/, ''));
  return out;
}

export type SourceKind =
  { kind: 'file'; size: number } | { kind: 'link' } | { kind: 'other' } | { kind: 'absent' };

export function sourceKind(path: string): SourceKind {
  const info = lstatSync(longForm(path), { throwIfNoEntry: false });
  if (!info) return { kind: 'absent' };
  if (info.isSymbolicLink()) return { kind: 'link' };
  return info.isFile() ? { kind: 'file', size: info.size } : { kind: 'other' };
}

/**
 * Ссылка на пути назначения внутри копии (каталог-ссылка, junction, файл-ссылка): первый такой
 * сегмент от `root`, или `undefined`. `mkdirSync`/`copyFileSync` проходят ссылки насквозь, и
 * отслеживаемая ссылка на базе (`.claude` → `~/.ssh`) превратила бы перенос в запись вне копии.
 * Сегмент не читается — тоже ответ: писать туда вслепую нельзя.
 */
export function linkOnTheWay(root: string, rel: string): string | undefined {
  let at = '';
  for (const part of rel.replace(/\\/g, '/').split('/').filter(Boolean)) {
    at = at ? `${at}/${part}` : part;
    let info: Stats | undefined;
    try {
      // Без `longForm`: он раскрывает путь через realpath и прошёл бы сквозь ту самую ссылку.
      info = lstatSync(join(root, at), { throwIfNoEntry: false });
    } catch (error) {
      return `${at} (unread: ${reasonOf(error)})`;
    }
    if (!info) return undefined; // дальше всё создаст сам перенос — обычными каталогами
    if (info.isSymbolicLink()) return at;
  }
  return undefined;
}

/**
 * Перенос файла с временем оригинала: повторный перенос сразу после первого ничего не
 * переписывает. Ответ — прочитанный назад размер совпал; иначе причина.
 */
export function copyWithTimes(from: string, to: string): { ok: true } | { ok: false; why: string } {
  const src = longForm(from);
  const dst = longForm(to);
  try {
    const info = statSync(src);
    mkdirSync(dirname(dst), { recursive: true });
    retryTransient(() => copyFileSync(src, dst), DEFAULT_RETRY);
    utimesSync(dst, info.atime, info.mtime);
    const back = statSync(dst, { throwIfNoEntry: false });
    if (!back?.isFile()) return { ok: false, why: 'not read back after copy' };
    if (back.size !== info.size) return { ok: false, why: `size ${back.size} ≠ ${info.size}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, why: reasonOf(error) };
  }
}

/**
 * Настоящий путь каталога в длинной форме (8.3 раскрыт): cwd сессии и ключ копии. CLI спрашивал
 * права на свой cwd, когда тот приходил короткой формой (F13).
 */
export function realDir(dir: string, os: OsKind = currentOs()): Fact<string> {
  // «Нет» — только по stat без исключения; ошибка самого realpath — неизвестность (P44).
  if (!statSync(longForm(dir, os), { throwIfNoEntry: false })) return { absent: true };
  try {
    return { value: longForm(realpathSync.native(longForm(dir, os)), os) };
  } catch (error) {
    return { unknown: reasonOf(error) };
  }
}

/** Два файла побайтно равны; любой не читается (нет, каталог, отказ) — не равны. */
export function sameFileBytes(a: string, b: string): boolean {
  try {
    return readFileSync(longForm(a)).equals(readFileSync(longForm(b)));
  } catch {
    return false;
  }
}

export function fileExists(path: string): boolean {
  return statSync(longForm(path), { throwIfNoEntry: false })?.isFile() === true;
}

/**
 * Текст файла копии (манифест воркспейса для плана установки). Нет или не прочитался — `undefined`:
 * читатель плана считает это «членство не доказано», а не «член».
 */
export function readCopyText(path: string): string | undefined {
  try {
    const stats = statSync(longForm(path), { throwIfNoEntry: false });
    return stats?.isFile() ? readFileSync(longForm(path), 'utf8') : undefined;
  } catch {
    return undefined;
  }
}
