import { runOrigin } from '@agentdeck/contracts/test-format';

/**
 * Ключи подписей записи в истории: режим и кто гонял. Прогон автотестов
 * панелью подписан «автотесты» · «панель», а не «импорт» · «CI» — иначе он
 * неотличим от отчёта сборки, хотя запускала его сама панель.
 */
export function runLabelKeys(run: { mode: string; actor: string; origin?: string }): {
  mode: string;
  actor: string;
} {
  if (runOrigin(run) === 'e2e') {
    return { mode: 'tests.runs.origin.e2e', actor: 'tests.runs.origin.e2eActor' };
  }
  return { mode: `tests.runs.mode.${run.mode}`, actor: `tests.runs.actor.${run.actor}` };
}
