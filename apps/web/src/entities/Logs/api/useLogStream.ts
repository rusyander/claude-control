import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogLine, LogsChunk } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

/** Сколько строк держит вкладка: столько же, сколько буфер цели на сервере. */
export const CLIENT_LOG_LINES = 5000;

/** Цель панели — память процесса, опрос дешёвый; Compose — процесс docker на каждый опрос. */
const RUN_POLL_MS = 1_000;
const COMPOSE_POLL_MS = 2_000;
const ERROR_POLL_MS = 5_000;

export interface LogEntry extends LogLine {
  /** Номер строки во вкладке — ключ для списка и выбора; с новым источником счёт заново. */
  id: number;
}

export interface LogStreamState {
  lines: LogEntry[];
  /** Видно не всё: начало вытеснено буфером сервера или этой вкладки. */
  truncated: boolean;
  /** Источник сейчас не пишет: цель остановлена, сервис не запущен. */
  idle: boolean;
  /** Первый ответ ещё не пришёл. */
  isLoading: boolean;
  /** Последний опрос не удался; строки остаются, опрос продолжается реже. */
  error?: unknown;
}

const EMPTY: LogStreamState = { lines: [], truncated: false, idle: false, isLoading: true };

/**
 * Поток строк одного источника: первый запрос отдаёт хвост, дальше — только
 * новое после курсора. Не через кеш запросов: ответы не заменяют, а дополняют
 * друг друга, и держать 5000 строк в кеше на каждый открытый когда-то источник
 * незачем. Пустой ответ состояние не трогает — вкладка не перерисовывается раз
 * в секунду впустую.
 */
export function useLogStream(path: string, sourceId: string | undefined, enabled: boolean) {
  const [state, setState] = useState<LogStreamState>(EMPTY);
  const nextId = useRef(0);

  useEffect(() => {
    setState(EMPTY);
    nextId.current = 0;
    if (!enabled || !sourceId) return undefined;
    let cursor: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const interval = sourceId.startsWith('compose:') ? COMPOSE_POLL_MS : RUN_POLL_MS;

    const tick = async (): Promise<void> => {
      // Спрятанная вкладка браузера логов не читает — догонит курсором, когда вернутся.
      if (document.hidden) {
        timer = setTimeout(() => void tick(), interval);
        return;
      }
      let delay = interval;
      try {
        const { data } = await apiClient.get<LogsChunk>('/logs', {
          params: { path, source: sourceId, ...(cursor ? { cursor } : {}) },
        });
        if (cancelled) return;
        cursor = data.cursor ?? cursor;
        setState((previous) => mergeChunk(previous, data, nextId));
      } catch (error) {
        if (cancelled) return;
        delay = ERROR_POLL_MS;
        setState((previous) => ({ ...previous, isLoading: false, error }));
      }
      if (!cancelled) timer = setTimeout(() => void tick(), delay);
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, sourceId, enabled]);

  /** Убрать показанное: курсор остаётся, дальше придут только новые строки. */
  const clear = useCallback(() => {
    setState((previous) => ({ ...previous, lines: [], truncated: false }));
  }, []);

  return { ...state, clear };
}

function mergeChunk(
  previous: LogStreamState,
  chunk: LogsChunk,
  nextId: { current: number },
): LogStreamState {
  const idle = Boolean(chunk.idle);
  const base = chunk.reset ? [] : previous.lines;
  const settled = !previous.isLoading && previous.error === undefined;
  if (chunk.lines.length === 0 && !chunk.reset && settled && previous.idle === idle) {
    return previous;
  }
  const fresh = chunk.lines.map((line) => ({ ...line, id: nextId.current++ }));
  const all = base.length ? [...base, ...fresh] : fresh;
  const dropped = all.length > CLIENT_LOG_LINES;
  return {
    lines: dropped ? all.slice(all.length - CLIENT_LOG_LINES) : all,
    truncated: (chunk.reset ? false : previous.truncated) || dropped || Boolean(chunk.truncated),
    idle,
    isLoading: false,
  };
}
