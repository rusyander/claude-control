import { runs } from './agent-runs.state.constants';

/**
 * Ключ прогона по id чата. Новый чат стартует под временным id (`new-…`), а
 * потом получает настоящий sessionId; чтобы отображение не потеряло прогон при
 * смене id, ищем и по sessionId.
 */
export function findKey(id: string | undefined): string | undefined {
  if (!id) return undefined;
  if (runs.has(id)) return id;
  for (const [key, run] of runs) if (run.sessionId === id) return key;
  return undefined;
}
