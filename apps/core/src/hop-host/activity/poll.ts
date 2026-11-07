import type { HopActivityPhase } from '@agentdeck/contracts/core/hops';

/**
 * Один опрос сервера моделей за локальным маршрутом звена (этап 11, W2-5; перенесено из
 * прежнего присмотра панели `domains/local-models/activity.ts`, L6): `/health` — жив ли и грузит
 * ли модель, `/slots` — сколько промпта уже в кеше слота (`n_prompt_tokens` растёт на каждом
 * пакете разбора) и сколько токенов ответа выдано (`next_token[0].n_decoded`).
 *
 * Зачем. Чат на локальной модели молчал до 20 минут: длинный законный разбор и мёртвый сервер
 * со стороны неотличимы, и человек слал сообщение заново, обрывая начатый разбор. Опрос видит
 * движение; его отсутствие дольше предела устройства — застой.
 */

/** Шаг опроса, пока по маршруту идёт запрос. */
export const ACTIVITY_INTERVAL_MS = 2_000;
/**
 * Сколько ждать ответа `/slots`. Он проходит через очередь задач сервера и отвечается между
 * пакетами разбора: не ответил — движения не видно, тишина копится (а не шаг пропускается).
 */
export const SLOT_TIMEOUT_MS = 1_500;
const HEALTH_TIMEOUT_MS = 1_500;

export type Health = 'ok' | 'loading' | undefined;

export interface SlotReading {
  processing: boolean;
  filled: number;
  decoded: number;
}

/** `/slots` не ответил (срок или сбой сети) при живом `/health`. */
export const SLOTS_UNANSWERED = 'unanswered';

export interface Reading {
  health: Health;
  /** Нет — `/slots` не спрашивали (сервера нет или он грузит модель). */
  slot?: SlotReading | undefined | typeof SLOTS_UNANSWERED;
}

/** Состояние хода маршрута между опросами. */
export interface Motion {
  phase: HopActivityPhase;
  filled: number;
  decoded: number;
  /** Отпечаток последнего движения: сменился — движение. */
  key: string;
  lastMoveAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

/**
 * Слот из ответа `GET /slots`: занятый слот, иначе слот 0. Не массив и не слоты — `undefined`
 * (сервер, который не знает `/slots`, — «ждёт слота», а не движение).
 */
export function slotOf(body: unknown): SlotReading | undefined {
  if (!Array.isArray(body)) return undefined;
  const slots = body.filter(isRecord);
  const slot = slots.find((item) => item.is_processing === true) ?? slots.find((s) => s.id === 0);
  if (!slot) return undefined;
  const next = Array.isArray(slot.next_token) ? slot.next_token[0] : undefined;
  return {
    processing: slot.is_processing === true,
    filled: count(slot.n_prompt_tokens),
    decoded: count(isRecord(next) ? next.n_decoded : undefined),
  };
}

async function healthOf(origin: string, fetchImpl: typeof fetch): Promise<Health> {
  try {
    const response = await fetchImpl(`${origin}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.ok) return 'ok';
    // 503 у llama-server — «модель грузится», прочие отказы — сервера нет.
    return response.status === 503 ? 'loading' : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Опрос: `/health`, и только живому серверу — `/slots` (`?model=` — имя для маршрутизатора
 * llama-server за постоянным адресом ядра). Сервер, который грузит модель, `/slots` не спрашивают.
 */
export async function readServer(
  origin: string,
  model: string | undefined,
  fetchImpl: typeof fetch,
  slotTimeoutMs = SLOT_TIMEOUT_MS,
): Promise<Reading> {
  const health = await healthOf(origin, fetchImpl);
  if (health !== 'ok') return { health };
  const query = model ? `?model=${encodeURIComponent(model)}` : '';
  try {
    const response = await fetchImpl(`${origin}/slots${query}`, {
      signal: AbortSignal.timeout(slotTimeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { health, slot: undefined };
    }
    return { health, slot: slotOf(await response.json()) };
  } catch {
    return { health, slot: SLOTS_UNANSWERED };
  }
}

/**
 * Следующее состояние по опросу. Нет сервера — `starting`; грузит модель — `loading` (загрузка —
 * законное движение, отпечаток новый каждый раз); слот занят — `prompt` до первого токена
 * ответа, потом `generating`; слот свободен — `queued` (запрос ждёт, пока сервер его возьмёт);
 * `/slots` молчит — этап прежний и движения нет.
 */
export function advance(motion: Motion, reading: Reading, now: number): Motion {
  let phase: HopActivityPhase;
  let key: string;
  let { filled, decoded } = motion;
  if (reading.health === undefined) {
    phase = 'starting';
    key = 'starting';
  } else if (reading.health === 'loading') {
    phase = 'loading';
    key = `loading:${now}`;
  } else if (reading.slot === SLOTS_UNANSWERED) {
    phase = motion.phase;
    key = motion.key;
  } else if (reading.slot?.processing) {
    ({ filled, decoded } = reading.slot);
    phase = decoded > 0 ? 'generating' : 'prompt';
    key = `${filled}:${decoded}`;
  } else {
    phase = 'queued';
    key = 'queued';
  }
  const moved = key !== motion.key || phase !== motion.phase;
  return { phase, filled, decoded, key, lastMoveAt: moved ? now : motion.lastMoveAt };
}

/**
 * Застой: запрос в полёте, сервер жив и не грузит модель, а движения нет дольше предела.
 * Поднимающийся сервер застоем не считается — его снимает присмотр удержания ядра.
 */
export function isStalled(motion: Motion, inFlight: number, now: number, limitMs: number): boolean {
  if (inFlight === 0) return false;
  if (motion.phase === 'starting' || motion.phase === 'loading' || motion.phase === 'idle')
    return false;
  return now - motion.lastMoveAt >= limitMs;
}
