import { existsSync, statSync } from 'node:fs';
import type { Record } from '../ChatRecords/ChatRecords.ts';
import { findTranscript, readTailRecords } from '../ChatTranscriptFile/ChatTranscriptFile.ts';
import { autoPickResults } from '../auto-pick/auto-pick.ts';

/**
 * Что сводка ожиданий (`chat-inbox.ts`) узнаёт из хвоста транскрипта: последний
 * неотвеченный вопрос `AskUserQuestion` и идёт ли ход вне панели. Отдельно от
 * сборки сводки — это разбор файла CLI, и он нужен не только ей
 * (`isHumanPrompt` читают ход и черновик случая).
 */

/** Хвост транскрипта для поиска вопроса: вопрос — в последнем ходе. */
const ASK_TAIL_BYTES = 128 * 1024;

/** Последний неотвеченный вызов `AskUserQuestion`. */
export interface AskedCall {
  toolUseId?: string;
  input: unknown;
  askedAt: string;
}

/**
 * Последний неотвеченный вопрос в записях транскрипта.
 *
 * Ответом считается: реплика человека после вопроса; результат вызова БЕЗ
 * ошибки (выбор в терминале); автовыбор автономного чата (метка в отказе).
 * Отказ брокера панели ответом не считается — он и говорит агенту, что ответ
 * придёт следующим сообщением.
 */
export function lastAskedIn(records: readonly Record[]): AskedCall | undefined {
  let asked: AskedCall | undefined;
  for (const record of records) {
    if (record.isSidechain) continue;
    const content = record.message?.content;
    if (record.type === 'user' && !record.isMeta) {
      if (isHumanPrompt(content)) asked = undefined;
      else if (asked?.toolUseId && closes(content, asked.toolUseId)) asked = undefined;
      continue;
    }
    if (record.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== 'tool_use' || block.name !== 'AskUserQuestion') continue;
      asked = {
        ...(block.id ? { toolUseId: block.id } : {}),
        input: block.input,
        askedAt: record.timestamp ?? new Date(0).toISOString(),
      };
    }
  }
  return asked;
}

function closes(content: unknown, toolUseId: string): boolean {
  if (!Array.isArray(content)) return false;
  if (autoPickResults(content).some((pick) => pick.toolUseId === toolUseId)) return true;
  return (content as { type?: string; tool_use_id?: string; is_error?: boolean }[]).some(
    (block) =>
      block?.type === 'tool_result' && block.tool_use_id === toolUseId && block.is_error !== true,
  );
}

/**
 * Реплика, которую CLI пишет от имени человека сам: итог фоновой задачи
 * (команды или субагента). Приходит посреди хода, пока вопрос агента висит, —
 * ответом она не является (живой прогон 28.09: вопрос пропадал с телефона, как
 * только субагент хода отчитывался). Признак тот же, что у ленты панели
 * (`taskNoticesOf`): текст НАЧИНАЕТСЯ с тега.
 */
const CLI_NOTICE = /^\s*<task-notification>/;

export function isHumanPrompt(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0 && !CLI_NOTICE.test(content);
  return (
    Array.isArray(content) &&
    content.some(
      (block: { type?: string; text?: unknown }) =>
        block.type !== 'tool_result' &&
        !(block.type === 'text' && typeof block.text === 'string' && CLI_NOTICE.test(block.text)),
    )
  );
}

/**
 * Сколько транскрипт может молчать, а ход вне панели всё ещё считаться идущим.
 * Долгая команда пишет в файл только по своему концу (Bash — до 10 минут);
 * процесс, убитый посреди хода, конца не пишет вовсе — граница не даёт ему
 * «работать» вечно.
 */
export const OUTSIDE_LIVE_MS = 10 * 60 * 1000;

/** Чем кончается ход модели: всё прочее — ход ещё идёт. */
const TURN_ENDS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);
/** Отмена человеком (Esc): CLI пишет её репликой от его имени. */
const INTERRUPTED = /^\s*\[Request interrupted by user/;

/**
 * Открыт ли ход по записям транскрипта: последняя запись разговора — реплика
 * человека или результат инструмента (модель думает), либо шаг модели, который
 * ещё не кончил ход (`tool_use` — инструмент выполняется).
 */
export function turnOpenIn(records: readonly Record[]): boolean {
  let open = false;
  for (const record of records) {
    if (record.isSidechain || record.isMeta || record.isApiErrorMessage) continue;
    if (record.type === 'user') open = !interrupted(record.message?.content);
    else if (record.type === 'assistant') open = !TURN_ENDS.has(record.message?.stop_reason ?? '');
  }
  return open;
}

function interrupted(content: unknown): boolean {
  if (typeof content === 'string') return INTERRUPTED.test(content);
  return (
    Array.isArray(content) &&
    content.some(
      (block: { type?: string; text?: unknown }) =>
        block?.type === 'text' && typeof block.text === 'string' && INTERRUPTED.test(block.text),
    )
  );
}

/** Что сводке нужно из хвоста транскрипта. */
export interface TranscriptTail {
  asked: AskedCall | undefined;
  turnOpen: boolean;
  mtimeMs: number;
}

/** Ход вне панели: открыт и файл двигался недавно. */
export function liveByTail(tail: TranscriptTail | undefined, now: number): boolean {
  return Boolean(tail?.turnOpen && now - tail.mtimeMs <= OUTSIDE_LIVE_MS);
}

/** Сколько транскриптов помнит читатель хвостов. */
export const ASKED_CACHE_MAX = 500;

/**
 * Читатель хвостов с памятью по файлу: телефон спрашивает сводку каждые
 * несколько секунд, а меняются за это время один-два транскрипта. Хвост
 * перечитывается, только когда у файла сменились время или размер.
 */
export function createTranscriptTailReader(
  projectsDir: () => string,
): (chatId: string) => TranscriptTail | undefined {
  const cache = new Map<
    string,
    { path: string; mtimeMs: number; size: number; value: TranscriptTail }
  >();
  return (chatId) => {
    const known = cache.get(chatId);
    const path =
      known && existsSync(known.path) ? known.path : findTranscript(projectsDir(), chatId);
    if (!path) return undefined;
    try {
      const stats = statSync(path);
      if (
        known &&
        known.path === path &&
        known.mtimeMs === stats.mtimeMs &&
        known.size === stats.size
      ) {
        // Вытеснение — по давности ОБРАЩЕНИЯ: Map помнит порядок вставки, и
        // запись, которую телефон спрашивает каждые секунды, уходила первой.
        cache.delete(chatId);
        cache.set(chatId, known);
        return known.value;
      }
      const records = readTailRecords(path, ASK_TAIL_BYTES);
      const value: TranscriptTail = {
        asked: lastAskedIn(records),
        turnOpen: turnOpenIn(records),
        mtimeMs: stats.mtimeMs,
      };
      cache.delete(chatId);
      cache.set(chatId, { path, mtimeMs: stats.mtimeMs, size: stats.size, value });
      if (cache.size > ASKED_CACHE_MAX) cache.delete(cache.keys().next().value as string);
      return value;
    } catch {
      return undefined;
    }
  };
}
