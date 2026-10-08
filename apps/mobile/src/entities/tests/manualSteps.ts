import {
  applyParams,
  expandSteps,
  toSteps,
  type StepShape,
} from '@agentdeck/contracts/test-format';

/**
 * Шаги прохода так, как их видит человек и как их считает сервер: общие шаги
 * раскрыты, параметры подставлены. Номер отметки уходит на сервер, а тот
 * ищет ожидание провала в РАСКРЫТОМ списке (`manual.ts`, `expectedOf`): сырой
 * список со ссылкой на общий шаг давал провалу чужое «ожидалось». Тот же
 * расчёт, что у пульта в вебе (`resolveSteps`).
 */
export function manualSteps(
  raw: unknown,
  shared: Array<{ id: string; steps: StepShape[] }>,
  params: Record<string, string> = {},
): StepShape[] {
  return expandSteps(toSteps(raw), shared).map((step) => ({
    action: applyParams(step.action, params),
    ...(step.expected ? { expected: applyParams(step.expected, params) } : {}),
    ...(step.data ? { data: applyParams(step.data, params) } : {}),
  }));
}
