import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatSummary, ChatMessage, ChatMessagesPage } from '@claude-control/contracts';
import { isSandboxPath } from './ChatArtifacts.ts';
import {
  FULL_READ_LIMIT,
  fileSessionId,
  findTranscript,
  readRecords,
  readTailRecords,
  streamLines,
} from './ChatTranscriptFile.ts';
import {
  cleanText,
  countDialogMessages,
  firstMeaningfulText,
  isAwaitingReply,
  isDialogMessage,
  lastValue,
  textOf,
  toBlocks,
  toUsage,
  withAwaitingWindow,
  type ContentBlock,
  type Record,
} from './ChatRecords.ts';

/**
 * Чтение истории разговоров Claude Code из ~/.claude/projects.
 *
 * Транскрипт — это JSON Lines, куда строки только дописываются. Файлы бывают
 * очень большими (медиана около двух мегабайт, отдельные — за сотню), поэтому
 * читать их целиком ради строки в списке нельзя: для списка берём начало и
 * конец файла (`ChatTranscriptFile`), а разобранное держим в кеше по времени
 * изменения. Толкование записей живёт в `ChatRecords`.
 */

/** Сколько последних сообщений отдавать в ленту чата. */
const MESSAGE_LIMIT = 400;

export { findTranscript };

interface CacheEntry {
  mtimeMs: number;
  size: number;
  summary: ChatSummary;
}

const cache = new Map<string, CacheEntry>();

/**
 * Список чатов. Разговоры лежат в подкаталогах по проектам; вложенные папки
 * с ветками субагентов пропускаем — в списке нужны только сами сессии.
 */
export function readChats(projectsDir: string): ChatSummary[] {
  if (!existsSync(projectsDir)) return [];

  const chats: ChatSummary[] = [];

  for (const projectEntry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;

    const projectDir = join(projectsDir, projectEntry.name);
    for (const fileEntry of readdirSync(projectDir, { withFileTypes: true })) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) continue;

      const summary = readSummary(join(projectDir, fileEntry.name), projectEntry.name);
      if (summary) chats.push(summary);
    }
  }

  return chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function readSummary(path: string, projectName: string): ChatSummary | undefined {
  const stats = statSync(path);

  const cached = cache.get(path);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    // Окно ожидания считаем ПОСЛЕ кеша: сводка кешируется по времени файла и не
    // пересчитывается, а сутки идут — иначе вопрос оставался бы «свежим» вечно.
    return withAwaitingWindow(cached.summary, stats.mtimeMs);
  }

  const records = readRecords(path, stats.size);
  if (records.length === 0) return undefined;

  // Заголовок Claude Code генерирует сам и дописывает несколько раз —
  // верным считается последний.
  const title = lastValue(records, (record) =>
    record.type === 'ai-title' ? record.aiTitle : undefined,
  );
  const lastMessage = [...records].reverse().find(isDialogMessage);
  const projectPath = lastValue(records, (record) => record.cwd) ?? '';

  const summary: ChatSummary = {
    id: fileSessionId(path),
    title: title?.trim() || firstMeaningfulText(records).slice(0, 70) || projectName,
    project: projectName,
    projectPath,
    isSandbox: Boolean(projectPath) && isSandboxPath(projectPath),
    messageCount: countDialogMessages(records),
    // Большой файл прочитан началом и хвостом (см. readRecords) — значит
    // середина не сосчитана. Отдаём это признаком, а не выдаём частичное число
    // за итог: в списке оно рисуется как «38+».
    messageCountPartial: stats.size > FULL_READ_LIMIT ? true : undefined,
    createdAt: records[0]?.timestamp ?? stats.birthtime.toISOString(),
    updatedAt: stats.mtime.toISOString(),
    preview: cleanText(textOf(lastMessage)).slice(0, 160) || undefined,
    model: lastValue(records, (record) => record.message?.model),
    awaitingReply: isAwaitingReply(records) || undefined,
  };

  cache.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, summary });
  return withAwaitingWindow(summary, stats.mtimeMs);
}

/** Параметры окна ленты: сколько сообщений отдать и сколько новых пропустить. */
export interface MessagesWindow {
  /** Размер окна — сколько реплик вернуть. */
  limit?: number;
  /** Сколько самых свежих реплик пропустить (0 — отдаём хвост ленты). */
  offset?: number;
}

/**
 * Переписка одного чата окном. Здесь, в отличие от списка, нужен полный проход
 * по файлу — иначе выпадут реплики из середины. Файл читается построчно, а в
 * памяти держится только нужное окно: транскрипт бывает стомегабайтным, и
 * тащить его в память целиком незачем.
 *
 * По умолчанию отдаётся хвост ленты (последние `limit` реплик). Более ранние
 * подгружаются увеличением `limit` («Загрузить ещё») либо сдвигом `offset` —
 * оба варианта окном, без чтения всего транскрипта в ответ.
 */
export async function readChatMessages(
  projectsDir: string,
  chatId: string,
  window: MessagesWindow = {},
): Promise<ChatMessagesPage> {
  const path = findTranscript(projectsDir, chatId);
  if (!path) return { messages: [], total: 0, hasMore: false };

  const limit = Math.max(1, Math.floor(window.limit ?? MESSAGE_LIMIT));
  const offset = Math.max(0, Math.floor(window.offset ?? 0));
  // Держим только последние (offset + limit) реплик: этого хватает, чтобы
  // вырезать нужное окно, а память не растёт с длиной транскрипта.
  const cap = offset + limit;

  const ring: ChatMessage[] = [];
  let total = 0;
  // Ход модели — несколько строк с одним `message.id`, по одной на блок
  // содержимого (см. countDialogMessages). В ленте это ОДНА реплика: иначе
  // размышление, вызов и текст одного хода шли тремя сообщениями, и у каждого
  // стоял свой бейдж с тем же самым расходом — в разы больше, чем потрачено.
  // Расход берём из последней строки хода: все они несут одинаковый.
  let tailId: string | undefined;

  for await (const line of streamLines(path)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;

    let record: Record;
    try {
      record = JSON.parse(trimmed) as Record;
    } catch {
      continue;
    }

    if (!isDialogMessage(record)) continue;

    const blocks = toBlocks(record);
    if (blocks.length === 0) continue;

    const messageId = record.type === 'assistant' ? record.message?.id : undefined;
    const tail = ring.at(-1);
    if (messageId && tail && tailId === messageId) {
      ring[ring.length - 1] = {
        ...tail,
        blocks: [...tail.blocks, ...blocks],
        usage: toUsage(record) ?? tail.usage,
      };
      continue;
    }

    tailId = messageId;
    total += 1;
    ring.push({
      id: record.uuid ?? String(total - 1),
      role: record.type === 'user' ? 'user' : 'assistant',
      blocks,
      timestamp: record.timestamp ?? '',
      parentId: record.parentUuid ?? undefined,
      usage: toUsage(record),
    });

    // Лишнее с начала выбрасываем сразу, не дожидаясь конца файла.
    if (ring.length > cap) ring.shift();
  }

  // Окно [start, endExcl) в абсолютных индексах ленты; `endExcl` отступает от
  // конца на offset, `start` — ещё на limit назад.
  const endExcl = Math.max(0, total - offset);
  const start = Math.max(0, endExcl - limit);
  const ringStart = total - ring.length;
  const messages = ring.slice(start - ringStart, endExcl - ringStart);

  return { messages, total, hasMore: start > 0 };
}

/**
 * Рабочая папка, из которой велась сессия.
 *
 * Claude Code привязывает сессию к каталогу: транскрипты разложены по папкам
 * вида `~/.claude/projects/<путь-с-заменёнными-разделителями>/`, и `--resume`
 * ищет сессию только среди сессий текущего каталога. Поэтому продолжать
 * разговор можно лишь оттуда, где он начинался, — этот путь и берём из самого
 * транскрипта, он записан в каждой строке.
 */
export function findSessionCwd(projectsDir: string, sessionId: string): string | undefined {
  const path = findTranscript(projectsDir, sessionId);
  if (!path) return undefined;

  // Хвоста хватает: `cwd` записан в КАЖДОЙ строке, а читать ради него весь
  // транскрипт (до четырёх мегабайт на каждую отправку) незачем. В хвосте
  // пусто — последние строки без `cwd` — тогда уже целиком.
  const fromTail = lastValue(readTailRecords(path), (record) => record.cwd);
  if (fromTail) return fromTail;

  const records = readRecords(path, statSync(path).size);
  return lastValue(records, (record) => record.cwd);
}

/**
 * Разобранный транскрипт для соседних разборщиков (прогресс агента). Читает тем
 * же способом, что и лента: маленький файл целиком, у большого — начало и хвост.
 */
export function readTranscriptRecords(path: string): TranscriptRecord[] {
  return readRecords(path, 0);
}

export type TranscriptRecord = Record;
export type TranscriptBlock = ContentBlock;
