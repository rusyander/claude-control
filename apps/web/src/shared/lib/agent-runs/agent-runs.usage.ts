import type { MessageUsage } from '@claude-control/contracts';

/**
 * Сложить расход двух шагов. Нужно там, где несколько шагов схлопываются в один
 * блок интерфейса (сплошной текст ответа): показать два числа негде, а выбрать
 * одно из них — значит потерять второе. Модель берём последнюю: при смене
 * модели посреди хода честнее назвать ту, что писала конец, чем молчать.
 */
export function addUsage(base: MessageUsage | undefined, step: MessageUsage): MessageUsage {
  if (!base) return step;

  return {
    input: base.input + step.input,
    output: base.output + step.output,
    cacheRead: base.cacheRead + step.cacheRead,
    cacheCreation: base.cacheCreation + step.cacheCreation,
    cacheCreation1h:
      base.cacheCreation1h || step.cacheCreation1h
        ? (base.cacheCreation1h ?? 0) + (step.cacheCreation1h ?? 0)
        : undefined,
    model: step.model ?? base.model,
    costUsd:
      base.costUsd === undefined && step.costUsd === undefined
        ? undefined
        : (base.costUsd ?? 0) + (step.costUsd ?? 0),
  };
}
