import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
 * Очередь — на сервере, как у Claude (`queueIfBusy`): её видят все вкладки и
 * телефон. И на диске (Ф13): перезапуск панели снимает идущий ответ, но не
 * написанное человеком — после него очередь видна «ждёт отправки» и уходит по
 * кнопке. Опции отправки на диск не пишутся: они собираются заново маршрутом
 * в момент отправки.
 */
export interface QueuedForeignSend<D> extends ProviderChatQueued {
  providerId: string;
  appDataDir: string;
  /**
   * Опции отправки, собранные маршрутом в момент постановки. Нет — сообщение
   * пережило перезапуск: отправка берёт опции хода, который его отпускает, или
   * маршрута кнопки «Отправить».
   */
  deps?: D;
}

/** Файл очередей в каталоге данных панели: `providerId:chatId → сообщения`. */
export const FOREIGN_QUEUE_FILE = 'provider-chat-queue.json';

type Stored = ProviderChatQueued & { providerId: string };

function readFile(appDataDir: string): Record<string, Stored[]> {
  try {
    const parsed = JSON.parse(
      readFileSync(join(appDataDir, FOREIGN_QUEUE_FILE), 'utf8'),
    ) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, Stored[]>) : {};
  } catch {
    return {};
  }
}

function writeFile(appDataDir: string, data: Record<string, Stored[]>): void {
  const target = join(appDataDir, FOREIGN_QUEUE_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(appDataDir, { recursive: true });
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(temp, target);
  } catch {
    // Диск недоступен — очередь живёт в памяти, как раньше; ход это не ломает.
  }
}

const keyOf = (providerId: string, chatId: string): string => `${providerId}:${chatId}`;

export class ForeignSendQueue<D> {
  private readonly byChat = new Map<string, QueuedForeignSend<D>[]>();
  /** Где лежит очередь разговора на диске — и для пустой (снять запись). */
  private readonly where = new Map<string, { appDataDir: string; providerId: string }>();

  add(
    chatId: string,
    entry: Omit<QueuedForeignSend<D>, 'id' | 'at'>,
    now: Date = new Date(),
  ): ProviderChatQueued {
    this.hydrate(entry.appDataDir, entry.providerId, chatId);
    const item: QueuedForeignSend<D> = { ...entry, id: randomUUID(), at: now.toISOString() };
    this.store(chatId, [...(this.byChat.get(chatId) ?? []), item]);
    return publicView(item);
  }

  /**
   * Подтянуть очередь разговора с диска, если памяти о нём нет: после
   * перезапуска панели. Повторный вызов — ничего не делает.
   */
  hydrate(appDataDir: string, providerId: string, chatId: string): void {
    if (this.where.has(chatId)) return;
    this.where.set(chatId, { appDataDir, providerId });
    const stored = readFile(appDataDir)[keyOf(providerId, chatId)];
    if (!Array.isArray(stored) || stored.length === 0) return;
    this.byChat.set(
      chatId,
      stored
        .filter((item) => typeof item?.id === 'string' && typeof item.text === 'string')
        .map((item) => ({ ...item, providerId, appDataDir })),
    );
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

  /** Вынуть одно сообщение по id — кнопка «Отправить» у ждущей очереди. */
  take(chatId: string, id: string): QueuedForeignSend<D> | undefined {
    const items = this.byChat.get(chatId) ?? [];
    const item = items.find((entry) => entry.id === id);
    if (item)
      this.store(
        chatId,
        items.filter((entry) => entry !== item),
      );
    return item;
  }

  /** Следующее к отправке — вынуто из очереди. */
  shift(chatId: string): QueuedForeignSend<D> | undefined {
    const [next, ...rest] = this.byChat.get(chatId) ?? [];
    this.store(chatId, rest);
    return next;
  }

  /** Вернуть в начало: отправка не состоялась, а порядок человека важен. */
  unshift(chatId: string, item: QueuedForeignSend<D>): void {
    this.store(chatId, [item, ...(this.byChat.get(chatId) ?? [])]);
  }

  clear(chatId: string): void {
    this.store(chatId, []);
  }

  private store(chatId: string, items: QueuedForeignSend<D>[]): void {
    if (items.length > 0) this.byChat.set(chatId, items);
    else this.byChat.delete(chatId);
    const place = this.where.get(chatId) ?? items[0];
    if (!place) return;
    this.where.set(chatId, { appDataDir: place.appDataDir, providerId: place.providerId });
    const data = readFile(place.appDataDir);
    const key = keyOf(place.providerId, chatId);
    if (items.length > 0) {
      data[key] = items.map((item) => ({ ...publicView(item), providerId: item.providerId }));
    } else if (key in data) delete data[key];
    else return;
    writeFile(place.appDataDir, data);
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
