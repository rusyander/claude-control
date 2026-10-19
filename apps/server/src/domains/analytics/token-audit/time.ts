import type { SessionTime } from './token-audit.types.ts';

/**
 * Время сессии по транскрипту: сколько она шла по часам и сколько из этого
 * кто-то работал. Метрика владельца — стена «запуск → конец задачи» (живое ревью
 * MR, 18.10.2026: 65 мин по часам, 62 мин хоть кто-то занят, 78 мин сумма по
 * агентам — сумма врёт о том, сколько ждал человек).
 *
 * Занят — модель пишет ответ (от события, которое её разбудило, до её записи) или
 * идёт инструмент (от вызова до его результата). Пауза после конца хода до
 * следующей реплики человека или уведомления — простой.
 */

type Row = Record<string, unknown>;
type Block = Record<string, unknown>;

const blocks = (row: Row): Block[] => {
  const content = (row.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
};

/**
 * Потолок одного отрезка «модель пишет» и вызова инструмента, кроме субагента.
 * Оболочка сама уводит команду в фон на 10 минутах, ответ модели столько не
 * пишется; длиннее — это пауза или обрыв, а не работа. Живая группа 16→19.10:
 * пауза посреди вызова, возобновление через двое суток — и 52 ч «работы» вместо
 * ~4 ч.
 */
const SPAN_CAP_MS = 15 * 60_000;
const UNCAPPED_TOOLS = new Set(['Agent', 'Task']);
/** Результат, который CLI дописывает за вызов, оборванный концом процесса. */
const INTERRUPTED = /^\[Tool call interrupted/;

const resultText = (block: Block): string =>
  typeof block.content === 'string'
    ? block.content
    : Array.isArray(block.content)
      ? (block.content as Block[]).map((part) => String(part.text ?? '')).join('')
      : '';

/** Реплика человека или панели, а не результат вызова: с неё ход начинается заново. */
const isPrompt = (row: Row): boolean => {
  const content = (row.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return true;
  return blocks(row).length > 0 && blocks(row).every((block) => block.type !== 'tool_result');
};

export function sessionTime(rows: readonly Row[]): SessionTime | undefined {
  const events = rows.filter(
    (row) => typeof row.timestamp === 'string' && (row.type === 'assistant' || row.type === 'user'),
  );
  if (events.length === 0) return undefined;
  const busy: Array<[number, number]> = [];
  const toolStart = new Map<string, { at: number; capped: boolean }>();
  let modelFrom: number | undefined;
  let modelMs = 0;
  let toolMs = 0;
  // Время предыдущей записи: вызов, оборванный концом процесса, кончился не позже неё.
  let prevAt: number | undefined;
  const addTool = (from: { at: number; capped: boolean }, end: number) => {
    const to = from.capped ? Math.min(end, from.at + SPAN_CAP_MS) : end;
    if (to <= from.at) return;
    busy.push([from.at, to]);
    toolMs += to - from.at;
  };
  for (const row of events) {
    const at = Date.parse(row.timestamp as string);
    if (Number.isNaN(at)) continue;
    if (row.type === 'user') {
      for (const block of blocks(row)) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const from = toolStart.get(block.tool_use_id);
        if (from === undefined) continue;
        addTool(from, INTERRUPTED.test(resultText(block)) ? (prevAt ?? from.at) : at);
        toolStart.delete(block.tool_use_id);
      }
      // Любая реплика пользователя — промпт, результат, уведомление — будит модель.
      // Промпт начинает ход заново: ответ, оборванный паузой, к нему не тянется.
      modelFrom = isPrompt(row) ? at : (modelFrom ?? at);
      prevAt = at;
      continue;
    }
    if (modelFrom !== undefined && at >= modelFrom) {
      const to = Math.min(at, modelFrom + SPAN_CAP_MS);
      busy.push([modelFrom, to]);
      modelMs += to - modelFrom;
    }
    prevAt = at;
    let usedTool = false;
    for (const block of blocks(row)) {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        const name = typeof block.name === 'string' ? block.name : '';
        toolStart.set(block.id, { at, capped: !UNCAPPED_TOOLS.has(name) });
        usedTool = true;
      }
    }
    const stop = (row.message as { stop_reason?: unknown } | undefined)?.stop_reason;
    // После вызова модель ждёт результата; без вызова и без конца хода ответ ещё
    // дописывается — следующий кусок считается от этой записи.
    modelFrom =
      usedTool || stop === 'end_turn' || stop === 'stop_sequence' || stop === 'tool_use'
        ? undefined
        : at;
  }
  const firstMs = Date.parse(events[0]?.timestamp as string);
  const lastMs = Date.parse(events[events.length - 1]?.timestamp as string);
  // Вызов без результата (прерван, транскрипт оборван) — занят до последней записи,
  // не «до сейчас»: старый журнал иначе работал бы вечно.
  for (const from of toolStart.values()) addTool(from, lastMs);
  return { firstMs, lastMs, modelMs, toolMs, busy };
}

/** Длина объединения отрезков: параллельная работа считается один раз. */
export function unionMs(intervals: ReadonlyArray<readonly [number, number]>): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let current: [number, number] | undefined;
  for (const [from, to] of sorted) {
    if (!current || from > current[1]) {
      if (current) total += current[1] - current[0];
      current = [from, to];
    } else current[1] = Math.max(current[1], to);
  }
  if (current) total += current[1] - current[0];
  return total;
}
