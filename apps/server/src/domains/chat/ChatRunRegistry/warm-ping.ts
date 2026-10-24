import type { ChatEvent } from '../chat-events.ts';
import type { RunOptions } from '../ChatRunner/ChatRunner.ts';
import type { LimitSample } from '@agentdeck/contracts/limit-share';
import { withLimitSample } from '../limit-journal/limit-journal.ts';

/**
 * Пинг тёплого кэша (`keep-warm`): один разовый ход ответвления сессии группы,
 * которого человек не видит. Здесь — только сбор его исхода из событий прогона:
 * расход, id ответвления, ошибка, отказ лимита. Ни буфера ленты, ни журнала
 * прогонов, ни сторожа — пинг не разговор и следов в панели не оставляет.
 */

/** Расход пинга — то, что ляжет в учёт токенов группы с меткой keep-warm. */
export interface WarmUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Из записи — сколько ушло в часовой кэш; ноль при записи — CLI шёл на 5m. */
  cacheWrite1h: number;
  output: number;
}

export interface WarmOutcome {
  /** Ход дошёл до конца без ошибки и без вызова инструмента. */
  ok: boolean;
  usage: WarmUsage;
  /** Id ответвления (транскрипта у него нет: `--no-session-persistence`). */
  sessionId?: string;
  error?: string;
  /** Лимит подписки отказал — пинги до сброса бессмысленны. */
  limited?: { resetsAt: number; status: string };
  /** Модель позвала инструмент — ход оборван, исполнять пингу нечего. */
  toolStopped?: boolean;
  /** Потолок вышел, а процесс пинга снять не удалось (номер не сверить, F-145). */
  stopUnconfirmed?: boolean;
  /** Замеры загрузки окон подписки за пинг — журналу доли лимита. */
  samples?: LimitSample[];
  startedAt?: number;
  durationMs: number;
}

/** Минимум прогона, нужный пингу: тот же `RunLike` реестра без журнала и посредника. */
export interface WarmRunLike {
  start(options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void>;
  stop(): 'unconfirmed' | void;
}

/** Потолок одного пинга: ответ в одно слово не идёт и минуты, дольше — зависание. */
export const WARM_PING_TIMEOUT_MS = 3 * 60_000;

/**
 * Запускает пинг и собирает его исход. Первый же вызов инструмента обрывает ход:
 * ответвление — полная копия сессии группы с её правами, и пинг, взявшийся
 * исполнять, правил бы её папку (жёсткая страховка поверх слов «без инструментов»).
 */
export function runWarmPing(
  run: WarmRunLike,
  options: RunOptions,
  now: () => number = Date.now,
  timeoutMs = WARM_PING_TIMEOUT_MS,
): Promise<WarmOutcome> {
  const startedAt = now();
  const usage: WarmUsage = { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 };
  let sessionId: string | undefined;
  let error: string | undefined;
  let limited: WarmOutcome['limited'];
  let toolStopped = false;
  let stopUnconfirmed = false;
  let samples: LimitSample[] = [];
  let settled = false;
  // Начатый ход модели (`turnStart`, только у пинга): запрос дошёл и вход с кэшем
  // оплачен. Его расход обычно приносит `usage` в конце хода; ход, оборванный
  // раньше (инструмент, потолок), отдаёт в исход хотя бы этот.
  let open: WarmUsage | undefined;
  const onEvent = (event: ChatEvent): void => {
    // Исход уже отдан (потолок): поздние события снятого процесса в него не пишутся.
    if (settled) return;
    if (event.kind === 'limit' && event.sample) samples = withLimitSample(samples, event.sample);
    if (event.kind === 'session') sessionId = event.sessionId;
    else if (event.kind === 'turnStart') {
      open = {
        input: event.input,
        cacheRead: event.cacheRead,
        cacheWrite: event.cacheCreation,
        cacheWrite1h: event.cacheCreation1h ?? 0,
        output: 0,
      };
    } else if (event.kind === 'usage') {
      open = undefined;
      usage.input += event.input;
      usage.cacheRead += event.cacheRead;
      usage.cacheWrite += event.cacheCreation;
      usage.cacheWrite1h += event.cacheCreation1h ?? 0;
      usage.output += event.output;
    } else if (event.kind === 'error') error ??= event.message;
    else if (event.kind === 'limit' && event.status === 'rejected') {
      limited = { resetsAt: event.resetsAt, status: event.status };
    } else if (event.kind === 'tool' && !toolStopped) {
      toolStopped = true;
      run.stop();
    }
  };
  const settle = (thrown?: unknown): WarmOutcome => {
    if (thrown !== undefined) error ??= thrown instanceof Error ? thrown.message : String(thrown);
    settled = true;
    if (open) {
      usage.input += open.input;
      usage.cacheRead += open.cacheRead;
      usage.cacheWrite += open.cacheWrite;
      usage.cacheWrite1h += open.cacheWrite1h;
      open = undefined;
    }
    return {
      ok: !error && !limited && !toolStopped,
      usage: { ...usage },
      ...(sessionId ? { sessionId } : {}),
      ...(error ? { error } : {}),
      ...(limited ? { limited } : {}),
      ...(toolStopped ? { toolStopped } : {}),
      ...(stopUnconfirmed ? { stopUnconfirmed } : {}),
      ...(samples.length > 0 ? { samples } : {}),
      startedAt,
      durationMs: now() - startedAt,
    };
  };
  return new Promise<WarmOutcome>((resolve) => {
    // Потолок отдаёт исход сам, не дожидаясь `start`: зависший процесс (или
    // снятие, которое не подтвердилось) иначе держал бы пинг вечно, а с ним —
    // и следующий пинг этой группы (ревью keep-warm, Y2).
    const timer = setTimeout(() => {
      if (settled) return;
      error ??= 'timeout';
      // Снятие — деревом процессов сессии (`LiveSession.kill` → транспорт).
      if (run.stop() === 'unconfirmed') stopUnconfirmed = true;
      resolve(settle());
    }, timeoutMs);
    timer.unref?.();
    run.start(options, onEvent).then(
      () => {
        clearTimeout(timer);
        if (!settled) resolve(settle());
      },
      (thrown: unknown) => {
        clearTimeout(timer);
        if (!settled) resolve(settle(thrown));
      },
    );
  });
}
