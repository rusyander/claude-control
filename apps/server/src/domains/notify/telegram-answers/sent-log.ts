import { join } from 'node:path';
import { readJsonFile, writeJsonFile } from '../../../lib/safe-io/safe-io.ts';
import type { ChatRoute } from './telegram-answers.types.ts';

/**
 * Что бот писал в Telegram и какие команды ему слал владелец — номера
 * сообщений, без текста. Нужен команде /clear: бот удаляет только то, что
 * знает, а Telegram не даёт ни списка сообщений чата, ни удаления старше 48 часов.
 *
 * Пишут двое — уведомления (`telegram.ts`, рантайм) и опрос ответов (маршруты),
 * поэтому каждая операция читает и пишет файл заново: двум копиям в памяти
 * тут нечего сверять. Без каталога — только память (юниты).
 */

export const SENT_LOG_FILE = 'telegram-sent.json';
/** Старше Telegram удалять не даёт — такие записи не нужны. */
export const DELETE_WINDOW_MS = 48 * 3_600_000;
const MAX_ENTRIES = 2_000;

export interface SentEntry {
  chatId: string;
  messageId: number;
  /** Когда отправлено, мс. */
  at: number;
  /** Своё сообщение бота или команда владельца. */
  kind: 'bot' | 'owner';
  /** Куда уйдёт ответ-reply на это сообщение (уведомление о чате). */
  route?: ChatRoute;
}

export class SentLog {
  private readonly file: string | undefined;
  private memory: SentEntry[] = [];

  constructor(appDataDir?: string) {
    this.file = appDataDir ? join(appDataDir, SENT_LOG_FILE) : undefined;
  }

  private read(): SentEntry[] {
    if (!this.file) return this.memory;
    try {
      const raw = readJsonFile<unknown>(this.file, []);
      return Array.isArray(raw) ? (raw as SentEntry[]) : [];
    } catch {
      return [];
    }
  }

  private write(entries: SentEntry[], now: number): void {
    const kept = entries.filter((entry) => now - entry.at < DELETE_WINDOW_MS).slice(-MAX_ENTRIES);
    if (this.file) writeJsonFile(this.file, kept);
    else this.memory = kept;
  }

  record(entry: SentEntry): void {
    this.write([...this.read(), entry], entry.at);
  }

  /** Всё, что ещё можно удалить: моложе 48 часов. */
  list(now: number): SentEntry[] {
    return this.read().filter((entry) => now - entry.at < DELETE_WINDOW_MS);
  }

  /** Запись о сообщении бота — по ней reply владельца находит свой чат. */
  find(chatId: string, messageId: number, now: number): SentEntry | undefined {
    return this.list(now).find((entry) => entry.chatId === chatId && entry.messageId === messageId);
  }

  forget(chatId: string, messageIds: readonly number[], now: number): void {
    const gone = new Set(messageIds);
    this.write(
      this.read().filter((entry) => !(entry.chatId === chatId && gone.has(entry.messageId))),
      now,
    );
  }
}
