import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { FiredVerdict, SignalDecision } from '../../observer/observer.types.ts';

/**
 * Решение наблюдателя в журнал (этап 8): `decision{class:'observer'}` (вывод — решение судьи +
 * ключ повтора, по нему перезапуск пересобирает «уже вынесено») и строка `signal` с действием
 * каталога, `cause` = строка решения. Шаг и сессия — из вердикта, иначе из `where`.
 */
export function writeObserverDecision(
  task: LiveTask,
  verdict: FiredVerdict,
  decision: SignalDecision,
  where: { stepId?: string; sessionId?: string; inputs: number[] },
): { decision: JournalLine<'decision'>; signal: JournalLine<'signal'> } {
  const stepId = verdict.stepId ?? where.stepId;
  const sessionId = verdict.sessionId ?? where.sessionId;
  const ids = { ...(stepId ? { stepId } : {}), ...(sessionId ? { sessionId } : {}) };
  const decisionLine = task.append({
    kind: 'decision',
    actor: 'core',
    ...ids,
    data: {
      decisionId: newId(),
      class: 'observer',
      inputs: verdict.inputs ?? where.inputs,
      facts: [],
      numbers: {},
      reasons: decision.reasons,
      output: { ...decision, key: verdict.key } as never,
    },
  });
  const signal = task.append({
    kind: 'signal',
    actor: 'core',
    ...ids,
    cause: decisionLine.seq,
    data: {
      signal: decision.signal,
      severity: decision.severity,
      subject: decision.subject,
      detail: decision.detail,
      action: decision.action,
    },
  });
  return { decision: decisionLine, signal };
}

/** Ключ повтора из вывода строки `decision{class:'observer'}`; нет — решение до этапа 8. */
export function observerKeyOf(line: JournalLine): string | undefined {
  if (line.kind !== 'decision') return undefined;
  const d = (line as JournalLine<'decision'>).data;
  if (d.class !== 'observer') return undefined;
  const out = d.output as { key?: unknown } | null;
  return typeof out?.key === 'string' ? out.key : undefined;
}
