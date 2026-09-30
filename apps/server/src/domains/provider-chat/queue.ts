import { randomUUID } from 'node:crypto';
import type { ProviderChatQueued } from '@agentdeck/contracts';

/**
 * Сообщения, написанные чужому CLI, пока он отвечает.
 *
 * Прервать ответ новым сообщением у одноразового CLI нельзя: процесс получил
 * вопрос в argv и живёт до конца ответа, входа посреди хода у него нет. Раньше
 * кнопка отправки на это время просто гасла — и мысль человека ждала вместе с
 * ним. Теперь сообщение встаёт сюда и уходит САМО по концу ответа, тем же
 * путём, что обычная отправка (команды, строка каталога, маршрут контура — всё
 * решается в момент отправки, а не постановки).
 *
 * Очередь — на сервере и в памяти, как у Claude (`queueIfBusy`): её видят все
 * вкладки и телефон, а перезапуск панели снимает и сам ответ, к концу которого
 * она была привязана.
 */
export interface QueuedForeignSend<D> extends ProviderChatQueued {
  providerId: string;
  appDataDir: string;
  /** Опции отправки, собранные маршрутом в момент постановки. */
  deps: D;
}

export class ForeignSendQueue<D> {
  private readonly byChat = new Map<string, QueuedForeignSend<D>[]>();

  add(
    chatId: string,
    entry: Omit<QueuedForeignSend<D>, 'id' | 'at'>,
    now: Date = new Date(),
  ): ProviderChatQueued {
    const item: QueuedForeignSend<D> = { ...entry, id: randomUUID(), at: now.toISOString() };
    this.byChat.set(chatId, [...(this.byChat.get(chatId) ?? []), item]);
    return publicView(item);
  }

  /** Что показать человеку: без опций отправки — они внутренние. */
  list(chatId: string): ProviderChatQueued[] {
    return (this.byChat.get(chatId) ?? []).map(publicView);
  }

  cancel(chatId: string, id: string): boolean {
    const items = this.byChat.get(chatId) ?? [];
    const rest = items.filter((item) => item.id !== id);
    if (rest.length === items.length) return false;
    this.store(chatId, rest);
    return true;
  }

  /** Следующее к отправке — вынуто из очереди. */
  shift(chatId: string): QueuedForeignSend<D> | undefined {
    const [next, ...rest] = this.byChat.get(chatId) ?? [];
    this.store(chatId, rest);
    return next;
  }

  /** Вернуть в начало: отправка не состоялась, а порядок человека важен. */
  unshift(chatId: string, item: QueuedForeignSend<D>): void {
    this.byChat.set(chatId, [item, ...(this.byChat.get(chatId) ?? [])]);
  }

  clear(chatId: string): void {
    this.byChat.delete(chatId);
  }

  private store(chatId: string, items: QueuedForeignSend<D>[]): void {
    if (items.length > 0) this.byChat.set(chatId, items);
    else this.byChat.delete(chatId);
  }
}

function publicView<D>(item: QueuedForeignSend<D>): ProviderChatQueued {
  return {
    id: item.id,
    text: item.text,
    at: item.at,
    ...(item.attachments?.length ? { attachments: item.attachments } : {}),
  };
}
