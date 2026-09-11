import { parseForeignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type { ChatEvent } from './chat-events.ts';
import { reviewNoticeText } from './split-review.ts';

export interface ParentNoticeDeps {
  /**
   * Событие в ленту прогона Claude. `false` — прогона у родителя нет, и сказать
   * ему сейчас некуда.
   */
  emitRun: (chatId: string, event: ChatEvent) => boolean;
  /**
   * Реплика в хранилище чужого провайдера. `false` — разговора нет (удалён,
   * хранилище недоступно), и факт тоже остаётся несказанным.
   */
  appendForeign: (providerId: string, chatId: string, text: string) => boolean;
}

/**
 * Слова панели в ленту РОДИТЕЛЯ разделения — каким бы провайдером он ни был.
 *
 * Развилка здесь, а не у каждого, кому есть что сказать: у Claude лента родителя
 * — это события идущего прогона (буфер реестра + живые слушатели), у чужого CLI
 * прогона в реестре нет вовсе, и лента у него — реплики его собственного
 * хранилища. Тому, кто считает пересечения веток или ведёт ревью, эта разница
 * безразлична: он говорит родителю и узнаёт, вышло ли.
 *
 * Ответ важен по существу: `false` означает «сказать было некуда», и домен
 * тогда НЕ отмечает факт сказанным — заметка догонит при следующем пересчёте.
 */
export function createParentNotice(
  deps: ParentNoticeDeps,
): (parentChatId: string, event: ChatEvent) => boolean {
  return (parentChatId, event) => {
    const foreign = parseForeignChatKey(parentChatId);
    if (!foreign) return deps.emitRun(parentChatId, event);
    // Переносится ТЕКСТ: остальные поля события описывают прогон, которого у
    // чужого родителя нет. Ревью — исключение по необходимости: полей у него
    // много, а лента чужого родителя умеет только строку, и её собирает
    // словарь самого ревью. Сказать нечем — молчим.
    const text =
      'text' in event ? event.text : event.kind === 'review' ? reviewNoticeText(event) : '';
    if (!text) return false;
    return deps.appendForeign(foreign.providerId, foreign.chatId, text);
  };
}
