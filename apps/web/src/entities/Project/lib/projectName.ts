import { projectShortName } from '@shared/lib/workspace';

/**
 * Короткое имя проекта из пути: последний сегмент читается лучше, чем
 * закодированное имя папки Claude Code. Пути нет — остаётся запасное имя.
 */
export function projectName(path: string | undefined, fallback: string): string {
  if (!path) return fallback;
  return projectShortName(path);
}
