import {
  readdirSync,
  statSync,
  existsSync,
  createReadStream,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  ChatSummary,
  ChatMessage,
  ChatBlock,
  ChatMessagesPage,
  MessageUsage,
} from '@claude-control/contracts';
import { isSandboxPath } from './ChatArtifacts.ts';

/**
 * Чтение истории разговоров Claude Code из ~/.claude/projects.
 *
 * Транскрипт — это JSON Lines, куда строки только дописываются. Файлы бывают
 * очень большими (медиана около двух мегабайт, отдельные — за сотню), поэтому
 * читать их целиком ради строки в списке нельзя: для списка берём начало и
 * конец файла, а разобранное держим в кеше по времени изменения.
 */

/** Файл больше этого размера не читается целиком — только начало и хвост. */
const FULL_READ_LIMIT = 4 * 1024 * 1024;
/** Сколько байт хвоста читать у большого файла. */
const TAIL_BYTES = 1024 * 1024;
/** Сколько первых строк достаточно, чтобы найти первую реплику человека. */
const HEAD_LINES = 300;
/** Сколько последних сообщений отдавать в ленту чата. */
const MESSAGE_LIMIT = 400;

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
    return cached.summary;
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
    messageCount: records.filter(isDialogMessage).length,
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
  return summary;
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

  const records = readRecords(path, statSync(path).size);
  return lastValue(records, (record) => record.cwd);
}

export function findTranscript(projectsDir: string, chatId: string): string | undefined {
  if (!existsSync(projectsDir)) return undefined;

  const safeId = chatId.replace(/[^a-zA-Z0-9-]/g, '');
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const candidate = join(projectsDir, entry.name, `${safeId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}

interface Record {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  aiTitle?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isApiErrorMessage?: boolean;
  toolUseResult?: unknown;
  isSidechain?: boolean;
  message?: {
    role?: string;
    model?: string;
    content?: string | ContentBlock[];
    /** Расход на шаг — модель кладёт его рядом с ответом. */
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      /** Разбивка записи в кэш по сроку жизни: часовая стоит вдвое дороже. */
      cache_creation?: { ephemeral_1h_input_tokens?: number };
    };
  };
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  /** Идентификатор вызова инструмента — по нему результат сходится с вызовом. */
  id?: string;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
  source?: { type?: string; media_type?: string; data?: string };
  title?: string;
}

/**
 * Разбор файла. Маленькие читаются целиком, у больших берём начало и хвост:
 * этого хватает и на заголовок, и на первую с последней репликой, а на файле
 * в сотню мегабайт полный проход занял бы секунды.
 */
function readRecords(path: string, sizeHint: number): Record[] {
  const size = sizeHint || statSync(path).size;

  if (size <= FULL_READ_LIMIT) return parseLines(readWholeFile(path));

  return [...parseLines(readHead(path)), ...parseLines(readTail(path, size))];
}

function parseLines(text: string): Record[] {
  const records: Record[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;

    try {
      records.push(JSON.parse(trimmed) as Record);
    } catch {
      // Обрезанная строка на границе куска — пропускаем.
    }
  }

  return records;
}

function readWholeFile(path: string): string {
  return readChunk(path, 0, statSync(path).size);
}

function readHead(path: string): string {
  const text = readChunk(path, 0, 512 * 1024);
  return text.split('\n').slice(0, HEAD_LINES).join('\n');
}

function readTail(path: string, size: number): string {
  return readChunk(path, Math.max(0, size - TAIL_BYTES), Math.min(TAIL_BYTES, size));
}

function readChunk(path: string, position: number, length: number): string {
  const handle = openSync(path, 'r');

  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(handle, buffer, 0, length, position);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(handle);
  }
}

/** Настоящая реплика диалога, а не служебная запись. */
/**
 * Расход на шаг из записи транскрипта.
 *
 * Только у ответов модели: реплика человека токенов не тратит, и бейдж «0» на
 * ней читался бы как сбой подсчёта, а не как «здесь нечего показывать».
 * Пустой usage (все четыре нуля) отбрасываем по той же причине.
 *
 * Стоимость здесь НЕ считается: тарифы живут в кэше прайса, до которого
 * добирается роут, — история о ценах ничего не знает.
 */
function toUsage(record: Record): MessageUsage | undefined {
  const usage = record.message?.usage;
  if (!usage) return undefined;

  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  if (!input && !output && !cacheRead && !cacheCreation) return undefined;

  const long = usage.cache_creation?.ephemeral_1h_input_tokens;
  return {
    input,
    output,
    cacheRead,
    cacheCreation,
    cacheCreation1h: long || undefined,
    model: record.message?.model,
  };
}

/**
 * Разговор стоит на вопросе к человеку.
 *
 * Смотрим последнюю запись СО СМЫСЛОМ (служебные — заголовок, отметка о
 * промпте — пропускаем, ветки субагентов тоже): если это вызов
 * `AskUserQuestion`, ответа за ним ещё нет — CLI пишет его следующей строкой,
 * сразу как человек выбрал вариант. Через `isDialogMessage` это не считается
 * намеренно: тот прячет результаты инструментов, и ответ на вопрос перестал бы
 * гасить признак.
 */
function isAwaitingReply(records: Record[]): boolean {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record?.message || record.isSidechain) continue;
    if (record.type !== 'assistant') return false;

    const content = record.message.content;
    if (!Array.isArray(content)) return false;
    return content.some((block) => block.type === 'tool_use' && block.name === 'AskUserQuestion');
  }

  return false;
}

function isDialogMessage(record: Record): boolean {
  if (record.type !== 'user' && record.type !== 'assistant') return false;
  if (record.isMeta || record.isCompactSummary || record.isApiErrorMessage) return false;
  // У результата инструмента есть разобранный результат — это не реплика.
  if (record.type === 'user' && record.toolUseResult !== undefined) return false;

  const content = record.message?.content;
  if (Array.isArray(content) && content.every((block) => block.type === 'tool_result'))
    return false;

  // Отметка самого CLI: в пакетном режиме он дописывает её в конец хода, когда
  // отвечать не на что. Репликой разговора она не является и в ленте только
  // разбивает переписку пустыми вставками.
  if (record.type === 'assistant' && textOf(record).trim() === 'No response requested.') {
    return false;
  }

  return true;
}

/**
 * Первые осмысленные слова человека — из них делается название чата, когда
 * Claude Code не успел придумать своё. Реплика нередко начинается со служебной
 * вставки среды (открытый файл, напоминание), после очистки от неё остаётся
 * пусто — поэтому идём по репликам, пока не найдётся непустой текст.
 */
function firstMeaningfulText(records: Record[]): string {
  for (const record of records) {
    if (!isDialogMessage(record) || record.type !== 'user') continue;

    const text = cleanText(textOf(record));
    if (text.length > 1) return text;
  }

  return '';
}

function toBlocks(record: Record): ChatBlock[] {
  const content = record.message?.content;
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];

  const blocks: ChatBlock[] = [];

  for (const block of content) {
    if (block.type === 'text' && block.text?.trim()) {
      blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'thinking' && block.thinking?.trim()) {
      blocks.push({ type: 'thinking', text: block.thinking });
    } else if (block.type === 'tool_use') {
      blocks.push({
        type: 'tool',
        name: block.name ?? '',
        input: JSON.stringify(block.input ?? {}),
      });
    } else if (block.type === 'image' && block.source?.data) {
      // Картинки лежат в транскрипте прямо в base64.
      blocks.push({
        type: 'image',
        source: `data:${block.source.media_type ?? 'image/png'};base64,${block.source.data}`,
      });
    } else if (block.type === 'document') {
      blocks.push({ type: 'text', text: `📎 ${block.title ?? 'документ'}` });
    }
  }

  return blocks;
}

function textOf(record: Record | undefined): string {
  if (!record) return '';

  const content = record.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  // Служебная вставка среды часто идёт отдельным блоком перед настоящим
  // текстом, поэтому склеиваем все текстовые блоки, а не берём первый.
  return content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join(' ');
}

/**
 * Служебные обёртки среды попадают в текст первой реплики и в названии чата
 * выглядят мусором, поэтому их вырезаем.
 */
function cleanText(text: string): string {
  return text
    .replace(/<(ide_[a-z_]+|command-[a-z]+|task-notification|system-reminder)>[\s\S]*?<\/\1>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lastValue<T>(records: Record[], pick: (record: Record) => T | undefined): T | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const value = record && pick(record);
    if (value !== undefined && value !== false) return value as T;
  }

  return undefined;
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

function fileSessionId(path: string): string {
  return path.split(/[\\/]/).pop()?.replace('.jsonl', '') ?? '';
}

async function* streamLines(path: string): AsyncGenerator<string> {
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }) });
  for await (const line of lines) yield line;
}
