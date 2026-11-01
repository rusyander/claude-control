import type { StepDoneCall } from '@agentdeck/contracts/core/model-tools';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { requirementsInputOf, type JudgedInput } from './journal-view.ts';
import type { RequirementRow } from './requirements.types.ts';

/**
 * Извлечение требований (02:54-56, G3 G4): пункты из `step_done.extracted` (разбор, план) и
 * добавленные сверкой (`requirementsReview.added`) получают id ядра — UUIDv7, одно написание
 * (F26); номер «R3» только для показа. Сверка пишет `requirement.reviewed` — без неё ворота
 * `requirements-covered` закрыты (P93).
 *
 * Строки пишутся после `step.claimed` того же шага и только раз: шаг, по которому они уже есть,
 * второй раз не извлекает — повтор после краха (крючок после шага) их дописывает, а не удваивает.
 */

export interface ExtractionPlan {
  extracted: Omit<RequirementRow, 'seq'>[];
  reviewed: { stepId: string; complete: boolean; added: string[] } | null;
}

export function extractionPlan(
  call: StepDoneCall,
  stepId: string,
  existing: JudgedInput,
  mint: () => string,
): ExtractionPlan {
  const done =
    existing.requirements.some((r) => r.stepId === stepId) ||
    existing.reviews.some((r) => r.stepId === stepId);
  if (done) return { extracted: [], reviewed: null };
  let ordinal = Math.max(0, ...existing.requirements.map((r) => r.ordinal));
  const extracted: ExtractionPlan['extracted'] = [];
  for (const point of call.extracted ?? [])
    extracted.push({
      id: mint(),
      ordinal: ++ordinal,
      text: point.text,
      source: point.source,
      stepId,
    });
  const added: string[] = [];
  for (const point of call.requirementsReview?.added ?? []) {
    const id = mint();
    added.push(id);
    extracted.push({ id, ordinal: ++ordinal, text: point.text, source: 'review', stepId });
  }
  const reviewed = call.requirementsReview
    ? { stepId, complete: call.requirementsReview.complete, added }
    : null;
  return { extracted, reviewed };
}

/** Записать извлечение шага (раз); ответ — требования этого шага с их id. */
export function applyExtraction(
  task: LiveTask,
  stepId: string,
  call: StepDoneCall,
): Omit<RequirementRow, 'seq'>[] {
  const existing = requirementsInputOf(readJournalLines(task.dir, task.taskId).lines);
  const plan = extractionPlan(call, stepId, existing, newId);
  for (const r of plan.extracted)
    task.append({
      kind: 'requirement.extracted',
      actor: 'core',
      stepId,
      data: {
        requirementId: r.id,
        ordinal: r.ordinal,
        text: r.text,
        source: r.source,
        stepId: r.stepId,
      },
    });
  if (plan.reviewed)
    task.append({ kind: 'requirement.reviewed', actor: 'core', stepId, data: plan.reviewed });
  if (plan.extracted.length > 0) return plan.extracted;
  return existing.requirements
    .filter((r) => r.stepId === stepId)
    .map(({ seq: _seq, ...rest }) => rest);
}
