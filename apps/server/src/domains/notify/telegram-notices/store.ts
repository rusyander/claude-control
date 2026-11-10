import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile, writeJsonFile } from '../../../lib/safe-io/safe-io.ts';
import { newSecret } from '../telegram-answers/callback-data.ts';
import type { HeldLine, HeldNotice, NoticeMessage, NoticesFile } from './telegram-notices.types.ts';

/**
 * Запись уведомлений о задачах ядра (`<каталог данных>/telegram-notices.json`): отправленное (одно
 * уведомление на конец — и через перезапуск панели, P191), сообщения с кнопками `n:`, ключи повтора
 * команд, удержанное тихими часами (переживает перезапуск, P194).
 *
 * Один экземпляр на файл (`noticesStoreAt`): тот же файл пишут крючки бота ответов и уведомитель
 * прогонов (удержанное тишиной), и два экземпляра затирали бы друг друга.
 */

export const NOTICES_FILE = 'telegram-notices.json';

const MESSAGES_MAX = 300;
const SEEN_MAX = 2000;
const KEEP_MS = 14 * 24 * 60 * 60_000;

const record = <T>(value: unknown): Record<string, T> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, T>) }
    : {};
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? [...(value as T[])] : []);

export class NoticesStore {
  private readonly file: string | undefined;
  private data: NoticesFile;

  constructor(appDataDir: string | undefined, log: (message: string) => void = console.warn) {
    this.file = appDataDir ? join(appDataDir, NOTICES_FILE) : undefined;
    this.data = this.load(this.readRaw(log));
  }

  private readRaw(log: (message: string) => void): Partial<NoticesFile> | null {
    if (!this.file) return null;
    try {
      return readJsonFile<Partial<NoticesFile> | null>(this.file, null);
    } catch (error) {
      // Битый файл не роняет панель: в сторону, старт с чистого (как запись ответов).
      const target = `${this.file}.bad-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try {
        renameSync(this.file, target);
      } catch {
        // Не вышло убрать — свежая запись ляжет поверх.
      }
      log(`telegram notices: ${this.file} unreadable, starting empty (${String(error)})`);
      return null;
    }
  }

  private load(raw: Partial<NoticesFile> | null): NoticesFile {
    const fresh: NoticesFile = {
      version: 1,
      secret: typeof raw?.secret === 'string' && raw.secret.length >= 32 ? raw.secret : newSecret(),
      nextSid: Number.isSafeInteger(raw?.nextSid) ? (raw!.nextSid as number) : 1,
      sent: record<number>(raw?.sent),
      messages: list<NoticeMessage>(raw?.messages),
      cmds: record<string>(raw?.cmds),
      prompts: record(raw?.prompts),
      entries: record(raw?.entries),
      held: list<HeldNotice>(raw?.held),
      notifyHeld: list<HeldLine>(raw?.notifyHeld),
      seenEnded: list<string>(raw?.seenEnded),
      windowSeen: record<number>(raw?.windowSeen),
      watch: list(raw?.watch),
      ...(typeof raw?.lastPumpAt === 'number' ? { lastPumpAt: raw.lastPumpAt } : {}),
    };
    // Ключ подписи ложится на диск сразу: кнопки, отправленные до перезапуска, должны сходиться.
    if (fresh.secret !== raw?.secret && this.file) writeJsonFile(this.file, fresh);
    return fresh;
  }

  get file_(): NoticesFile {
    return this.data;
  }

  get secret(): string {
    return this.data.secret;
  }

  nextSid(): string {
    const sid = this.data.nextSid.toString(36);
    this.data.nextSid += 1;
    return sid;
  }

  wasSent(key: string): boolean {
    return key in this.data.sent;
  }

  markSent(key: string, at: number): void {
    this.data.sent[key] = at;
  }

  addMessage(message: NoticeMessage): void {
    this.data.messages.push(message);
    if (this.data.messages.length > MESSAGES_MAX) {
      this.data.messages.splice(0, this.data.messages.length - MESSAGES_MAX);
    }
  }

  message(sid: string): NoticeMessage | undefined {
    return this.data.messages.find((one) => one.sid === sid);
  }

  messageById(messageId: number): NoticeMessage | undefined {
    return this.data.messages.find((one) => one.messageId === messageId);
  }

  /** Ключ повтора действия: есть — тот же, нет — заводится этим (P47: повтор не исполняется). */
  cmdFor(key: string, mint: () => string): string {
    const known = this.data.cmds[key];
    if (known) return known;
    const fresh = mint();
    this.data.cmds[key] = fresh;
    return fresh;
  }

  /** Забыть ключ повтора: отказ полномочий / ядро недоступно — следующее нажатие с новым (m2). */
  forgetCmd(key: string): void {
    delete this.data.cmds[key];
  }

  /** Строки уведомителя прогонов, удержанные тишиной (`telegram.ts`). */
  heldLines(): HeldLine[] {
    return [...this.data.notifyHeld];
  }

  setHeldLines(lines: readonly HeldLine[]): void {
    this.data.notifyHeld = [...lines];
    this.save();
  }

  seenEnded(taskId: string): boolean {
    return this.data.seenEnded.includes(taskId);
  }

  markEnded(taskId: string): void {
    if (this.data.seenEnded.includes(taskId)) return;
    this.data.seenEnded.push(taskId);
    if (this.data.seenEnded.length > SEEN_MAX) {
      this.data.seenEnded.splice(0, this.data.seenEnded.length - SEEN_MAX);
    }
  }

  save(now: number = Date.now()): void {
    this.prune(now);
    if (this.file) writeJsonFile(this.file, this.data);
  }

  /** Старше двух недель — не нужно ни нажатию, ни повтору: файл не растёт без предела. */
  private prune(now: number): void {
    const fresh = (at: number) => now - at < KEEP_MS;
    for (const [key, at] of Object.entries(this.data.sent))
      if (!fresh(at)) delete this.data.sent[key];
    for (const [key, prompt] of Object.entries(this.data.prompts)) {
      if (!fresh(prompt.at)) delete this.data.prompts[key];
    }
    for (const [key, entry] of Object.entries(this.data.entries)) {
      if (!fresh(entry.at)) delete this.data.entries[key];
    }
    this.data.watch = this.data.watch.filter((item) => fresh(item.at));
    const live = new Set(this.data.messages.map((one) => one.sid));
    for (const key of Object.keys(this.data.cmds)) {
      const sid = key.split(':')[0] ?? '';
      if (!key.startsWith('tg:') && !live.has(sid)) delete this.data.cmds[key];
    }
  }
}

const stores = new Map<string, NoticesStore>();

/** Единственный экземпляр записи на каталог данных (крючки бота и уведомитель прогонов). */
export function noticesStoreAt(appDataDir: string): NoticesStore {
  let store = stores.get(appDataDir);
  if (!store) {
    store = new NoticesStore(appDataDir);
    stores.set(appDataDir, store);
  }
  return store;
}
