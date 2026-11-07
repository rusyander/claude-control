import type { TaskClass, TaskClassDecision } from '@agentdeck/contracts/core/lead';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { classAnswerOf, classifyDedupe } from '../intake/questions.ts';

/** Строки решения класса: запись (вывод судьи целиком) и чтение последнего решения задачи. */

/** Строка решения класса; `inputs` — строки, по которым решали (шаг разведки, ответ человека). */
export function journalClass(
  task: LiveTask,
  decision: TaskClassDecision,
  inputs: readonly number[],
  stepId?: string,
): number {
  return task.append({
    kind: 'decision',
    actor: 'core',
    ...(stepId ? { stepId } : {}),
    data: {
      decisionId: newId(),
      class: 'classify',
      inputs: [...inputs],
      facts: [],
      numbers: {
        files: decision.signals.files,
        units: decision.signals.units,
        crossUnitDeps: decision.signals.crossUnitDeps,
        items: decision.signals.items,
      },
      reasons: decision.reasons,
      output: JSON.parse(JSON.stringify(decision)) as never,
    },
  }).seq;
}

/** Последнее решение класса задачи (вход повторного суда: признаки и предложение модели). */
export function lastClassDecision(task: LiveTask): TaskClassDecision | null {
  const lines = readJournalLines(task.dir, task.taskId).lines;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.kind !== 'decision') continue;
    const d = l.data as { class: string; output: unknown };
    if (d.class === 'classify') return d.output as TaskClassDecision;
  }
  return null;
}

/**
 * Класс, который человек назвал ответом на вопрос класса (последний ответ); не отвечал — `null`.
 * Повторный суд (модель предложила класс на разборе, разведка шла второй раз) берёт его входом:
 * иначе суд без человека вернул бы расчёт, и модель «понизила» бы выбор человека.
 */
export function humanClassOf(state: TaskFoldState, taskId: string): TaskClass | null {
  let out: TaskClass | null = null;
  for (const a of Object.values(state.asks))
    if (a.dedupe === classifyDedupe(taskId) && a.state === 'answered' && a.answer !== undefined)
      out = classAnswerOf(a.answer) ?? out;
  return out;
}

/** Предложение модели во входе решения: поднятое — `raised.model`, отказанное — `refusedLower`. */
export function proposalOf(decision: TaskClassDecision | null): TaskClass | null {
  if (!decision) return null;
  const raised = decision.raised.find((r) => r.cause === 'model');
  return raised?.to ?? decision.refusedLower?.proposed ?? null;
}
