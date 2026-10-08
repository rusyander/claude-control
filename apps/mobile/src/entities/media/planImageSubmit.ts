import type { MediaImagePlan } from '@agentdeck/contracts';

/** Что сделает отправка в режиме картинки. */
export type ImageAction =
  /** Просьбу агенту собирает сервер (`/media/prompt`), уходит обычным сообщением. */
  | { road: 'agent'; topic: string }
  /** Панель рисует сама: результат — файл и карточка, не реплика в переписке. */
  | { road: 'image'; prompt: string };

/**
 * Дорога отправки. Пусто — нечего делать (пустое поле или план не приехал):
 * доступность второй раз не проверяется, запертый пункт до отправки не доходит.
 */
export function planImageSubmit(
  plan: MediaImagePlan | undefined,
  text: string,
): ImageAction | undefined {
  const asked = text.trim();
  if (!asked || !plan?.available) return undefined;
  return plan.source === 'agent'
    ? { road: 'agent', topic: asked }
    : { road: 'image', prompt: asked };
}
