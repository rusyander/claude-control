import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  ProviderChatDetail,
  ProviderChatMessage,
  ProviderChatSummary,
} from '@claude-control/contracts';

/**
 * Переписка чужого провайдера на диске: один файл JSONL на разговор, рядом с
 * состоянием панели (`<appData>/provider-chats/<провайдер>/<id>.jsonl`).
 *
 * Почему панель вообще что-то хранит сама — при том что её принцип «источник
 * правды это файлы CLI». У Claude переписку ведёт он сам, и панель её читает. У
 * остальных CLI такой истории либо нет, либо её формат не задокументирован —
 * значит, либо панель ведёт свою, либо у чужого провайдера не может быть ни
 * списка разговоров, ни продолжения вчерашнего, ни памяти между вопросами.
 * Формат простой и наш собственный: ничего чужого здесь не разбирается.
 *
 * Первая строка файла — запись `meta`, дальше по строке на реплику. Дописывание
 * реплики — это `append` одной строки: обрыв на середине портит ровно последнюю
 * строку, а не весь разговор, и чтение её просто пропустит.
 */

/** Запись файла: шапка разговора либо одна реплика. */
interface MetaRecord {
  kind: 'meta';
  id: string;
  providerId: string;
  title: string;
  createdAt: string;
  workdir?: string;
}

interface MessageRecord extends ProviderChatMessage {
  kind: 'message';
}

/**
 * Идентификатор разговора и провайдера уходят в путь файла, поэтому набор
 * символов узкий: буквы, цифры, дефис и подчёркивание. Точки нет намеренно —
 * с ней пришлось бы отдельно ловить `..`, а так вырваться из каталога нечем.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function isSafeId(value: string): boolean {
  return SAFE_ID.test(value);
}

function providerDir(appDataDir: string, providerId: string): string | undefined {
  return isSafeId(providerId) ? join(appDataDir, 'provider-chats', providerId) : undefined;
}

function chatFile(appDataDir: string, providerId: string, chatId: string): string | undefined {
  const dir = providerDir(appDataDir, providerId);
  return dir && isSafeId(chatId) ? join(dir, `${chatId}.jsonl`) : undefined;
}

/** Название по первому вопросу: список разговоров должен читаться без открытия. */
export function titleFromText(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  if (!line) return 'Без названия';
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

function readRecords(file: string): { meta?: MetaRecord; messages: ProviderChatMessage[] } {
  const messages: ProviderChatMessage[] = [];
  let meta: MetaRecord | undefined;

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const record = JSON.parse(text) as MetaRecord | MessageRecord;
      if (record.kind === 'meta') meta = record;
      else if (record.kind === 'message') {
        const { kind: _kind, ...message } = record;
        messages.push(message);
      }
    } catch {
      // Оборванная последняя строка (сервер сняли посреди записи) — пропускаем
      // её, а не теряем разговор целиком.
    }
  }

  return { meta, messages };
}

function toSummary(meta: MetaRecord, messages: ProviderChatMessage[]): ProviderChatSummary {
  return {
    id: meta.id,
    providerId: meta.providerId,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: messages.at(-1)?.at ?? meta.createdAt,
    messageCount: messages.length,
    ...(meta.workdir ? { workdir: meta.workdir } : {}),
  };
}

/** Новый разговор. Идентификатор придумывается здесь же и уходит в имя файла. */
export function createChat(
  appDataDir: string,
  providerId: string,
  options: { title?: string; workdir?: string; now?: Date; id?: string } = {},
): ProviderChatSummary | undefined {
  const dir = providerDir(appDataDir, providerId);
  if (!dir) return undefined;

  const id = options.id ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  if (!isSafeId(id)) return undefined;

  const meta: MetaRecord = {
    kind: 'meta',
    id,
    providerId,
    title: options.title?.trim() || 'Новый разговор',
    createdAt: (options.now ?? new Date()).toISOString(),
    ...(options.workdir ? { workdir: options.workdir } : {}),
  };

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify(meta)}\n`, 'utf8');

  return toSummary(meta, []);
}

/** Все разговоры провайдера, свежие сверху. */
export function listChats(appDataDir: string, providerId: string): ProviderChatSummary[] {
  const dir = providerDir(appDataDir, providerId);
  if (!dir || !existsSync(dir)) return [];

  const summaries: ProviderChatSummary[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      const { meta, messages } = readRecords(join(dir, name));
      if (meta) summaries.push(toSummary(meta, messages));
    } catch {
      // Нечитаемый файл не должен прятать остальные разговоры.
    }
  }

  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Разговор целиком: шапка и все реплики. */
export function readChat(
  appDataDir: string,
  providerId: string,
  chatId: string,
): ProviderChatDetail | undefined {
  const file = chatFile(appDataDir, providerId, chatId);
  if (!file || !existsSync(file)) return undefined;

  try {
    const { meta, messages } = readRecords(file);
    if (!meta) return undefined;
    return { ...toSummary(meta, messages), messages };
  } catch {
    return undefined;
  }
}

/** Дописать реплику. Возвращает её же — с проставленными id и временем. */
export function appendMessage(
  appDataDir: string,
  providerId: string,
  chatId: string,
  message: Omit<ProviderChatMessage, 'id' | 'at'> & { id?: string; at?: string },
): ProviderChatMessage | undefined {
  const file = chatFile(appDataDir, providerId, chatId);
  if (!file || !existsSync(file)) return undefined;

  const stored: ProviderChatMessage = {
    ...message,
    id: message.id ?? `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    at: message.at ?? new Date().toISOString(),
  };

  appendFileSync(file, `${JSON.stringify({ kind: 'message', ...stored })}\n`, 'utf8');

  // Первый вопрос даёт разговору название — но только если своего ещё нет.
  if (stored.role === 'user') {
    const { meta, messages } = readRecords(file);
    if (meta && meta.title === 'Новый разговор' && messages.length === 1) {
      writeMeta(file, { ...meta, title: titleFromText(stored.content) }, messages);
    }
  }

  return stored;
}

/**
 * Переписать шапку. Файл собирается заново и подменяется целиком: шапка — первая
 * строка, дописыванием её не поправить. Запись идёт во временный файл рядом и
 * переименованием на место, чтобы обрыв не оставил половину разговора.
 */
function writeMeta(file: string, meta: MetaRecord, messages: ProviderChatMessage[]): void {
  const lines = [
    JSON.stringify(meta),
    ...messages.map((message) => JSON.stringify({ kind: 'message', ...message })),
  ];
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${lines.join('\n')}\n`, 'utf8');
  renameSync(temp, file);
}

/** Переименовать разговор или сменить его рабочий каталог. */
export function patchChat(
  appDataDir: string,
  providerId: string,
  chatId: string,
  patch: { title?: string; workdir?: string },
): ProviderChatSummary | undefined {
  const file = chatFile(appDataDir, providerId, chatId);
  if (!file || !existsSync(file)) return undefined;

  const { meta, messages } = readRecords(file);
  if (!meta) return undefined;

  const title = patch.title?.trim();
  const next: MetaRecord = {
    ...meta,
    ...(title ? { title } : {}),
    // Пустая строка — осознанное «без каталога», поэтому отличается от «поле не прислали».
    ...(patch.workdir === undefined ? {} : patch.workdir ? { workdir: patch.workdir } : {}),
  };
  if (patch.workdir === '') delete next.workdir;

  writeMeta(file, next, messages);

  return toSummary(next, messages);
}

/** Удалить разговор вместе с файлом. */
export function deleteChat(appDataDir: string, providerId: string, chatId: string): boolean {
  const file = chatFile(appDataDir, providerId, chatId);
  if (!file || !existsSync(file)) return false;

  rmSync(file, { force: true });
  return true;
}
