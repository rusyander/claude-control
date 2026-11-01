import { covers } from '../../verifier/key/index.ts';
import type { EvidenceFacts, EvidenceProblem } from './requirements.types.ts';

/**
 * Годится ли запись доказательством требования этой задачи (02:59-61, P08 P92, G22). Чистая:
 * факты собирает вызывающий. Порядок — от записи к её смыслу: есть и зелёная → своя задача →
 * прогон ядра по проверке реестра → ключ равен ключу на текущем дереве → не статическая → её
 * замыкание пересекает изменённые единицей файлы. Сомнение в любом факте — отказ (P44): «не
 * прочиталось» никогда не «годится».
 */

/** Производная запись дорог захвата (argv вне реестра): обратная связь, не доказательство. */
const DERIVED_PREFIX = 'captured:';

export function evidenceProblem(facts: EvidenceFacts, taskId: string): EvidenceProblem | null {
  const { record } = facts;
  if ('absent' in record) return { code: 'missing', detail: 'no such record' };
  if ('unknown' in record) return { code: 'missing', detail: `unreadable: ${record.unknown}` };
  const rec = record.value;
  if (rec.verdict === 'fail') return { code: 'red', detail: 'the record is red' };
  if (rec.verdict === 'no-verdict')
    return { code: 'no-verdict', detail: 'the record has no verdict' };
  if (rec.taskId !== taskId)
    return {
      code: 'foreign-task',
      detail: 'foreign task: the record was not written by this task',
    };
  if (rec.origin !== 'core')
    return {
      code: 'captured-evidence',
      detail: `not a core run (origin ${rec.origin}): feedback, not evidence`,
    };
  if (rec.checkId.startsWith(DERIVED_PREFIX))
    return {
      code: 'captured-evidence',
      detail: `not a registry check (${rec.checkId}): call check by checkId`,
    };
  const { now, changed } = facts;
  if (!('value' in now))
    return {
      code: 'stale-evidence',
      detail: `the check's key on the current tree is not readable: ${'unknown' in now ? now.unknown : 'check no longer in the registry'}`,
    };
  if (now.value.key !== rec.key)
    return {
      code: 'stale-evidence',
      detail: 'the tree moved since this record: run the check again',
    };
  // Линт и типы не видят поведения: «кнопка показывает ошибку» ими не покрыть (02:60).
  if (now.value.class === 'static')
    return {
      code: 'irrelevant-evidence',
      detail: `${rec.checkId} is a static check: it never covers a requirement`,
    };
  if (!('value' in changed))
    return {
      code: 'irrelevant-evidence',
      detail: `files changed by the unit are not readable: ${'unknown' in changed ? changed.unknown : 'absent'}`,
    };
  const touched = changed.value.some((path) => now.value.closure.some((c) => covers(c, path)));
  if (!touched)
    return {
      code: 'irrelevant-evidence',
      detail: `unit ${rec.unit} of ${rec.checkId} covers none of the files this unit changed`,
    };
  return null;
}
