import type { DiskDraft } from './diskDraft.types';
import { sameText } from '@shared/lib/same-text';

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
