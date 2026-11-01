import { isDecisionClass } from '@agentdeck/contracts/core/decision-view';
import type {
  CheckView,
  CostView,
  SessionView,
  StepView,
  TaskView,
  UsageView,
} from '@agentdeck/contracts/core/task-view';
import type { TimelineFold, TimelineRow } from './fold.types';

/**
 * Строки ленты вместе с видом задачи ядра. Свёртка ленты знает, ЧТО произошло и когда; вид знает
 * числа и выводы ядра: режим и «почему» проверки, запись вердикта, сессии шага, расход по шагу и
 * сессии (`spendOf`, P43). Здесь они только соединяются по ключам — панель ничего не пересчитывает,
 * иначе число на экране разошлось бы с тем, по которому решало ядро.
 */

export interface SpendPart {
  tokens: UsageView;
  cost: CostView;
}

export type TimelineItem =
  | {
      kind: 'step';
      row: TimelineRow;
      step: StepView | null;
      sessions: SessionView[];
      spend: SpendPart | null;
    }
  | { kind: 'session'; row: TimelineRow; session: SessionView | null; spend: SpendPart | null }
  | { kind: 'check'; row: TimelineRow; check: Pick<CheckView, 'mode' | 'why' | 'recordId'> }
  | { kind: 'row'; row: TimelineRow };

export function timelineItems(fold: TimelineFold, view: TaskView | undefined): TimelineItem[] {
  const checks = new Map((view?.checks ?? []).map((c) => [c.decisionId, c]));
  const steps = new Map((view?.steps ?? []).map((s) => [s.stepId, s]));
  const sessions = view?.sessions ?? [];
  return fold.rows.map((row): TimelineItem => {
    const item = row.item;
    if (item.type === 'decision' && item.cls === 'check') {
      const check = checks.get(item.decisionId);
      if (check)
        return {
          kind: 'check',
          row,
          check: { mode: check.mode, why: check.why, recordId: check.recordId },
        };
    }
    if (item.type === 'step-started' && row.stepId) {
      return {
        kind: 'step',
        row,
        step: steps.get(row.stepId) ?? null,
        sessions: sessions.filter((s) => s.stepId === row.stepId),
        spend: view?.spend.byStep[row.stepId] ?? null,
      };
    }
    if (item.type === 'session-started' && row.sessionId) {
      return {
        kind: 'session',
        row,
        session: sessions.find((s) => s.sessionId === row.sessionId) ?? null,
        spend: view?.spend.bySession[row.sessionId] ?? null,
      };
    }
    return { kind: 'row', row };
  });
}

/**
 * Ключи шаблона решения: подпись класса и заголовок исхода. `null` — класс не из реестра или исход
 * не прочитан: лента пишет «решение без шаблона» и причины дословно, а не выдуманный заголовок.
 */
export function decisionKeys(
  cls: string,
  outcome: string | null,
): { label: string; headline: string } | null {
  if (outcome === null || !isDecisionClass(cls)) return null;
  return {
    label: `coreTimeline.decisions.${cls}.label`,
    headline: `coreTimeline.decisions.${cls}.outcomes.${outcome}`,
  };
}

/** Сумма токенов всех видов — одна цифра строки; разбивка по видам — в подсказке. */
export function tokenTotal(t: UsageView): number {
  return t.input + t.cacheRead + t.cacheWrite + t.output;
}
