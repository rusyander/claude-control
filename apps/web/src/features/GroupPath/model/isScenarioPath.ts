import type { PathEntry } from '@agentdeck/contracts';

/**
 * Путь сценария: сервер собирает его без строк стадий (`buildPath`), у
 * конвейера они есть всегда — даже без единого своего шага.
 */
export function isScenarioPath(entries: PathEntry[]): boolean {
  return !entries.some((entry) => entry.kind === 'builtin');
}
