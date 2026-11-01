import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { ReviewTarget } from '@agentdeck/contracts/core/model-tools';
import { linesAfter } from '../../journal/read-view.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { SplitCheckDecision } from '../split-check/index.ts';
import type { ProposedUnit } from './split.types.ts';

/**
 * Чтение деления из журнала: свёртка v6 хранит у деления только состояние и автора, а единицы
 * предложения и порядок проверки — в строках `split.proposed` и `decision` (CONTRACT REQUEST (c)
 * в отчёте зоны D). Чтение — строк этой задачи, по `splitId`.
 */

export interface SplitRecordView {
  splitId: string;
  units: ProposedUnit[];
  proposedSeq: number;
  /** Решение проверки; `null` — проверки ещё не было (крах между строками). */
  decision: (SplitCheckDecision & { splitId: string }) | null;
  state: 'proposed' | 'accepted' | 'approved' | 'edited' | 'refused';
}

export function linesOf(task: LiveTask): JournalLine[] {
  return linesAfter(task.dir, task.taskId, 0);
}

export function splitsOf(lines: readonly JournalLine[]): SplitRecordView[] {
  const out = new Map<string, SplitRecordView>();
  for (const l of lines) {
    if (l.kind === 'split.proposed') {
      const d = (l as JournalLine<'split.proposed'>).data;
      out.set(d.splitId, {
        splitId: d.splitId,
        units: d.units,
        proposedSeq: l.seq,
        decision: null,
        state: 'proposed',
      });
    } else if (l.kind === 'decision') {
      const d = (l as JournalLine<'decision'>).data;
      const output = d.output as { splitId?: unknown } | null;
      const rec = typeof output?.splitId === 'string' ? out.get(output.splitId) : undefined;
      if (d.class === 'split-check' && rec)
        rec.decision = d.output as unknown as SplitRecordView['decision'];
    } else if (l.kind === 'split.decided') {
      const d = (l as JournalLine<'split.decided'>).data;
      const rec = out.get(d.splitId);
      if (rec) rec.state = d.outcome;
    }
  }
  return [...out.values()];
}

/** Последнее деление задачи — только его утверждают, правят и запускают. */
export function latestSplit(lines: readonly JournalLine[]): SplitRecordView | undefined {
  return splitsOf(lines).at(-1);
}

/**
 * Цели ревью, которые насчитал разбор (02:19, 02:69): поле `reviewTargets` принятого заявления
 * `step_done` (строка `step.claimed`), последнее названное. `null` — разбор ничего не сообщил.
 */
export function reviewTargetsOf(lines: readonly JournalLine[]): ReviewTarget[] | null {
  let found: ReviewTarget[] | null = null;
  for (const l of lines) {
    if (l.kind !== 'step.claimed') continue;
    const targets = (l as JournalLine<'step.claimed'>).data.claim.reviewTargets;
    if (targets) found = targets;
  }
  return found;
}
