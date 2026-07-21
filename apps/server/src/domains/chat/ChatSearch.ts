import { readdirSync, statSync, existsSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ChatSearchHit, ChatSearchResponse } from '@claude-control/contracts';
import { readChats } from './ChatHistory.ts';

/**
 * Полнотекстовый поиск по телу переписки чата.
 *
 * Список чатов ищется по заголовку/проекту/превью — этого мало, чтобы найти
 * разговор по тому, что в нём обсуждали. Здесь сканируется САМО содержимое
 * сообщений: транскрипты Claude Code (JSON Lines) читаются построчно потоком,
 * из каждой реплики вынимается текст, и по нему ищется запрос.
 *
 * Производительность. Файлов бывают тысячи, отдельные — десятки мегабайт,
 * поэтому: (1) читаем построчно, не держа файл в памяти; (2) идём от свежих
 * файлов к старым и останавливаемся, набрав достаточно совпадений или пройдя
 * лимит файлов; (3) сверх-длинные строки (base64-картинки, дампы инструментов)
 * пропускаем; (4) перед разбором строки делаем дешёвую проверку сырого текста —
 * нет запроса в строке, нет и смысла её парсить. Служебные записи (мета,
 * результаты инструментов) в поиск не попадают — только реплики диалога.
 *
 * Чистая логика (разбор строки, сборка сниппета, подсчёт совпадений) вынесена
 * отдельными функциями и покрыта тестами без чтения диска.
 */

/** Короче этого запрос неинформативен — поиск не запускаем. */
export const MIN_QUERY_LENGTH = 2;
/** Сколько разговоров-совпадений максимум вернуть. */
const MAX_HITS = 40;
/** Сколько файлов максимум просмотреть — защита от гигантской истории. */
const MAX_FILES = 600;
/** Строки длиннее — почти всегда base64/дамп инструмента, в них не ищем. */
const MAX_LINE_LENGTH = 200_000;
/** Полуокно сниппета вокруг совпадения (символов с каждой стороны). */
const SNIPPET_RADIUS = 48;

interface TranscriptRecord {
  type?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isApiErrorMessage?: boolean;
  toolUseResult?: unknown;
  message?: { role?: string; content?: string | ContentBlock[] };
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
}

export interface MessageText {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Текст реплики диалога — или undefined, если строка служебная и в поиск не
 * идёт. Берём текст и размышления (их видно в ленте), а вызовы инструментов,
 * результаты инструментов, мета-записи и системные вставки пропускаем.
 */
export function messageText(record: TranscriptRecord): MessageText | undefined {
  if (record.type !== 'user' && record.type !== 'assistant') return undefined;
  if (record.isMeta || record.isCompactSummary || record.isApiErrorMessage) return undefined;
  // У результата инструмента есть разобранный результат — это не реплика.
  if (record.type === 'user' && record.toolUseResult !== undefined) return undefined;

  const content = record.message?.content;
  let text = '';

  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    // Целиком результат инструмента — не реплика диалога.
    if (content.length > 0 && content.every((block) => block.type === 'tool_result')) {
      return undefined;
    }
    text = content
      .filter(
        (block) =>
          (block.type === 'text' && block.text) || (block.type === 'thinking' && block.thinking),
      )
      .map((block) => (block.type === 'thinking' ? block.thinking : block.text))
      .join(' ');
  }

  text = text.trim();
  if (!text) return undefined;

  return { role: record.type === 'user' ? 'user' : 'assistant', text };
}

/** Схлопывает пробелы и переносы — сниппет должен быть одной строкой. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Сколько раз needle встречается в text (без учёта регистра, без перекрытий). */
export function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;

  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  let count = 0;
  let from = 0;

  for (;;) {
    const at = lower.indexOf(target, from);
    if (at < 0) break;
    count += 1;
    from = at + target.length;
  }

  return count;
}

/**
 * Фрагмент вокруг первого совпадения с многоточиями по краям. Если совпадения
 * нет (позвали для другого поля), показываем начало текста.
 */
export function buildChatSnippet(text: string, needle: string, radius = SNIPPET_RADIUS): string {
  const source = collapse(text);
  const at = source.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) {
    return source.length > radius * 2 ? `${source.slice(0, radius * 2)}…` : source;
  }

  const start = Math.max(0, at - radius);
  const end = Math.min(source.length, at + needle.length + radius);
  return `${start > 0 ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`;
}

interface FileEntry {
  path: string;
  id: string;
  project: string;
  mtimeMs: number;
}

/** Собирает пути транскриптов, свежие первыми — с них и начинаем поиск. */
function collectFiles(projectsDir: string): FileEntry[] {
  const files: FileEntry[] = [];

  for (const projectEntry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = join(projectsDir, projectEntry.name);

    for (const fileEntry of readdirSync(projectDir, { withFileTypes: true })) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) continue;

      const path = join(projectDir, fileEntry.name);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }

      files.push({
        path,
        id: fileEntry.name.replace(/\.jsonl$/, ''),
        project: projectEntry.name,
        mtimeMs,
      });
    }
  }

  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

interface BodyMatch {
  count: number;
  snippet: string;
  role: 'user' | 'assistant';
}

/**
 * Пробегает один файл построчно и собирает совпадения в теле сообщений.
 * Битая/недописанная строка активной сессии просто пропускается — не роняет
 * поиск. `needle` ожидается уже в нижнем регистре (для сырого предфильтра).
 */
async function scanFileBody(path: string, needle: string): Promise<BodyMatch | undefined> {
  let count = 0;
  let snippet = '';
  let role: 'user' | 'assistant' | undefined;

  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of lines) {
      // Сверх-длинные строки — это картинки/дампы, а не текст переписки.
      if (line.length > MAX_LINE_LENGTH) continue;
      // Дешёвый предфильтр: нет запроса в сырой строке — парсить незачем.
      if (!line.toLowerCase().includes(needle)) continue;

      let record: TranscriptRecord;
      try {
        record = JSON.parse(line) as TranscriptRecord;
      } catch {
        continue;
      }

      const message = messageText(record);
      if (!message) continue;

      const text = collapse(message.text);
      const hits = countOccurrences(text, needle);
      if (hits === 0) continue;

      count += hits;
      if (!snippet) {
        snippet = buildChatSnippet(text, needle);
        role = message.role;
      }
    }
  } finally {
    lines.close();
  }

  if (count === 0 || !role) return undefined;
  return { count, snippet, role };
}

export interface ChatSearchOptions {
  /** Сколько разговоров-совпадений максимум вернуть. */
  maxHits?: number;
  /** Сколько файлов максимум просмотреть. */
  maxFiles?: number;
}

/**
 * Поиск по телу всех разговоров. Короткий запрос сразу отдаёт пустой результат,
 * не трогая диск. Метаданные (заголовок, проект, путь) берём из читалки списка —
 * она кешируется по времени изменения, поэтому повторные вызовы дёшевы.
 */
export async function searchChats(
  projectsDir: string,
  query: string,
  options: ChatSearchOptions = {},
): Promise<ChatSearchResponse> {
  const normalized = (query ?? '').trim();
  if (normalized.length < MIN_QUERY_LENGTH || !existsSync(projectsDir)) {
    return { query: normalized, hits: [] };
  }

  const needle = normalized.toLowerCase();
  const maxHits = options.maxHits ?? MAX_HITS;
  const maxFiles = options.maxFiles ?? MAX_FILES;

  const summaries = new Map(readChats(projectsDir).map((chat) => [chat.id, chat]));

  const files = collectFiles(projectsDir);
  const hits: ChatSearchHit[] = [];
  let scanned = 0;

  for (const file of files) {
    if (hits.length >= maxHits || scanned >= maxFiles) break;
    scanned += 1;

    const found = await scanFileBody(file.path, needle);
    if (!found) continue;

    const summary = summaries.get(file.id);
    hits.push({
      sessionId: file.id,
      project: file.project,
      projectPath: summary?.projectPath ?? '',
      title: summary?.title ?? file.id,
      snippet: found.snippet,
      matchCount: found.count,
      role: found.role,
      updatedAt: summary?.updatedAt ?? new Date(file.mtimeMs).toISOString(),
    });
  }

  return { query: normalized, hits };
}
