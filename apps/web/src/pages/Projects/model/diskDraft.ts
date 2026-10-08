import { sameText } from '@shared/lib/same-text';
import type { DiskDraft } from './diskDraft.types';

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
