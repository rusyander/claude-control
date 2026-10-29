import { maskSecretsInText } from '@agentdeck/dlp/secret-mask';
import { telegramApiBase } from '../telegram-api.ts';
import { callBot } from './bot-api.ts';
import { escapeHtml } from './html.ts';
import type { BotMessage, ChatRoute } from './telegram-answers.types.ts';

/**
 * Ответ владельца ответом (reply) на сообщение бота — текст и картинки, которые
 * уходят в чат панели (решение владельца 25.10.2026, пункты A4 и 14).
 *
 * Здесь всё, что не про очередь и не про состояние опроса: какие вложения
 * берутся, как они качаются из Telegram, как называются в чате, что бот
 * отвечает одной строкой. Потерь молча нет: всё, что не ушло, названо в ответе.
 */

/** Файл для `/api/chat/send` — та же форма, что у вложения из окна панели. */
export interface ChatFile {
  name: string;
  base64: string;
}

/** Одно вложение сообщения: самый крупный размер фото или документ. */
export interface MediaRef {
  fileId: string;
  size?: number;
  /** Картинка (фото или документ image/*) или PDF. */
  kind: 'image' | 'pdf';
  ext: string;
}

/** Что из вложений не ушло и почему — для строки ответа. */
export interface MediaSkips {
  /** Больше 20 МБ одно или все вместе. */
  tooBig: number;
  /** Не картинка и не PDF (видео, голос, архив). */
  wrongType: number;
  /** Telegram не отдал файл. */
  failed: number;
}

/**
 * 20 МБ — потолок `getFile` в Bot API: больше Telegram боту не отдаёт. Им же
 * ограничена сумма одного ответа: вложение уходит в тело `/api/chat/send`.
 */
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

/** Вложения одного сообщения; неподходящие — счётом в `wrongType`. */
export function mediaOf(message: BotMessage): { refs: MediaRef[]; wrongType: number } {
  const refs: MediaRef[] = [];
  let wrongType = 0;
  const biggest = message.photo?.at(-1);
  if (biggest?.file_id) {
    refs.push({
      fileId: biggest.file_id,
      kind: 'image',
      ext: 'jpg',
      ...(biggest.file_size !== undefined ? { size: biggest.file_size } : {}),
    });
  }
  const doc = message.document;
  if (doc?.file_id) {
    const mime = doc.mime_type ?? '';
    const size = doc.file_size !== undefined ? { size: doc.file_size } : {};
    if (mime === 'application/pdf')
      refs.push({ fileId: doc.file_id, kind: 'pdf', ext: 'pdf', ...size });
    else if (mime.startsWith('image/')) {
      refs.push({ fileId: doc.file_id, kind: 'image', ext: IMAGE_EXT[mime] ?? 'jpg', ...size });
    } else wrongType += 1;
  }
  // Видео, голос, стикер — не вложение для агента, но и не тишина.
  if (!biggest && !doc && hasOtherMedia(message)) wrongType += 1;
  return { refs, wrongType };
}

function hasOtherMedia(message: BotMessage): boolean {
  return ['video', 'voice', 'audio', 'sticker', 'animation', 'video_note'].some(
    (key) => key in message,
  );
}

const pad = (value: number) => String(value).padStart(2, '0');

/** «telegram-20261025-154210-1.jpg» — время прихода по часам машины. */
export function mediaName(at: number, index: number, ext: string): string {
  const date = new Date(at);
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `telegram-${day}-${time}-${index}.${ext}`;
}

/**
 * Скачать вложения: `getFile`, затем сам файл. Больше 20 МБ — по размеру из
 * сообщения или из `getFile`, до скачивания; сумма сверх 20 МБ — остаток не
 * качается. Отказ Telegram — счётом, без повторов.
 */
export async function downloadMedia(
  token: string,
  refs: readonly MediaRef[],
  at: number,
): Promise<{ files: ChatFile[]; kinds: MediaRef['kind'][]; skips: MediaSkips }> {
  const files: ChatFile[] = [];
  const kinds: MediaRef['kind'][] = [];
  const skips: MediaSkips = { tooBig: 0, wrongType: 0, failed: 0 };
  let total = 0;
  for (const ref of refs) {
    if ((ref.size ?? 0) > MAX_MEDIA_BYTES || total + (ref.size ?? 0) > MAX_MEDIA_BYTES) {
      skips.tooBig += 1;
      continue;
    }
    const info = await callBot<{ file_path?: string; file_size?: number }>(token, 'getFile', {
      file_id: ref.fileId,
    });
    if (!info.ok || !info.result.file_path) {
      skips.failed += 1;
      continue;
    }
    const size = info.result.file_size ?? ref.size ?? 0;
    if (size > MAX_MEDIA_BYTES || total + size > MAX_MEDIA_BYTES) {
      skips.tooBig += 1;
      continue;
    }
    const body = await fetchFile(token, info.result.file_path);
    if (!body || total + body.length > MAX_MEDIA_BYTES) {
      if (body) skips.tooBig += 1;
      else skips.failed += 1;
      continue;
    }
    total += body.length;
    kinds.push(ref.kind);
    files.push({ name: mediaName(at, files.length + 1, ref.ext), base64: body.toString('base64') });
  }
  return { files, kinds, skips };
}

/** Сам файл. Токен — часть адреса: ни адрес, ни текст сбоя никуда не пишутся. */
async function fetchFile(token: string, path: string): Promise<Buffer | undefined> {
  try {
    const response = await fetch(`${telegramApiBase()}/file/bot${token}/${path}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return undefined;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return undefined;
  }
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** «2 картинки + PDF + текст». */
export function sentParts(kinds: readonly MediaRef['kind'][], hasText: boolean): string {
  const images = kinds.filter((kind) => kind === 'image').length;
  const pdfs = kinds.length - images;
  const parts: string[] = [];
  if (images) parts.push(`${images} ${plural(images, 'картинка', 'картинки', 'картинок')}`);
  if (pdfs) parts.push(pdfs === 1 ? 'PDF' : `${pdfs} PDF`);
  if (hasText) parts.push('текст');
  return parts.join(' + ');
}

/** Что не ушло — хвостом строки ответа. */
export function skipNotes(skips: MediaSkips): string[] {
  const notes: string[] = [];
  if (skips.tooBig) notes.push(`больше 20 МБ — не передано: ${skips.tooBig}`);
  if (skips.wrongType) notes.push(`не картинка и не PDF — не передано: ${skips.wrongType}`);
  if (skips.failed) notes.push(`Telegram не отдал файл: ${skips.failed}`);
  return notes;
}

export const OUTSIDE_MEDIA_NOTE = 'картинки сюда не передаются — только текст';
/** Сессии вне панели пришли одни картинки — отправлять нечего. */
export const OUTSIDE_MEDIA_ONLY = 'Картинки сюда не передаются — только текст.';

/** Имя чата в ответе бота: секреты закрыты, разметка экранирована. */
export function chatName(route: ChatRoute): string {
  const title = maskSecretsInText(route.title?.trim() || 'чат');
  return escapeHtml(title.length > 60 ? `${title.slice(0, 59)}…` : title);
}

/** Строка ответа бота после отправки в чат. */
export function sentAck(
  route: ChatRoute,
  kinds: readonly MediaRef['kind'][],
  hasText: boolean,
  notes: readonly string[],
): string {
  const head =
    kinds.length > 0
      ? `📎 Отправлено в «${chatName(route)}»: ${sentParts(kinds, hasText)}`
      : `✉️ Отправлено в «${chatName(route)}»`;
  return [head, ...notes].join(' · ');
}

export const UNMAPPED_REPLY =
  'Не понял, в какой чат это отправить: ответьте (reply) на сообщение бота о нужном чате или откройте панель.';
export const EMPTY_REPLY = 'Отправлять нечего: нужен текст, картинка или PDF.';
export const sendFailed = (route: ChatRoute) =>
  `Не получилось отправить в «${chatName(route)}» — откройте панель.`;

/**
 * Альбом приходит сообщениями по одному с общим `media_group_id`. Собираем их
 * 1,5 с с последнего и отдаём разом: одна отправка в чат, одна строка ответа.
 */
export class AlbumBuffer {
  private readonly groups = new Map<
    string,
    { messages: BotMessage[]; timer: ReturnType<typeof setTimeout> }
  >();

  private readonly waitMs: number;

  constructor(waitMs: number) {
    this.waitMs = waitMs;
  }

  add(group: string, message: BotMessage, flush: (messages: BotMessage[]) => void): void {
    const known = this.groups.get(group);
    if (known) clearTimeout(known.timer);
    const messages = [...(known?.messages ?? []), message];
    const timer = setTimeout(() => {
      this.groups.delete(group);
      flush(messages);
    }, this.waitMs);
    timer.unref?.();
    this.groups.set(group, { messages, timer });
  }

  stop(): void {
    for (const { timer } of this.groups.values()) clearTimeout(timer);
    this.groups.clear();
  }
}
