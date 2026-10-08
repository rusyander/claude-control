import type { DiskDraft } from './diskDraft.types';
import { sameText } from '@shared/lib/same-text';

/** Диск ушёл от текста, с которого начат черновик: сохранение заменит чужую запись. */
export function isChangedElsewhere(
  draft: DiskDraft | undefined,
  disk: string | undefined,
): boolean {
  if (draft === undefined || disk === undefined) return false;
  return !sameText(draft.base, disk) && !sameText(draft.value, disk);
}
