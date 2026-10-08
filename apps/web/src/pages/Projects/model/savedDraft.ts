import type { DiskDraft } from './diskDraft.types';

/**
 * Сохранение прошло. Черновик теперь начат от отправленного текста: набранное
 * после нажатия — правка поверх своей записи, а не поверх чужой. Сам черновик
 * снимает ответ GET (`settleDraft`), а не этот шаг: снятый здесь, он уступил бы
 * редактор тексту диска до того, как тот перечитан.
 */
export function savedDraft(current: DiskDraft | undefined, sent: string): DiskDraft | undefined {
  return current && { value: current.value, base: sent };
}
