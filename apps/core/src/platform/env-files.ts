import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { errorCode } from './safe-io/retry.ts';

/**
 * Синхронный ограниченный обход корня за файлами окружения (факты права сессии собираются на
 * подготовке синхронно, `read-scope-build`). Каталог с именем файла окружения (`.env/` — venv)
 * — не файл: тип берётся из записи каталога, не из имени. Корня нет — пусто; сбой каталога или
 * предел записей — названная проблема, найденное до неё остаётся.
 */

export interface EnvWalkSpec {
  isEnvFile: (name: string) => boolean;
  enterDir: (path: string, name: string) => boolean;
  maxDepth: number;
  maxEntries: number;
}

export function listEnvFilesSync(
  root: string,
  spec: EnvWalkSpec,
): { files: string[]; problem?: string } {
  const files: string[] = [];
  let seen = 0;
  const walk = (dir: string, rel: string, depth: number): string | undefined => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT' && rel === '') return undefined;
      return `${rel || '.'}: ${(error as Error).message}`;
    }
    for (const e of entries) {
      if (++seen > spec.maxEntries) return `walk stopped after ${spec.maxEntries} entries`;
      const path = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (depth >= spec.maxDepth || path === '.git' || !spec.enterDir(path, e.name)) continue;
        const stop = walk(join(dir, e.name), path, depth + 1);
        if (stop) return stop;
      } else if (e.isFile() && spec.isEnvFile(e.name)) {
        files.push(join(dir, e.name));
      }
    }
    return undefined;
  };
  const problem = walk(root, '', 0);
  return problem ? { files, problem } : { files };
}
