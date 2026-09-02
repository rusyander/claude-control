/**
 * Сверка редактора с файлом на диске.
 *
 * В поле — текст пользователя, `baseline` — версия с диска, с которой поле в
 * последний раз совпадало. Файл меняется и мимо панели (редактор, раздел
 * «Правила» в соседней вкладке), и после собственного сохранения; наблюдатель
 * приносит новую версию, и надо решить, что с ней делать:
 *
 *  - поле чистое → берём версию с диска: показывать устаревший текст и
 *    помечать его «несохранёнными правками» было бы ложью;
 *  - в поле собственные правки, а диск ушёл вперёд → правки остаются, а
 *    расхождение видно (`hasConflict`): молча заменить — потерять работу,
 *    молча сохранить — затереть чужую;
 *  - диск стал равен полю (своё сохранение легло) → просто сверяемся.
 */
import { sameText } from '@shared/lib/same-text';

export interface EditorSync {
  value: string;
  baseline: string;
}

export { sameText };

export function isDirty(state: EditorSync, disk: string): boolean {
  return !sameText(state.value, disk);
}

/** Диск ушёл от сверенной версии, пока в поле были свои правки. */
export function hasConflict(state: EditorSync, disk: string): boolean {
  return !sameText(state.baseline, disk) && !sameText(state.value, state.baseline);
}

export function syncWithDisk(state: EditorSync | undefined, disk: string): EditorSync {
  if (!state || sameText(state.value, state.baseline) || sameText(state.value, disk)) {
    return { value: disk, baseline: disk };
  }
  return state;
}
