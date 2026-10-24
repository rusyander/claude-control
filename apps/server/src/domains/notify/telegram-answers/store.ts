import { renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  telegramAnswersSettingsSchema,
  type TelegramAnswersSettings,
} from '@agentdeck/contracts/telegram-answers';
import { readJsonFile, writeJsonFile } from '../../../lib/safe-io/safe-io.ts';
import { newSecret } from './callback-data.ts';
import type { AnswersFile, SentMessage } from './telegram-answers.types.ts';

/**
 * Память ответов из Telegram — один файл в каталоге данных панели: настройка,
 * номер следующего обновления Bot API, отправленные сообщения с их ожиданиями и
 * ключ подписи кнопок.
 *
 * На диске, а не в памяти: панель перезапускается посреди ожидания (правка
 * сервера, сон машины), а кнопка в Telegram остаётся. После перезапуска нажатие
 * обязано найти своё сообщение, а старое обновление — не прийти второй раз.
 */

export const ANSWERS_FILE = 'telegram-answers.json';
/** Сколько помнить закрытые сообщения и отправленные ожидания. */
const KEEP_MS = 7 * 24 * 3_600_000;
const MAX_MESSAGES = 200;

export class AnswersStore {
  private readonly file: string | undefined;
  private data: AnswersFile;

  /** Битый файл, отведённый при старте, — его имя (для человека: что настройка сброшена). */
  readonly lost: string | undefined;
  private readonly log: (message: string, detail?: unknown) => void;

  /** Без каталога — только память (юниты). */
  constructor(
    appDataDir?: string,
    log: (message: string, detail?: unknown) => void = (message, detail) =>
      console.warn(`[agentdeck] ${message}`, detail ?? ''),
  ) {
    this.file = appDataDir ? join(appDataDir, ANSWERS_FILE) : undefined;
    this.log = log;
    const { raw, lost } = this.readRaw();
    this.lost = lost;
    this.data = this.load(raw);
  }

  /**
   * Файл с диска. Битый (обрыв записи, сбой диска) — в сторону как `.bad-…`, в
   * журнал, и старт с чистого: иначе исключение из конструктора роняло всю
   * панель при запуске (RF-DL-08, живой прогон T1) — тот же класс, что D-L06.
   */
  private readRaw(): { raw: Partial<AnswersFile> | null; lost?: string } {
    if (!this.file) return { raw: null };
    try {
      return { raw: readJsonFile<Partial<AnswersFile> | null>(this.file, null) };
    } catch (error) {
      const target = `${this.file}.bad-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      let kept: string | undefined;
      try {
        renameSync(this.file, target);
        kept = target;
      } catch {
        // Не вышло убрать — свежая запись ляжет поверх.
      }
      this.log(
        `telegram answers: ${this.file} is not readable, settings and sent messages start empty` +
          `${kept ? `, broken file kept as ${kept}` : ''}`,
        error instanceof Error ? error.message : error,
      );
      return { raw: null, lost: kept ?? this.file };
    }
  }

  private load(raw: Partial<AnswersFile> | null): AnswersFile {
    const settings = telegramAnswersSettingsSchema.safeParse(raw?.settings ?? {});
    const fresh: AnswersFile = {
      version: 1,
      secret: typeof raw?.secret === 'string' && raw.secret.length >= 32 ? raw.secret : newSecret(),
      offset: Number.isSafeInteger(raw?.offset) ? (raw!.offset as number) : 0,
      nextSid: Number.isSafeInteger(raw?.nextSid) ? (raw!.nextSid as number) : 1,
      settings: settings.success ? settings.data : telegramAnswersSettingsSchema.parse({}),
      messages: Array.isArray(raw?.messages) ? (raw!.messages as SentMessage[]) : [],
      sent: raw?.sent && typeof raw.sent === 'object' ? { ...raw.sent } : {},
      ...(typeof raw?.lastSentAt === 'number' ? { lastSentAt: raw.lastSentAt } : {}),
    };
    // Ключ подписи заводится один раз и сразу ложится на диск: иначе кнопки
    // сообщения, отправленного до перезапуска, перестали бы сходиться.
    if (fresh.secret !== raw?.secret && this.file) writeJsonFile(this.file, fresh);
    return fresh;
  }

  save(): void {
    this.prune();
    if (this.file) writeJsonFile(this.file, this.data);
  }

  private prune(now = Date.now()): void {
    const old = (iso: string | undefined): boolean => !iso || now - Date.parse(iso) > KEEP_MS;
    this.data.messages = this.data.messages
      .filter((message) => !(message.closedAt && old(message.closedAt)) && !old(message.sentAt))
      .slice(-MAX_MESSAGES);
    for (const [key, at] of Object.entries(this.data.sent)) {
      if (old(at)) delete this.data.sent[key];
    }
  }

  get secret(): string {
    return this.data.secret;
  }

  get settings(): TelegramAnswersSettings {
    return { ...this.data.settings };
  }

  setSettings(settings: TelegramAnswersSettings): void {
    this.data.settings = { ...settings };
    this.save();
  }

  get offset(): number {
    return this.data.offset;
  }

  setOffset(offset: number): void {
    if (offset <= this.data.offset) return;
    this.data.offset = offset;
    this.save();
  }

  nextSid(): string {
    const sid = this.data.nextSid.toString(36);
    this.data.nextSid += 1;
    return sid;
  }

  messages(): SentMessage[] {
    return this.data.messages;
  }

  open(): SentMessage[] {
    return this.data.messages.filter((message) => !message.closedAt);
  }

  bySid(sid: string): SentMessage | undefined {
    return this.data.messages.find((message) => message.sid === sid);
  }

  add(message: SentMessage, now = Date.now()): void {
    this.data.messages.push(message);
    const at = new Date(now).toISOString();
    for (const item of message.items) this.data.sent[item.key] = at;
    this.data.lastSentAt = now;
    this.save();
  }

  wasSent(key: string): boolean {
    return key in this.data.sent;
  }

  get lastSentAt(): number | undefined {
    return this.data.lastSentAt;
  }

  /** Сколько ожиданий ждёт ответа в Telegram прямо сейчас. */
  openItems(): number {
    return this.open().reduce(
      (sum, message) => sum + message.items.filter((item) => item.state === 'open').length,
      0,
    );
  }
}
