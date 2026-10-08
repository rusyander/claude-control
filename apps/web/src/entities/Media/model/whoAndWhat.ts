import type { Translate } from './media-mode.types';

/** Кто и какой моделью. Модели может не быть — выдумывать её имя нельзя. */
export function whoAndWhat(title: string, model: string, t: Translate): string {
  return model ? t('chat.mode.source', { title, model }) : t('chat.mode.sourceNoModel', { title });
}
