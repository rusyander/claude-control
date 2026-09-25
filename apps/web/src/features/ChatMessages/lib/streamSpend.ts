import type { MessageUsage } from '@agentdeck/contracts';
import type { StreamedTool } from '@shared/lib/chat-stream';

/** Расход шага у вызова живого пузыря и сколько вызовов его делят. */
export interface StreamStepSpend {
  usage: MessageUsage;
  sharedWith: number;
}

/**
 * Расход шага — только у ПЕРВОГО его вызова. Стор раздаёт один и тот же объект
 * расхода всем вызовам шага (раздельного счёта модель не даёт), и бейдж у
 * каждого из них читался как трижды потраченное (находка 3 журнала 24.09.2026).
 * История сводит блоки хода по `message.id` и ставит бейдж один раз — живой
 * пузырь обязан показывать то же самое, иначе цифры прыгают на переходе
 * «поток → история». Шаг узнаётся по тому же объекту расхода, что и число
 * делящих его вызовов.
 */
export function streamStepSpend(
  tools: readonly StreamedTool[],
  index: number,
): StreamStepSpend | undefined {
  const usage = tools[index]?.usage;
  if (!usage) return undefined;
  if (tools.findIndex((tool) => tool.usage === usage) !== index) return undefined;
  return { usage, sharedWith: tools.filter((tool) => tool.usage === usage).length };
}
