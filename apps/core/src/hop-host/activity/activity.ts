import { LOCAL_PLATFORM_ID } from '@agentdeck/contracts/platform-layers';
import { HOP_STALL_GPU_MS, type HopActivity } from '@agentdeck/contracts/core/hops';
import { contourRouteId } from '../contour-book/record.ts';
import type { TagEntry } from '../host.types.ts';
import {
  ACTIVITY_INTERVAL_MS,
  advance,
  isStalled,
  readServer,
  SLOT_TIMEOUT_MS,
  type Motion,
} from './poll.ts';

/**
 * Лента хода локальных маршрутов звена (этап 11, W2-5): op `activity` управления отдаёт её
 * ядру, ядро — панели (`GET /v1/local/activity`), панель — строке состояния чата. Раньше то же
 * считал присмотр панели над её собственным исполнителем; исполнение ушло в ядро, и запрос к
 * локальной модели идёт через шлюз звена — здесь его и видно.
 *
 * Опрос сервера моделей идёт ТОЛЬКО пока по маршруту есть запрос в полёте: первый запрос —
 * сразу один шаг и таймер, последний закрылся — таймер снят, этап `idle`. Без запросов сервер
 * не трогается вовсе (у llama-server `/slots` идёт через очередь задач — лишний опрос мешает).
 *
 * Звено устройства не знает (видеокарта или процессор — знание панели) и судит застой по
 * пределу видеокарты; панель пересчитывает его по своему устройству.
 */

/** Сколько ждать подсчёта промпта сервером моделей: он идёт мимо слота, но не мгновенно. */
const COUNT_TIMEOUT_MS = 20_000;

export interface ActivityOptions {
  intervalMs?: number;
  stallMs?: number;
  slotTimeoutMs?: number;
  countTimeoutMs?: number;
}

/**
 * Что ленте нужно от звена для подсчёта промпта. Даёт хост поверх своего контекста: лента
 * контекст не тянет — он сам держит ленту, и импорт в обе стороны замкнул бы круг модулей.
 */
export interface ActivityLinks {
  /** Адрес верха маршрута с путём диалекта (`upstreamUrl`). */
  url(entry: TagEntry, path: string): string;
  /** Заголовки доступа наверх (`upstreamAuth`); отказ — подсчёта нет. */
  auth(
    entry: TagEntry,
    credential: string,
  ): { headers: Record<string, string> } | { refusal: string };
  /** Маска на сеансе (`maskingOn`): немаскированное тело наверх не уходит и подсчётом. */
  masking(entry: TagEntry): boolean;
}

export interface ActivityDeps extends ActivityOptions {
  now(): number;
  fetchImpl?: typeof fetch;
  links: ActivityLinks;
}

/** Запрос, о котором узнала лента: что нужно, чтобы опросить и подсчитать промпт. */
export interface ActivityRequest {
  credential: string;
  /** Ручка клиента: подсчёт промпта — только у `messages` Anthropic ↔ Anthropic. */
  route: string | undefined;
  /** Путь клиента без строки запроса (шлюз): оценку `:countTokens` звено отвечает само. */
  path?: string;
  body: Record<string, unknown>;
}

/**
 * `:countTokens` Gemini — оценка на месте звена: до сервера моделей она не доходит, и ходом она
 * не считается (как подсчёт токенов самого CLI у `beginRaw`). Иначе вызов будил бы опросом
 * `/slots` спящий сервер — загрузка модели без единого запроса к ней.
 */
const GOOGLE_COUNT = /:countTokens\/*$/;

export interface ActivityBook {
  /** Запрос по маршруту начался; локальный маршрут — функция «закрылся», иначе `undefined`. */
  begin(entry: TagEntry, request: ActivityRequest): (() => void) | undefined;
  /**
   * То же для DLP-звена (сеанс того же диалекта, что верх): тело — сырой JSON пути клиента.
   * Запрос модели — только `…/messages` и `…/chat/completions`; список моделей и подсчёт
   * токенов самого CLI ходом не считаются.
   */
  beginRaw(
    entry: TagEntry,
    credential: string,
    path: string,
    body: string | undefined,
  ): (() => void) | undefined;
  snapshot(): HopActivity[];
  /** Один шаг опроса всех маршрутов в полёте (тестам и первому запросу). */
  tick(): Promise<void>;
  stop(): void;
}

/**
 * Локальный маршрут звена: своя модель ядра (`local:own`, место панели `local:own:*`) или контур
 * локальной платформы шлюза человека. Маршрут без ключа сам по себе ещё не локальный — так
 * ходят и стенды проверок; `local:user:*` (свой адрес человека) может быть Ollama без `/slots`.
 */
export function isLocalRoute(routeId: string): boolean {
  return (
    routeId === 'local:own' ||
    routeId.startsWith('local:own:') ||
    routeId === contourRouteId(LOCAL_PLATFORM_ID)
  );
}

interface RouteState {
  route: string;
  origin: string;
  model: string | undefined;
  /** Запросы в полёте по номеру (порядок Map — порядок начала). */
  flights: Map<number, Flight>;
  motion: Motion;
  ticking: boolean;
}

interface Flight {
  at: number;
  /** Сколько всего токенов в промпте ЭТОГО запроса (подсчёт сервера), если известно. */
  total?: number;
}

/**
 * «Из скольких» для прочитанного слотом: итог самого раннего запроса в полёте, который не меньше
 * прочитанного. Итог — у каждого запроса свой: короткий запрос рядом (заголовок, квота CLI) не
 * сбрасывает и не подменяет итог длинного, а итог меньше прочитанного — другой промпт.
 */
function totalOf(flights: Map<number, Flight>, filled: number): number | undefined {
  for (const flight of flights.values())
    if (flight.total !== undefined && flight.total >= filled) return flight.total;
  return undefined;
}

const fresh = (now: number): Motion => ({
  phase: 'queued',
  filled: 0,
  decoded: 0,
  key: '',
  lastMoveAt: now,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function countable(entry: TagEntry, request: ActivityRequest, links: ActivityLinks): boolean {
  return (
    request.route === 'messages' &&
    entry.spec.from === 'anthropic-messages' &&
    entry.spec.to === 'anthropic-messages' &&
    // Немаскированное тело не уходит наверх ни в каком виде, пока на сеансе маска.
    !links.masking(entry)
  );
}

/** Тело подсчёта: только то, что считает `count_tokens` (без `stream`, `max_tokens`). */
function countBody(body: Record<string, unknown>): string {
  const out: Record<string, unknown> = { model: body.model, messages: body.messages };
  for (const key of ['system', 'tools', 'tool_choice', 'thinking'] as const)
    if (body[key] !== undefined) out[key] = body[key];
  return JSON.stringify(out);
}

export function createActivityBook(deps: ActivityDeps): ActivityBook {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const intervalMs = deps.intervalMs ?? ACTIVITY_INTERVAL_MS;
  const stallMs = deps.stallMs ?? HOP_STALL_GPU_MS;
  const slotTimeoutMs = deps.slotTimeoutMs ?? SLOT_TIMEOUT_MS;
  const countTimeoutMs = deps.countTimeoutMs ?? COUNT_TIMEOUT_MS;
  const routes = new Map<string, RouteState>();
  let timer: NodeJS.Timeout | undefined;
  let nextId = 1;

  const flying = (): RouteState[] => [...routes.values()].filter((r) => r.flights.size > 0);

  async function tickRoute(state: RouteState): Promise<void> {
    // Зовут только при открытом запросе (`flying()` и первый `begin`): проверять полёт здесь нечего.
    if (state.ticking) return;
    state.ticking = true;
    try {
      const reading = await readServer(state.origin, state.model, fetchImpl, slotTimeoutMs);
      // Запрос закрылся, пока шёл опрос, — его ответ этап `idle` не перебивает.
      if (state.flights.size === 0) return;
      state.motion = advance(state.motion, reading, deps.now());
    } finally {
      state.ticking = false;
    }
  }

  async function tick(): Promise<void> {
    await Promise.all(flying().map(tickRoute));
  }

  function startTimer(): void {
    if (timer) return;
    timer = setInterval(() => void tick(), intervalMs);
    timer.unref();
  }

  function stopTimerIfIdle(): void {
    if (!timer || flying().length > 0) return;
    clearInterval(timer);
    timer = undefined;
  }

  async function count(entry: TagEntry, request: ActivityRequest, flight: Flight): Promise<void> {
    const auth = deps.links.auth(entry, request.credential);
    if ('refusal' in auth) return;
    try {
      const response = await fetchImpl(deps.links.url(entry, '/v1/messages/count_tokens'), {
        method: 'POST',
        headers: {
          ...auth.headers,
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: countBody(request.body),
        signal: AbortSignal.timeout(countTimeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return;
      }
      const reply = (await response.json()) as unknown;
      const total = isRecord(reply) ? reply.input_tokens : undefined;
      // Поздний ответ закрытого запроса пишет в его же запись, которой в полёте уже нет.
      if (typeof total === 'number' && Number.isInteger(total) && total > 0) flight.total = total;
    } catch {
      // Подсчёт не вышел — строка покажет прочитанное без «из скольких».
    }
  }

  function begin(entry: TagEntry, request: ActivityRequest): (() => void) | undefined {
    const routeId = entry.spec.routeId;
    if (!isLocalRoute(routeId)) return undefined;
    if (request.path !== undefined && GOOGLE_COUNT.test(request.path)) return undefined;
    let origin: string;
    try {
      origin = new URL(entry.spec.upstream).origin;
    } catch {
      return undefined;
    }
    const at = deps.now();
    const model = typeof request.body.model === 'string' ? request.body.model : undefined;
    let state = routes.get(routeId);
    if (!state) {
      state = {
        route: routeId,
        origin,
        model,
        flights: new Map(),
        motion: fresh(at),
        ticking: false,
      };
      routes.set(routeId, state);
    }
    const first = state.flights.size === 0;
    if (first) state.motion = fresh(at);
    state.origin = origin;
    if (model) state.model = model;
    const id = nextId++;
    const flight: Flight = { at };
    state.flights.set(id, flight);
    if (countable(entry, request, deps.links)) void count(entry, request, flight);
    startTimer();
    if (first) void tickRoute(state);
    const own = state;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      own.flights.delete(id);
      if (own.flights.size === 0) own.motion = { ...own.motion, phase: 'idle' };
      stopTimerIfIdle();
    };
  }

  return {
    begin,

    beginRaw(entry, credential, path, body) {
      if (body === undefined || !isLocalRoute(entry.spec.routeId)) return undefined;
      const bare = path.split('?')[0]?.replace(/\/+$/, '') ?? '';
      const messages = bare.endsWith('/messages');
      if (!messages && !bare.endsWith('/chat/completions')) return undefined;
      const route = messages ? 'messages' : 'chat';
      let parsed: unknown;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        return undefined;
      }
      if (!isRecord(parsed)) return undefined;
      return begin(entry, { credential, route, body: parsed });
    },

    snapshot() {
      const at = deps.now();
      return [...routes.values()].map((state): HopActivity => {
        const inFlight = state.flights.size;
        const { motion } = state;
        const phase = inFlight > 0 ? motion.phase : 'idle';
        const active = phase === 'prompt' || phase === 'generating';
        const startedAt =
          inFlight > 0 ? Math.min(...[...state.flights.values()].map((f) => f.at)) : undefined;
        const total = totalOf(state.flights, motion.filled);
        return {
          route: state.route,
          ...(state.model ? { model: state.model } : {}),
          phase,
          inFlight,
          ...(startedAt !== undefined ? { startedAt } : {}),
          ...(active
            ? { prompt: { filled: motion.filled, ...(total !== undefined ? { total } : {}) } }
            : {}),
          ...(active ? { decoded: motion.decoded } : {}),
          lastMoveAt: motion.lastMoveAt,
          stalled: isStalled(motion, inFlight, at, stallMs),
        };
      });
    },

    tick,

    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
