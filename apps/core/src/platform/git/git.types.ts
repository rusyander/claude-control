import type { TreeRow } from '@agentdeck/contracts/core/records';
import type { OsKind } from '../os-kind.ts';
import type { runTool } from '../run-tool.ts';

export type { TreeRow };

/** Запуск git; в тестах отказов подменяется (таймаут, ENOENT, мусор вывода). */
export type GitRunner = typeof runTool;

export interface GitOptions {
  run?: GitRunner;
  os?: OsKind;
  /** Окружение, поверх которого строится окружение git (по умолчанию — процесса). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Ревизия дерева: имя, sha или `'worktree'` — рабочая копия как она есть (через временный
 * индекс). Ветку с именем `worktree` передают полным именем `refs/heads/worktree`.
 */
export type TreeRev = string;

export type WorktreeAdd = { created: string; head: string } | { failed: string };
