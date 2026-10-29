import { runOrigin } from '@agentdeck/contracts/test-format';

interface RunWords {
  mode: Record<string, string>;
  actor: Record<string, string>;
  e2e: string;
  e2eActor: string;
  core: string;
  coreActor: string;
}

/**
 * Подпись записи истории: режим и кто гонял. Прогон автотестов панелью, проверка ядра задач и
 * отчёт CI — все `mode:'import'`; без `origin` телефон называл бы их «импортом из CI». Правило
 * то же, что у веба (`runOrigin` из контрактов): старая запись без поля — CI.
 */
export function runLabel(
  run: { mode: string; actor: string; origin?: string },
  words: RunWords,
): { title: string; actor: string } {
  const origin = runOrigin(run);
  if (origin === 'e2e') return { title: words.e2e, actor: words.e2eActor };
  if (origin === 'core') return { title: words.core, actor: words.coreActor };
  return { title: words.mode[run.mode] ?? run.mode, actor: words.actor[run.actor] ?? run.actor };
}
