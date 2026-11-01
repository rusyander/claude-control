import type { ContentBlock, Record } from '../../chat/ChatRecords/ChatRecords.ts';
import { isHumanPrompt } from '../../chat/chat-inbox/transcript-tail.ts';
import { firstQuestionOf, questionOptionsOf } from '../telegram-text.ts';
import type { TurnEndFacts } from './turn-end.types.ts';

/**
 * Конец хода сессии из терминала или VS Code — по её транскрипту.
 *
 * Панель такие сессии не ведёт и узнаёт о конце хода только от хука Stop.
 * Хук срабатывает и там, где ход не кончился: хук Stop отбил конец (запись
 * `stop_hook_summary` с `hookErrors`) и агент работает дальше, пришло
 * уведомление фоновой задачи, человек уже пишет. Поэтому решает не сигнал, а
 * транскрипт через полминуты после него: был ли последний ответ концом хода и
 * не пошла ли сессия дальше.
 *
 * Фоновые задачи отсюда не судятся: остановленная задача уведомления не
 * оставляет, и «фон ещё идёт» висело бы на сессии вечно (выборка 28–30.10).
 */

/** Чем кончается ход модели: всё прочее — ход ещё идёт (`transcript-tail.ts`). */
const TURN_ENDS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);

export interface TranscriptTurn extends TurnEndFacts {
  /** Последняя реплика человека — начало хода. */
  startedAt?: number;
  /** Первая запись прочитанного куска — начало, если реплики в нём нет. */
  earliest?: number;
  /** Последняя запись конца хода: по ней один конец не уходит дважды. */
  closingId?: string;
  /** Когда записан конец хода — до него считается «шёл N мин». */
  endedAt?: number;
}

/** Служебные поля записи, которых нет в разобранном виде транскрипта. */
interface RawRecord extends Record {
  subtype?: string;
  hookErrors?: unknown[];
  operation?: string;
}

const blocksOf = (record: Record): ContentBlock[] =>
  Array.isArray(record.message?.content) ? record.message.content : [];

const isHuman = (record: Record): boolean =>
  record.type === 'user' &&
  !record.isMeta &&
  !record.isSidechain &&
  isHumanPrompt(record.message?.content);

/** Момент, на который агент назначил себе пробуждение (`ScheduleWakeup`), мс. */
function wakeupOf(record: Record): number | undefined {
  const result = record.toolUseResult as { scheduledFor?: unknown } | null | undefined;
  return typeof result?.scheduledFor === 'number' ? result.scheduledFor : undefined;
}

/**
 * Сессия пошла дальше после конца хода: новая реплика (человек, результат
 * инструмента, уведомление CLI), новый ответ модели, отбитый хуком Stop конец,
 * ждущее в очереди сообщение.
 */
function ranOn(after: readonly RawRecord[], closingMessage: string | undefined): boolean {
  let queued = 0;
  for (const record of after) {
    if (record.isSidechain) continue;
    if (record.type === 'user' && !record.isMeta) return true;
    if (record.type === 'assistant' && record.message?.id !== closingMessage) return true;
    if (record.type === 'attachment' && record.attachment?.type === 'queued_command') return true;
    if (record.type === 'system' && record.subtype === 'stop_hook_summary') {
      if (Array.isArray(record.hookErrors) && record.hookErrors.length > 0) return true;
    }
    if (record.type === 'queue-operation') {
      if (record.operation === 'enqueue') queued += 1;
      else if (record.operation === 'dequeue' || record.operation === 'remove') queued -= 1;
    }
  }
  return queued > 0;
}

/** Факты конца хода из записей транскрипта (хвоста, где есть начало хода). */
export function turnFactsOf(records: readonly Record[], now: number): TranscriptTurn {
  let startedAt: number | undefined;
  let earliest: number | undefined;
  let parts: string[] = [];
  let answer = '';
  let closing: { index: number; id?: string; message?: string; at?: number } | undefined;
  const asks = new Map<string, unknown>();
  let wakeAt = 0;

  for (const [index, record] of records.entries()) {
    if (record.isSidechain) continue;
    const at = record.timestamp ? Date.parse(record.timestamp) : Number.NaN;
    if (!Number.isNaN(at)) earliest ??= at;
    if (isHuman(record)) {
      if (!Number.isNaN(at)) startedAt = at;
      parts = [];
      answer = '';
      closing = undefined;
      asks.clear();
      wakeAt = 0;
      continue;
    }
    if (record.type === 'user') {
      const results = blocksOf(record).filter((block) => block.type === 'tool_result');
      for (const block of results) if (block.tool_use_id) asks.delete(block.tool_use_id);
      // Текст до вызова инструмента — рассказ по ходу, итог — после последнего результата.
      if (results.length > 0) parts = [];
      wakeAt = Math.max(wakeAt, wakeupOf(record) ?? 0);
      continue;
    }
    if (record.type !== 'assistant') continue;
    for (const block of blocksOf(record)) {
      if (block.type === 'text' && block.text?.trim()) parts.push(block.text);
      if (block.type !== 'tool_use') continue;
      parts = [];
      if (block.name === 'AskUserQuestion')
        asks.set(block.id ?? `unkeyed:${asks.size}`, block.input);
    }
    if (TURN_ENDS.has(record.message?.stop_reason ?? '')) {
      closing = {
        index,
        ...(record.uuid ? { id: record.uuid } : {}),
        ...(record.message?.id ? { message: record.message.id } : {}),
        ...(Number.isNaN(at) ? {} : { at }),
      };
      answer = parts.join('\n\n');
    }
  }

  const base: TranscriptTurn = {
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(earliest !== undefined ? { earliest } : {}),
  };
  // Конца хода нет — ход ещё идёт (или прочитанный кусок его не застал).
  if (!closing) return { ...base, continued: true };
  const pending = [...asks.values()].at(-1);
  const question = pending === undefined ? undefined : firstQuestionOf(pending);
  const options = pending === undefined ? [] : questionOptionsOf(pending);
  const after = records.slice(closing.index + 1) as RawRecord[];
  return {
    ...base,
    ...(closing.id ? { closingId: closing.id } : {}),
    ...(closing.at !== undefined ? { endedAt: closing.at } : {}),
    answer,
    ...(asks.size > 0 ? { asked: true } : {}),
    ...(question ? { question } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(ranOn(after, closing.message) ? { continued: true } : {}),
    ...(wakeAt > now ? { wakeup: true } : {}),
  };
}
