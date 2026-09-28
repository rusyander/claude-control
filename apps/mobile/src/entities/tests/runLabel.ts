import { runOrigin } from '@agentdeck/contracts/test-format';

interface RunWords {
  mode: Record<string, string>;
  actor: Record<string, string>;
  e2e: string;
  e2eActor: string;
}

/**
 * Подпись записи истории: режим и кто гонял. Прогон автотестов панелью и отчёт
 * CI — оба `mode:'import'`; без `origin` телефон называл бы автотесты панели
 * «импортом из CI». Правило то же, что у веба (`runOrigin` из контрактов):
 * старая запись без поля — CI.
 */
export function runLabel(
  run: { mode: string; actor: string; origin?: string },
  words: RunWords,
): { title: string; actor: string } {
  if (runOrigin(run) === 'e2e') return { title: words.e2e, actor: words.e2eActor };
  return { title: words.mode[run.mode] ?? run.mode, actor: words.actor[run.actor] ?? run.actor };
}
