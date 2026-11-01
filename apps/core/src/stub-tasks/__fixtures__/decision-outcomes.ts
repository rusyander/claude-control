import { decisionOutcome } from '@agentdeck/contracts/core/decision-view';
import type { JournalLine } from '@agentdeck/contracts/core/journal';

/**
 * Решения журнала, чей исход не объявлен в `DECISION_OUTCOMES` (этап 9, F1): у панели для такого
 * решения нет шаблона заголовка. Пусто — каждое решение, которое пишет настоящий код, попадает в
 * объявленный исход; иначе — класс и выход дословно, чтобы было видно, чего не хватает.
 */
export function undeclaredDecisions(lines: readonly { kind: string; data: unknown }[]): string[] {
  return lines.flatMap((line) => {
    if (line.kind !== 'decision') return [];
    const d = line.data as JournalLine<'decision'>['data'];
    return decisionOutcome(d.class, d.output) === null
      ? [`${d.class} ${JSON.stringify(d.output)}`]
      : [];
  });
}

/** Сколько решений каждого класса увидено — тест называет, что он на деле проверил. */
export function decisionClasses(lines: readonly { kind: string; data: unknown }[]): string[] {
  return [
    ...new Set(
      lines
        .filter((l) => l.kind === 'decision')
        .map((l) => (l.data as JournalLine<'decision'>['data']).class),
    ),
  ].sort();
}
