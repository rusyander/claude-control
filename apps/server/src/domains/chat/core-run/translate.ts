import type { LimitSample } from '@agentdeck/contracts/limit-share';
import {
  sessionWindowDataSchema,
  type SessionStreamEvent,
} from '@agentdeck/contracts/core/session-stream';
import type { ChatEvent } from '../chat-events.ts';

/**
 * Событие вида сеанса ядра → событие ленты чата панели (этап 10, F2, проход 3). Вид сеанса —
 * нормализатор самого переходника ядра (`stream-view.ts`), лента панели — словарь прежнего
 * исполнителя: так реестр, вкладка и сторожа читают ход ядра теми же путями, что ход своего CLI.
 *
 * Ход человека (`user-text`) в ленту не идёт: его пузырь лента уже нарисовала из отправки.
 * Вид `permission` тоже нет: карточку права ведёт вопрос ядра (`human.asked`), а не строка потока.
 */

const record = (data: SessionStreamEvent['data']): Record<string, unknown> =>
  data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const TURN_ERROR_TEXT = 'the model turn ended with an error';

export type Translated =
  | { kind: 'event'; event: ChatEvent }
  /**
   * Конец хода: `isError` — ход кончился ошибкой модели (ошибка ленты идёт перед концом); `text` —
   * слова CLI о ней (отказ модели, «Prompt is too long»): по ним панель ставит код и повтор.
   */
  | { kind: 'turn-end'; isError: boolean; text?: string }
  | { kind: 'skip' };

/** Окна, которые знает доля лимита панели (`LimitSample`), по имени окна у Claude Code. */
const SAMPLE_WINDOWS = { five_hour: 'fiveHour', seven_day: 'sevenDay' } as const;

/**
 * Окно подписки сеанса ядра → событие `limit` ленты, как его строил прежний исполнитель из
 * `rate_limit_event` (`chat-events.ts`): сброс в секундах, имя окна, статус и замер загрузки
 * окон — реестр по нему ставит повтор после лимита и пишет долю лимита у чата (`limit-journal`).
 */
function limitOf(raw: SessionStreamEvent['data'], now: number): Translated {
  const parsed = sessionWindowDataSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'skip' };
  const w = parsed.data;
  const sample: LimitSample = { at: now };
  for (const [name, key] of Object.entries(SAMPLE_WINDOWS)) {
    const one = w.windows?.[name];
    if (one && one.resetAt !== null)
      sample[key] = { utilization: one.usedPct / 100, resetsAt: Math.floor(one.resetAt / 1000) };
  }
  const sampled = sample.fiveHour !== undefined || sample.sevenDay !== undefined;
  return {
    kind: 'event',
    event: {
      kind: 'limit',
      resetsAt: w.resetAt === null ? 0 : Math.floor(w.resetAt / 1000),
      type: w.window ?? '',
      status: w.status,
      ...(sampled ? { sample } : {}),
    },
  };
}

/** `now` — стена замера доли лимита (мс): вид сеанса времени строки не несёт, его читают сразу. */
export function translate(event: SessionStreamEvent, now: number = Date.now()): Translated {
  const data = record(event.data);
  switch (event.kind) {
    case 'window':
      return limitOf(event.data, now);
    case 'assistant-text':
      return typeof data.text === 'string' && data.text
        ? { kind: 'event', event: { kind: 'text', text: data.text } }
        : { kind: 'skip' };
    case 'thinking':
      return typeof data.text === 'string' && data.text
        ? { kind: 'event', event: { kind: 'thinking', text: data.text } }
        : { kind: 'skip' };
    case 'tool-call':
      return {
        kind: 'event',
        event: {
          kind: 'tool',
          name: String(data.name ?? ''),
          input: data.input ?? null,
          id: String(data.toolUseId ?? ''),
        },
      };
    case 'tool-result':
      return {
        kind: 'event',
        event: {
          kind: 'toolResult',
          toolUseId: String(data.toolUseId ?? ''),
          ...(data.isError === true ? { isError: true as const } : {}),
        },
      };
    case 'usage':
      return {
        kind: 'event',
        event: {
          kind: 'usage',
          input: count(data.input),
          output: count(data.output),
          cacheRead: count(data.cacheRead),
          // Ядро зовёт запись кэша `cacheWrite`, лента панели — `cacheCreation`.
          cacheCreation: count(data.cacheWrite),
        },
      };
    case 'turn-end': {
      const isError = data.isError === true;
      const text = isError && typeof data.text === 'string' ? data.text.trim() : '';
      return { kind: 'turn-end', isError, ...(text ? { text } : {}) };
    }
    case 'error':
      return {
        kind: 'event',
        event: {
          kind: 'error',
          message: String(data.detail || data.code || 'core session error'),
        },
      };
    default:
      return { kind: 'skip' };
  }
}
