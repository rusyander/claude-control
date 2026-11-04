import type {
  SessionStreamEvent,
  SessionWindowData,
} from '@agentdeck/contracts/core/session-stream';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterEvent, StreamNormaliser } from '../adapter.types.ts';
import { IO_RECORD, readIoRecord, shownAt, type RecordedSend } from './io-record.ts';

/**
 * Повтор вывода сеанса для показа (этап 10): `stdout.log` хоста — строка за строкой через
 * нормализатор переходника, с начала файла (нормализатор держит ход и эхо — с середины он бы
 * не понял, чей это ход); наружу — только события со смещением от `from`. Отправки ядра из
 * `core-io.jsonl` нормализатор ждёт на смещении насоса (`at`), а человек видит свой ход на
 * `shownAt` — не раньше длины вывода на миг записи отправки (`seen`): курсор вида, ушедший за `at`
 * до записи, иначе терял ход в живой ленте.
 */

export const STDOUT_LOG = 'stdout.log';

type JsonValue = SessionStreamEvent['data'];

export interface ReplayPage {
  events: SessionStreamEvent[];
  /** Конец последней целой строки: продолжение читает отсюда. */
  next: number;
  /** Длина файла; `next < size` — хвост ещё пишется (строка без `\n`). */
  size: number;
}

/** Текст хода из записанной строки stdin (`{"type":"user","message":{content}}`); иначе как есть. */
function sendText(send: RecordedSend): string {
  try {
    const o = JSON.parse(send.data) as { message?: { content?: unknown } };
    const c = o.message?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c
        .map((b) => (b && typeof b === 'object' && 'text' in b ? String(b.text) : ''))
        .join('');
    }
  } catch {
    // Не JSON — CLI с текстовым stdin: строка и есть ход.
  }
  return send.data;
}

/**
 * Окно подписки → данные вида (`sessionWindowDataSchema`): панель строит из них событие `limit`
 * ленты — повтор после лимита и долю лимита у чата (проход 8; раньше окно видел только судья
 * экономии ядра). Статус — словарь Claude Code: отказ, предупреждение или обслужено.
 */
function windowData(e: Extract<AdapterEvent, { type: 'window' }>): SessionWindowData {
  let status: SessionWindowData['status'] = 'allowed';
  if (e.warning) status = 'allowed_warning';
  if (e.refusal) status = 'rejected';
  return {
    limitKind: e.limitKind,
    usedPct: e.usedPct,
    resetAt: e.resetAt,
    status,
    window: e.window,
    ...(e.windows ? { windows: e.windows } : {}),
  };
}

/** Событие переходника → событие вида; служебные (init, начало хода) не показываются. */
export function viewOf(
  e: AdapterEvent,
): { kind: SessionStreamEvent['kind']; data: JsonValue } | null {
  switch (e.type) {
    case 'text.delta':
      return { kind: 'assistant-text', data: { text: e.text } };
    case 'tool.requested':
      return {
        kind: 'tool-call',
        data: { toolUseId: e.toolUseId, name: e.name, input: (e.input ?? null) as JsonValue },
      };
    case 'tool.result':
      return { kind: 'tool-result', data: { toolUseId: e.toolUseId, isError: e.isError } };
    case 'ask':
      return {
        kind: 'permission',
        data: { action: e.ask.action, target: e.ask.target, denied: e.denied },
      };
    case 'permit.request':
      return { kind: 'permission', data: { requestId: e.requestId, raw: e.raw as JsonValue } };
    case 'usage':
      return {
        kind: 'usage',
        data: {
          messageId: e.messageId,
          input: e.input,
          output: e.output,
          cacheRead: e.cacheRead,
          cacheWrite: e.cacheWrite,
        },
      };
    case 'window':
      return { kind: 'window', data: windowData(e) };
    case 'turn.ended':
      // У хода с ошибкой текст результата — слова CLI о ней (отказ модели, HTTP 400): без них
      // показ знал бы только «ошибка». Текст удачного хода уже пришёл кусками `assistant-text`.
      return {
        kind: 'turn-end',
        data:
          e.isError && e.text
            ? { isError: true, numTurns: e.numTurns, text: e.text }
            : { isError: e.isError, numTurns: e.numTurns },
      };
    case 'error':
      return { kind: 'error', data: { code: e.code, detail: e.detail } };
    default:
      return null;
  }
}

/**
 * Нет `stdout.log` — хост ещё не начал писать (или сеанс так и не запустился): пустая страница с
 * нулевым курсором, а не ошибка. Нечитаемый файл — исключение (не «пусто», F25).
 */
export function replaySession(dir: string, normaliser: StreamNormaliser, from: number): ReplayPage {
  if (!existsSync(join(dir, STDOUT_LOG))) return { events: [], next: 0, size: 0 };
  const bytes = readFileSync(join(dir, STDOUT_LOG));
  const sends = [...readIoRecord(dir).sends].sort((a, b) => a.at - b.at);
  const events: SessionStreamEvent[] = [];
  let si = 0;
  const feedSends = (upTo: number) => {
    while (si < sends.length && (sends[si] as RecordedSend).at <= upTo) {
      const send = sends[si] as RecordedSend;
      si += 1;
      normaliser.expect(send.cmdId, send.uuid);
      // Ожидание хода — на `at` (как у насоса), показ — на `shownAt`: отправка, записанная после
      // того, как курсор вида ушёл за `at`, иначе не попадала в живую ленту ни разу.
      const shown = shownAt(send);
      if (shown >= from) {
        const text = normaliser.turnText?.(send.data) ?? sendText(send);
        events.push({ offset: shown, kind: 'user-text', data: { text } });
      }
    }
  };
  let start = 0;
  for (;;) {
    const nl = bytes.indexOf(0x0a, start);
    if (nl < 0) break;
    feedSends(start);
    const line = bytes.subarray(start, nl).toString('utf8').trim();
    if (line) {
      for (const e of normaliser.push(line)) {
        const view = start >= from ? viewOf(e) : null;
        if (view) events.push({ offset: start, ...view });
      }
    }
    start = nl + 1;
  }
  // Отправка после последней целой строки: ход человека уже ушёл, ответа ещё нет.
  feedSends(start);
  return { events, next: start, size: bytes.length };
}

/**
 * Отпечаток роста сеанса: длины `stdout.log` и записи ввода ядра. Поток вида перечитывает сеанс
 * только когда отпечаток сдвинулся — повтор с начала файла на каждый тик был бы O(сеанса).
 */
export function sessionStamp(dir: string): string {
  const size = (name: string): number => {
    const stats = statSync(join(dir, name), { throwIfNoEntry: false });
    return stats ? stats.size : -1;
  };
  return `${size(STDOUT_LOG)}:${size(IO_RECORD)}`;
}
