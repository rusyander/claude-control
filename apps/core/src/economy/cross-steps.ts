import type { JournalLine } from '@agentdeck/contracts/core/journal';

/**
 * Шаги второго ревью (P185) по журналу: их решение `tier` шло с исключённым переходником первого
 * ревьюера — `numbers.avoided` есть, даже когда исключать было нечего (0). Одно правило на маршрут
 * (`routing-facts.ts`: правки не уходят за вторым ревьюером) и на судей требований и ворот
 * (`requirements/journal-view.ts`, `gates/journal-view.ts`: его вердикт ничего не одобряет).
 */
export function crossStepsOf(lines: readonly JournalLine[]): Set<string> {
  const out = new Set<string>();
  for (const l of lines) {
    if (l.kind !== 'decision' || !l.stepId) continue;
    const d = (l as JournalLine<'decision'>).data;
    if (d.class === 'tier' && d.numbers.avoided !== undefined) out.add(l.stepId);
  }
  return out;
}
