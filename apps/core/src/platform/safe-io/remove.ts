import { existsSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describeError } from '../../lib/facts/read-fact.ts';
import { DEFAULT_RETRY, retryTransient, type RetryPolicy } from './retry.ts';

/**
 * Удаление с проверкой чтением (01 §Resources, P26): «удалил» говорится только после того, как
 * путь прочитан и его нет. Обход — свой, поштучными операциями: `fs.rmSync` с `force` на Windows
 * рапортовал успех, оставляя папку с нелатинским именем (замер сервера, `safe-io/fs-entry.ts`,
 * перенесён сюда). Ссылки не проходятся: удаляется сама ссылка, а не то, на что она указывает.
 */

export type RemoveOutcome = { removed: true } | { removed: false; reason: string };

export interface RemoveOptions {
  retry?: RetryPolicy;
  /** Подмена шага удаления — только для тестов «сказал удалено, а путь остался». */
  removeOne?: (path: string, isDir: boolean) => void;
}

function removeOneReal(path: string, isDir: boolean): void {
  if (isDir) rmdirSync(path);
  else unlinkSync(path);
}

function walk(path: string, options: RemoveOptions): void {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (!stats) return;
  const isDir = stats.isDirectory();
  if (isDir) for (const entry of readdirSync(path)) walk(join(path, entry), options);
  const removeOne = options.removeOne ?? removeOneReal;
  retryTransient(() => removeOne(path, isDir), options.retry ?? DEFAULT_RETRY);
}

export function removeVerified(path: string, options: RemoveOptions = {}): RemoveOutcome {
  try {
    walk(path, options);
  } catch (error) {
    return { removed: false, reason: describeError(error) };
  }
  // Чтение назад: путь обязан исчезнуть. Иначе отказ с причиной, а не «удалено».
  if (existsSync(path)) return { removed: false, reason: 'still present after removal' };
  return { removed: true };
}
