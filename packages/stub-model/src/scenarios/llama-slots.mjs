/**
 * Грань «сервер моделей llama.cpp» над `@agentdeck/stub-model` (P120, этап 11 W2-5): `/health`,
 * `/slots` и `count_tokens` того вида, который читает лента хода звена (`hop-host/activity`).
 * Модельные пути (`/v1/messages`, `/v1/chat/completions`) отвечает сам пакет — своего кода SSE
 * здесь нет, только `route` поверх того же сокета.
 *
 * Ход сервера — лента шагов: каждый опрос начинается с `/health`, и он берёт следующий шаг ленты
 * (последний держится, пока ленту не сменят). `/slots` отвечает шагом, который взял последний
 * `/health`, — так один опрос звена видит одно согласованное состояние. Шаг:
 * - `health`: `ok` (200), `loading` (503 «Loading model»), `down` (500 — сервера нет);
 * - `slot`: `{ processing, filled, decoded }` → слот 0 в форме llama-server (`is_processing`,
 *   `n_prompt_tokens` — прочитанная часть промпта, `next_token[0].n_decoded` — токены ответа);
 * - `repeat`: сколько опросов шаг держится (по умолчанию один).
 * Застой — тот же шаг с `repeat` больше предела: движения нет, сервер жив.
 *
 * `hits` считает обращения к каждому пути: проверка «без запроса в полёте — ни одного опроса»
 * читает его (и след пакета, `kind: 'route'`).
 */
import { startStubModel } from '../server.mjs';

const LOADING = { status: 503, body: { error: { message: 'Loading model', code: 503 } } };

/** Слот 0 в форме ответа `GET /slots` llama-server. */
function slotJson(slot, nCtx) {
  return [
    {
      id: 0,
      n_ctx: nCtx,
      is_processing: slot?.processing === true,
      n_prompt_tokens: slot?.filled ?? 0,
      next_token: [{ has_next_token: true, n_remain: -1, n_decoded: slot?.decoded ?? 0 }],
    },
  ];
}

/** Лента шагов, развёрнутая по `repeat`: шаг на опрос. */
function unroll(timeline) {
  if (!Array.isArray(timeline)) throw new TypeError('llama-slots: timeline must be an array');
  const out = [];
  for (const step of timeline) {
    const times = step.repeat ?? 1;
    if (!Number.isInteger(times) || times < 1)
      throw new RangeError('llama-slots: repeat must be a positive integer');
    for (let i = 0; i < times; i += 1) out.push(step);
  }
  return out;
}

/**
 * `route` для `startStubModel`: пути сервера моделей по ленте. Остальные пути — `undefined`,
 * дальше пакету.
 */
export function llamaSlotsRoute(options = {}) {
  const nCtx = options.nCtx ?? 8192;
  const hits = options.hits ?? { health: 0, slots: 0, count: 0 };
  let steps = unroll(options.timeline ?? [{ health: 'ok' }]);
  let seen = 0;
  let current = steps[0];
  const route = ({ method, path, body }) => {
    if (method === 'GET' && path === '/health') {
      hits.health += 1;
      current = steps[Math.min(seen, steps.length - 1)] ?? { health: 'ok' };
      seen += 1;
      if (current.health === 'loading') return LOADING;
      if (current.health === 'down')
        return { status: 500, body: { error: { message: 'down', code: 500 } } };
      return { body: { status: 'ok' } };
    }
    if (method === 'GET' && path === '/slots') {
      hits.slots += 1;
      return { body: slotJson(current?.slot, nCtx) };
    }
    if (method === 'POST' && /\/messages\/count_tokens$/.test(path)) {
      hits.count += 1;
      // Число не задано — счёт пакета (длина тела / 4), как у диалекта Anthropic.
      if (options.promptTotal === undefined) return undefined;
      // Функция — свой итог на каждый запрос (два запроса в полёте с разными промптами).
      const total =
        typeof options.promptTotal === 'function' ? options.promptTotal(body) : options.promptTotal;
      return { body: { input_tokens: total } };
    }
    return undefined;
  };
  return {
    route,
    hits,
    /** Новая лента с начала (следующий опрос берёт её первый шаг). */
    play(timeline) {
      steps = unroll(timeline);
      seen = 0;
      current = steps[0];
    },
  };
}

/**
 * Сервер моделей целиком: пакет со сценарием модельных ответов и грань путей llama-server.
 * `trace` — файл следа пакета (каждое обращение к `/slots` в нём строкой `kind: 'route'`).
 */
export async function startLlamaSlotsStub(options = {}) {
  const facet = llamaSlotsRoute(options);
  const observe = options.observe;
  const stub = await startStubModel({
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.trace === undefined ? {} : { trace: options.trace }),
    ...(options.models === undefined ? {} : { models: options.models }),
    script: options.script ?? ['ok'],
    route: (request) => {
      observe?.(request);
      return facet.route(request);
    },
  });
  return {
    stub,
    url: stub.baseUrl,
    port: stub.port,
    hits: facet.hits,
    play: facet.play,
    close: () => stub.close(),
  };
}
