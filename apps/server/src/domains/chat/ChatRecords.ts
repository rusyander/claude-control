import type { ChatSummary, ChatBlock, MessageUsage } from '@claude-control/contracts';

/**
 * Разбор одной записи транскрипта: что это за строка и что из неё показывать.
 *
 * Здесь только толкование уже прочитанных записей — файлов этот слой не
 * открывает и о размерах ничего не знает (чтение живёт в `ChatTranscriptFile`).
 */

/**
 * Сколько вопрос агента считается ожиданием ответа.
 *
 * Процесс, задавший вопрос, живёт минутами: через сутки отвечать уже некуда —
 * это не «тебя ждут», а брошенный разговор. Без окна одна забытая переписка
 * месячной давности держала бы метку в браузере зажжённой навсегда, и человек
 * переставал бы на неё смотреть — ровно то, ради чего метка и заводилась.
 */
const AWAITING_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface Record {
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

export interface ContentBlock {
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

/** Вопрос старше суток — брошенный разговор, а не ожидание ответа. */
export function withAwaitingWindow(summary: ChatSummary, mtimeMs: number): ChatSummary {
  if (!summary.awaitingReply) return summary;
  if (Date.now() - mtimeMs <= AWAITING_WINDOW_MS) return summary;
  return { ...summary, awaitingReply: undefined };
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
export function toUsage(record: Record): MessageUsage | undefined {
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
export function isAwaitingReply(records: Record[]): boolean {
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

export function isDialogMessage(record: Record): boolean {
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
export function firstMeaningfulText(records: Record[]): string {
  for (const record of records) {
    if (!isDialogMessage(record) || record.type !== 'user') continue;

    const text = cleanText(textOf(record));
    if (text.length > 1) return text;
  }

  return '';
}

export function toBlocks(record: Record): ChatBlock[] {
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

export function textOf(record: Record | undefined): string {
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
export function cleanText(text: string): string {
  return text
    .replace(/<(ide_[a-z_]+|command-[a-z]+|task-notification|system-reminder)>[\s\S]*?<\/\1>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function lastValue<T>(
  records: Record[],
  pick: (record: Record) => T | undefined,
): T | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const value = record && pick(record);
    if (value !== undefined && value !== false) return value as T;
  }

  return undefined;
}
