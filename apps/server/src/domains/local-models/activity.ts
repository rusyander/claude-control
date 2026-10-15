import type { LocalActivity, LocalActivityPhase } from '@agentdeck/contracts/local-models';
import type { Health, SlotState } from './llama-client.ts';

/**
 * Что сервер моделей делает с запросом прямо сейчас — для чата и для шлюза.
 *
 * Зачем (L6, 14–15.10). Чат на локальной модели молчал до 20 минут: запрос ушёл, первый
 * байт не пришёл, а срок ожидания первого байта — расчёт «всё окно на скорости разбора»,
 * то есть десятки минут. Со стороны это неотличимо от зависания, и человек слал сообщение
 * заново, обрывая уже начатый разбор. Срок по расчёту здесь не помогает ничем: длинный
 * законный разбор и мёртвый сервер выглядят одинаково, пока смотришь только на часы.
 *
 * Поэтому — живость, а не срок. Пока хоть один запрос в пути, раз в `intervalMs` спрашиваем
 * `/health` и `/slots`: грузится ли модель, сколько промпта уже в кеше слота
 * (`n_prompt_tokens` растёт на каждом пакете), сколько токенов ответа выдано
 * (`next_token[0].n_decoded`). Любое движение — прогресс. Ничего не движется
 * `stallMs` подряд при живом сервере — запрос обрывается (`signal`), клиент получает
 * «перегрузку» и повторяет; слот, застывший посреди работы, — повод перезапустить сервер
 * (`onWedged`). Спящий сервер `/slots` будит загрузкой — поэтому опрос идёт ТОЛЬКО пока
 * запрос в пути: тогда сервер и так просыпается.
 */

/** Шаг опроса сервера, пока запрос в пути. */
export const ACTIVITY_INTERVAL_MS = 2_000;
/** Сколько без движения считается зависанием у видеокарты: пакет промпта там — секунды. */
export const STALL_GPU_MS = 120_000;
/** То же на процессоре: пакет в 2048 токенов у 27B идёт минуту и дольше. */
export const STALL_CPU_MS = 600_000;

/** `/slots` не ответил (срок `SLOT_TIMEOUT_MS` или отказ) при живом `/health`. */
const SLOTS_UNANSWERED = Symbol('slots-unanswered');

export interface ActivityDeps {
  health: () => Promise<Health | undefined>;
  slot: () => Promise<SlotState | undefined>;
  /** Что за сервер: модель, квантование, окно, устройство. Нет записи — сервера нет. */
  server: () => { model: string; quant?: string; context: number; device: string } | undefined;
  /** Слот застыл посреди работы при живом `/health` — сервер надо поднять заново. */
  onWedged?: () => void;
  /** Текст обрыва для клиента: `seconds` — сколько не было движения. */
  stallText: (seconds: number) => string;
  now?: () => number;
  intervalMs?: number;
  stallMs?: (device: string) => number;
}

export interface ActivityTrack {
  /** Сработает, если запрос завис; причина — текст для клиента. */
  signal: AbortSignal;
  /** Сервер ответил отказом: код и текст видны чату, пока следующий ответ не удастся. */
  failed(status: number, message: string): void;
  /** Сервер ответил: прежний отказ больше не новость. */
  succeeded(): void;
  done(): void;
}

/** Предел текста отказа: ошибка шаблона llama.cpp — экран с выдержкой из исходника. */
const ERROR_TEXT_MAX = 300;

export interface ActivityWatch {
  track(promptTokens: number): ActivityTrack;
  snapshot(): LocalActivity;
  /** Один шаг опроса — таймер зовёт сам; проверки зовут напрямую. */
  tick(): Promise<void>;
  stop(): void;
}

interface Flight {
  id: number;
  promptTokens: number;
  startedAt: number;
  controller: AbortController;
}

export function createActivityWatch(deps: ActivityDeps): ActivityWatch {
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? ACTIVITY_INTERVAL_MS;
  const stallOf = deps.stallMs ?? ((device) => (device === 'cpu' ? STALL_CPU_MS : STALL_GPU_MS));
  const flights = new Map<number, Flight>();
  let nextId = 1;
  let timer: ReturnType<typeof setInterval> | undefined;
  let phase: LocalActivityPhase = 'idle';
  let phaseSince = now();
  let progressAt = now();
  let progressKey = '';
  let filled = 0;
  let decoded = 0;
  let lastStall: { at: number; seconds: number } | undefined;
  let lastRequestAt: number | undefined;
  let lastError: { at: number; status: number; message: string } | undefined;
  let ticking = false;

  function setPhase(next: LocalActivityPhase): void {
    if (next === phase) return;
    phase = next;
    phaseSince = now();
  }

  function startTimer(): void {
    if (timer) return;
    timer = setInterval(() => void tick(), intervalMs);
    timer.unref?.();
  }

  function stopTimerIfIdle(): void {
    if (flights.size > 0 || !timer) return;
    clearInterval(timer);
    timer = undefined;
    setPhase('idle');
  }

  async function tick(): Promise<void> {
    if (ticking || flights.size === 0) return;
    ticking = true;
    try {
      const health = await deps.health();
      let next: LocalActivityPhase;
      let key: string;
      let wedged = false;
      if (health === undefined) {
        next = 'starting';
        key = 'starting';
      } else if (health === 'loading') {
        // Загрузка модели — законное движение: присмотр сам снимает сервер, чей /health молчит.
        next = 'loading';
        key = `loading:${now()}`;
      } else {
        const slot = await deps.slot().catch((): typeof SLOTS_UNANSWERED => SLOTS_UNANSWERED);
        if (slot === SLOTS_UNANSWERED) {
          // `/health` отвечает из потока HTTP, а `/slots` — через очередь задач, между пакетами
          // разбора. Не ответил — движения не видно: тишина копится, как при застывшем слоте, и
          // обрыв наступает по тому же сроку (на процессоре он длиннее любого одного пакета).
          // Раньше сбой опроса пропускал проверку целиком, и зависшее декодирование не ловилось.
          next = phase;
          key = progressKey;
          wedged = true;
        } else if (slot?.processing) {
          filled = slot.filled;
          decoded = slot.decoded;
          next = slot.decoded > 0 ? 'generating' : 'prompt';
          key = `${slot.filled}:${slot.decoded}`;
          wedged = true;
        } else {
          next = 'queued';
          key = 'queued';
        }
      }
      if (flights.size === 0) return;
      if (key !== progressKey || next !== phase) {
        progressKey = key;
        progressAt = now();
      }
      setPhase(next);
      const server = deps.server();
      const silent = now() - progressAt;
      if (health !== undefined && silent >= stallOf(server?.device ?? 'gpu')) {
        const seconds = Math.round(silent / 1_000);
        lastStall = { at: now(), seconds };
        const reason = new Error(deps.stallText(seconds));
        for (const flight of flights.values()) flight.controller.abort(reason);
        flights.clear();
        progressAt = now();
        stopTimerIfIdle();
        if (wedged) deps.onWedged?.();
      }
    } catch {
      // Сервер не ответил на опрос — следующий шаг спросит снова; опрос запрос не рвёт.
    } finally {
      ticking = false;
    }
  }

  return {
    track(promptTokens) {
      const flight: Flight = {
        id: nextId++,
        promptTokens,
        startedAt: now(),
        controller: new AbortController(),
      };
      if (flights.size === 0) {
        progressAt = now();
        progressKey = '';
        filled = 0;
        decoded = 0;
        setPhase('queued');
      }
      flights.set(flight.id, flight);
      lastRequestAt = flight.startedAt;
      startTimer();
      return {
        signal: flight.controller.signal,
        failed(status, message) {
          // 503 — сервер ещё грузит модель («Loading model»): это этап, а не отказ; клиент
          // повторит, а присмотр и так покажет загрузку. Красным он сбивал после перезапуска.
          if (status === 503) return;
          lastError = { at: now(), status, message: message.slice(0, ERROR_TEXT_MAX) };
        },
        succeeded() {
          lastError = undefined;
        },
        done() {
          flights.delete(flight.id);
          stopTimerIfIdle();
        },
      };
    },

    snapshot() {
      const server = deps.server();
      const flight = [...flights.values()].at(-1);
      const at = now();
      return {
        phase: flights.size > 0 ? phase : 'idle',
        ...(server
          ? {
              model: server.model,
              ...(server.quant ? { quant: server.quant } : {}),
              context: server.context,
            }
          : {}),
        inFlight: flights.size,
        ...(flight
          ? {
              startedAt: flight.startedAt,
              promptTokens: flight.promptTokens,
              filled,
              decoded,
              phaseSince,
              silentMs: Math.max(0, at - progressAt),
              stallMs: stallOf(server?.device ?? 'gpu'),
            }
          : {}),
        ...(lastStall ? { lastStall } : {}),
        ...(lastRequestAt !== undefined ? { lastRequestAt } : {}),
        ...(lastError ? { lastError } : {}),
      };
    },

    tick,

    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
