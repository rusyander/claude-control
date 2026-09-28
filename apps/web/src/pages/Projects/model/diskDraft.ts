import { sameText } from '@shared/lib/same-text';

/**
 * Черновик файла, который лежит на диске и который правят не только здесь:
 * агент, редактор, соседнее окно. `base` — текст диска, от которого черновик
 * начат: разошёлся с диском — «Сохранить» заменит чужую запись, и страница
 * обязана это сказать.
 *
 * Все сравнения — без учёта переносов строк (`sameText`): поле отдаёт LF, файл
 * на Windows — CRLF, и после сохранения GET приносит CRLF обратно.
 */
export interface DiskDraft {
  value: string;
  base: string;
}

/**
 * Правка человека. Текст, совпавший с диском, — уже не черновик: иначе он
 * пережил бы внешнюю запись и молча вернул старое по «Сохранить».
 */
export function editDraft(
  current: DiskDraft | undefined,
  next: string,
  disk: string | undefined,
): DiskDraft | undefined {
  if (disk !== undefined && sameText(next, disk)) return undefined;
  return { value: next, base: current?.base ?? disk ?? '' };
}

/**
 * Диск сменился. Черновик, равный новому тексту (своё сохранение вернулось с
 * CRLF, или тот же текст записан извне), снимается — редактор уже показывает
 * этот текст, перечитывать его незачем. Без черновика редактор берёт новый
 * текст (`reload`). Черновик с другим текстом остаётся: поверх набранного
 * ничего не подменяется, а расхождение видно через `isChangedElsewhere`.
 */
export function settleDraft(
  current: DiskDraft | undefined,
  disk: string | undefined,
): { draft: DiskDraft | undefined; reload: boolean } {
  if (current === undefined) return { draft: undefined, reload: true };
  if (disk !== undefined && sameText(current.value, disk)) {
    return { draft: undefined, reload: false };
  }
  return { draft: current, reload: false };
}

/**
 * Сохранение прошло. Черновик теперь начат от отправленного текста: набранное
 * после нажатия — правка поверх своей записи, а не поверх чужой. Сам черновик
 * снимает ответ GET (`settleDraft`), а не этот шаг: снятый здесь, он уступил бы
 * редактор тексту диска до того, как тот перечитан.
 */
export function savedDraft(current: DiskDraft | undefined, sent: string): DiskDraft | undefined {
  return current && { value: current.value, base: sent };
}

/** Диск ушёл от текста, с которого начат черновик: сохранение заменит чужую запись. */
export function isChangedElsewhere(
  draft: DiskDraft | undefined,
  disk: string | undefined,
): boolean {
  if (draft === undefined || disk === undefined) return false;
  return !sameText(draft.base, disk) && !sameText(draft.value, disk);
}
