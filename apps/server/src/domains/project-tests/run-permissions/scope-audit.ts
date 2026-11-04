import { statSync } from 'node:fs';
import { join } from 'node:path';
import { TESTS_DIR } from '../files.ts';
import { gitSync } from '../../project-git/exec/exec.ts';
import { isWritable, type RunScope } from './run-permissions.ts';

/**
 * Сверка границ прогона на финише (этап 10, F6). Прогон идёт задачей ядра, и каждый вызов
 * инструмента судит судья ядра: правка — только в корне проекта, без `.git`, настроек CLI и
 * дорог публикации. Узкие границы режима (папка черновиков у генерации, каталог тестов,
 * файлы автотестов) ядро не держит — они в задании словами, а здесь сверяются ПО ФАКТУ: что в
 * рабочем дереве поменялось за прогон вне границ (инструментом или оболочкой — неважно) и
 * сдвинулась ли голова ветки (коммит, сброс, переключение). Найденное — строкой в лог прогона.
 *
 * Каталог тестов (`.agent/tests/`) не сверяется ни в каком режиме: туда пишет и сама панель
 * (история прогона, статусы, применение черновика), и отличить её запись от записи агента по
 * дереву нельзя.
 */

export interface ScopeBaseline {
  /** Не репозиторий или git не ответил — сверять не с чем. */
  git: boolean;
  head?: string;
  /** Грязные пути на старте (от корня, через `/`) → отпечаток файла. */
  dirty: Map<string, string>;
}

export interface ScopeAudit {
  /** Пути вне границ, тронутые за прогон (не больше `limit`). */
  outside: string[];
  /** Сколько всего таких путей. */
  total: number;
  headMoved: boolean;
  /** Сверка не выполнена — причина. */
  skipped?: string;
}

/** Пути `git status -z`: переименование несёт второй путь отдельной записью — берём оба. */
function dirtyPaths(root: string): string[] | undefined {
  const out = gitSync(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 15_000);
  if (out === undefined) return undefined;
  const parts = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // Переименование и копия (`R`/`C` в любой колонке): следом идёт исходный путь.
    if (/[RC]/.test(entry.slice(0, 2))) {
      const from = parts[i + 1];
      if (from) paths.push(from);
      i += 1;
    }
  }
  return paths;
}

function fingerprint(root: string, path: string): string {
  try {
    const stat = statSync(join(root, path));
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'absent';
  }
}

export function scopeBaseline(root: string): ScopeBaseline {
  const paths = dirtyPaths(root);
  if (paths === undefined) return { git: false, dirty: new Map() };
  const head = gitSync(root, ['rev-parse', 'HEAD'])?.trim() || undefined;
  return {
    git: true,
    ...(head ? { head } : {}),
    dirty: new Map(paths.map((path) => [path, fingerprint(root, path)])),
  };
}

const underTests = (path: string): boolean =>
  path === TESTS_DIR || path.startsWith(`${TESTS_DIR}/`);

export function auditScope(
  root: string,
  scope: RunScope,
  baseline: ScopeBaseline,
  limit = 10,
): ScopeAudit {
  if (!baseline.git) {
    return { outside: [], total: 0, headMoved: false, skipped: 'not a git repository' };
  }
  const paths = dirtyPaths(root);
  if (paths === undefined) {
    return { outside: [], total: 0, headMoved: false, skipped: 'git did not answer' };
  }
  const head = gitSync(root, ['rev-parse', 'HEAD'])?.trim() || undefined;
  const touched = [...new Set([...paths, ...baseline.dirty.keys()])].filter(
    (path) => baseline.dirty.get(path) !== fingerprint(root, path),
  );
  const outside = touched.filter(
    (path) => !underTests(path) && !isWritable(scope, join(root, path)),
  );
  return {
    outside: outside.slice(0, limit),
    total: outside.length,
    headMoved: baseline.head !== head,
  };
}
