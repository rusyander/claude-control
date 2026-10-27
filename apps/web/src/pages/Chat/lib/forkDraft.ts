import type { DraftBox } from '@shared/lib/draft';

/**
 * Пометка «следующая отправка — ветка» живёт, пока в поле лежит правленый текст.
 * Человек очистил поле — значит, раздумал править, и следующее сообщение должно
 * уйти в этот же разговор, а не плодить второй с тем же названием (Telegram 26.10,
 * R2: пометка переживала очистку поля, и обычное сообщение молча уходило веткой).
 * Возвращает отписку.
 */
export function watchForkDraft(draft: DraftBox, disarm: () => void): () => void {
  return draft.subscribe(() => {
    if (draft.get().trim() === '') disarm();
  });
}

export interface ForkAsk {
  /** Спросить человека; `true` — отправлять веткой. Новый вопрос снимает прежний отказом. */
  ask: () => Promise<boolean>;
  /** Ответ из окна подтверждения. Без открытого вопроса — ничего. */
  answer: (ok: boolean) => void;
}

/**
 * Вопрос «отправить веткой?» как обещание: отправка ждёт ответа, окно только
 * показывает вопрос. `onOpenChange` — состояние окна для React.
 */
export function createForkAsk(onOpenChange: (isOpen: boolean) => void): ForkAsk {
  let pending: ((ok: boolean) => void) | undefined;
  return {
    ask: () =>
      new Promise<boolean>((resolve) => {
        pending?.(false);
        pending = resolve;
        onOpenChange(true);
      }),
    answer: (ok) => {
      const resolve = pending;
      pending = undefined;
      onOpenChange(false);
      resolve?.(ok);
    },
  };
}
