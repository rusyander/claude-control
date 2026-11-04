/**
 * Сервер заглушки: слушает только loopback, на порту 0 (ОС даёт свободный) или на
 * порту вызывающего — кроме 5170–5180 (порты панели, шлюза и DLP). Модельный запрос
 * → протокол по пути → шаг сценария → запись в `requests` и в след → ответ
 * (поток SSE, если клиент просил `stream: true`, иначе JSON).
 *
 * Задержки: `holdMs` — до первого байта ответа (модель «думает», ход занят);
 * `stallMs` — после начала потока, до содержимого (зависший поток — то, что шлюз
 * переводит в 529). Пока идёт любая из них, `holding()` — правда. Клиент ушёл или
 * заглушку закрыли — ожидание обрывается сразу, ответ не пишется; уход клиента
 * помечается в записи запроса (`aborted`) — так проверка видит, что CLI оборвал
 * запрос сам. `release()` — досрочный конец всех текущих ожиданий: ответ идёт сразу.
 *
 * `route` — свои пути вызывающего (здоровье и слоты llama-server, метка хода):
 * вызывается на КАЖДЫЙ запрос до путей пакета; вернул ответ — он и уходит, вернул
 * `undefined` — запрос идёт дальше (так он же служит наблюдателем всех запросов).
 */
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { clearTimeout, setTimeout } from 'node:timers';
import { DIALECTS, detectDialect } from './dialects/index.mjs';
import { compileScript, normalizeStep, replyLabel } from './script.mjs';
import { SSE_HEADERS, frame } from './sse.mjs';
import { redactBody, redactHeaders, redactRaw, redactUrl, traceWriter } from './trace.mjs';

/** Порты панели (5178), фронта и шлюза/DLP (5179) и соседей — заглушка их не берёт. */
export const RESERVED_PORTS = Object.freeze({ from: 5170, to: 5180 });

const OPTION_KEYS = new Set(['port', 'trace', 'script', 'models', 'route']);

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Самая длинная задержка одного таймера Node (больше — TimeoutOverflowWarning и 1 мс). */
const MAX_TIMER_MS = 2 ** 31 - 1;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Список моделей, понятный всем клиентам: OpenAI (`object`, `owned_by`), Anthropic (`type`,
 * `has_more`) и Google (`models[].name` вида `models/<id>`, `supportedGenerationMethods`).
 */
function modelList(models) {
  return {
    models: models.map((id) => ({
      name: `models/${id}`,
      displayName: id,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    })),
    object: 'list',
    data: models.map((id) => ({
      id,
      object: 'model',
      type: 'model',
      created: 0,
      created_at: '1970-01-01T00:00:00Z',
      owned_by: 'stub',
      display_name: id,
    })),
    has_more: false,
    first_id: models[0] ?? null,
    last_id: models.at(-1) ?? null,
  };
}

/**
 * Тело запроса: `json` — разобралось ли, `object` — объект ли это. `route` получает тело
 * только объектом (`5`, `null`, массив — `undefined`, как обещает `RouteRequest.body`);
 * запись модельного запроса — `{}` вместо не-объекта.
 */
function parseJson(raw) {
  if (!raw) return { body: {}, json: true, object: false };
  try {
    const body = JSON.parse(raw);
    const object = typeof body === 'object' && body !== null && !Array.isArray(body);
    return { body: object ? body : {}, json: true, object };
  } catch {
    return { body: {}, json: false, object: false };
  }
}

/** Тело для следа (F-78): JSON — без полей доступа на любой глубине, форма — без их значений. */
function traceBody(raw, json) {
  if (!raw) return {};
  if (json) return redactBody(JSON.parse(raw));
  return redactRaw(raw);
}

export function startStubModel(options = {}) {
  for (const key of Object.keys(options))
    if (!OPTION_KEYS.has(key)) throw new TypeError(`stub-model: unknown option «${key}»`);
  const { port = 0, trace, script, models = ['stub-model'], route } = options;
  if (route !== undefined && typeof route !== 'function')
    throw new TypeError('stub-model: route must be a function');
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new RangeError(`stub-model: port ${port} is not a TCP port`);
  if (port >= RESERVED_PORTS.from && port <= RESERVED_PORTS.to)
    throw new RangeError(
      `stub-model: port ${port} is reserved (${RESERVED_PORTS.from}–${RESERVED_PORTS.to})`,
    );
  const resolveStep = compileScript(script);
  const writeTrace = traceWriter(trace);
  const requests = [];
  const bodies = [];
  const sleepers = new Set();
  let holding = 0;
  let closing = false;

  /** Ждать `ms`; `false` — оборвано (клиент ушёл, заглушку закрыли). */
  const sleep = (ms, res) =>
    new Promise((done) => {
      if (closing || res.destroyed) {
        done(false);
        return;
      }
      const entry = {};
      const onClose = () => entry.finish(false);
      entry.finish = (completed) => {
        clearTimeout(entry.timer);
        sleepers.delete(entry);
        res.off('close', onClose);
        done(completed);
      };
      // Таймер Node держит не больше 2^31−1 мс: больше (и `Infinity`) он сводит к 1 мс, и
      // удержание пропадало бы (F-76). Поэтому длинное ожидание идёт отрезками, а
      // `Infinity` таймера не ставит вовсе — конец только по release()/close()/уходу клиента.
      const arm = (left) => {
        if (left === Infinity) return;
        const slice = Math.min(left, MAX_TIMER_MS);
        entry.timer = setTimeout(
          () => (left > slice ? arm(left - slice) : entry.finish(true)),
          slice,
        );
      };
      arm(ms);
      sleepers.add(entry);
      res.on('close', onClose);
    });

  const hold = async (ms, res) => {
    holding += 1;
    try {
      return await sleep(ms, res);
    } finally {
      holding -= 1;
    }
  };

  const writeFrames = (res, frames) => {
    for (const [event, data] of frames) if (!res.destroyed) res.write(frame(event, data));
  };

  /** Ожидание оборвано: клиент ушёл сам (не закрытие заглушки) — пометка в записи. */
  const cut = (record) => {
    if (!closing) record.aborted = true;
  };

  async function respond(res, dialect, step, meta, record) {
    const headers = {
      ...(step.window && dialect.windowHeaders
        ? dialect.windowHeaders(step.window, nowSeconds())
        : {}),
      ...step.headers,
    };
    if (step.holdMs && !(await hold(step.holdMs, res))) return cut(record);
    if (step.error && (!step.error.midStream || !meta.stream)) {
      const retry =
        step.error.retryAfter === undefined ? {} : { 'retry-after': String(step.error.retryAfter) };
      sendJson(res, step.error.status, dialect.errorBody(step.error), { ...headers, ...retry });
      return;
    }
    if (!meta.stream) {
      sendJson(res, 200, dialect.json(meta, step.parts), headers);
      return;
    }
    if (res.destroyed) return;
    res.socket?.setNoDelay(true);
    res.writeHead(200, { ...SSE_HEADERS, ...headers });
    writeFrames(res, dialect.head(meta, step.parts));
    if (step.stallMs && !(await hold(step.stallMs, res))) return cut(record);
    writeFrames(
      res,
      step.error ? dialect.failFrames(meta, step.error) : dialect.body(meta, step.parts),
    );
    res.end();
  }

  /**
   * Поток пути вызывающего: кадры пишет пакет, а не сценарий — так у чужой формы провода
   * (вендорные кадры контура) нет своего кода SSE (P120). Задержка — перед каждым кадром,
   * обрываемая, как удержание модели: клиент ушёл — кадры больше не пишутся.
   */
  async function routeStream(res, status, own) {
    const { frames, delayMs = 0 } = own.sse;
    if (!Array.isArray(frames))
      throw new TypeError('stub-model: route sse.frames must be an array');
    res.socket?.setNoDelay(true);
    res.writeHead(status, { ...SSE_HEADERS, ...own.headers });
    // Заголовки уходят сразу, до первой задержки: клиент видит начатый поток, как у контура.
    res.flushHeaders();
    for (const item of frames) {
      if (delayMs && !(await sleep(delayMs, res))) return;
      if (!res.destroyed) res.write(frame(item.event, item.data));
    }
    res.end();
  }

  async function handle(req, res) {
    const raw = await readBody(req);
    const url = req.url ?? '/';
    const path = url.split('?')[0].replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    const base = {
      at: new Date().toISOString(),
      method,
      path: redactUrl(url),
      headers: redactHeaders(req.headers),
    };
    const { body, json, object } = parseJson(raw);

    if (route) {
      const query = url.includes('?') ? url.slice(url.indexOf('?')) : '';
      const own = await route({
        method,
        path,
        query,
        headers: req.headers,
        raw,
        body: object ? body : undefined,
      });
      if (own) {
        const status = own.status ?? 200;
        writeTrace({ ...base, kind: 'route', status });
        if (res.destroyed || res.writableEnded) return;
        if (own.sse) {
          await routeStream(res, status, own);
          return;
        }
        const text = typeof own.body === 'string';
        res.writeHead(status, {
          'content-type': text ? 'text/plain; charset=utf-8' : 'application/json',
          ...own.headers,
        });
        res.end(text ? own.body : JSON.stringify(own.body ?? {}));
        return;
      }
    }

    if (method === 'GET' && /\/models$/.test(path)) {
      writeTrace({ ...base, kind: 'models', status: 200 });
      sendJson(res, 200, modelList(models));
      return;
    }
    for (const candidate of DIALECTS) {
      const utility = candidate.utility?.(method, path, raw);
      if (!utility) continue;
      writeTrace({ ...base, kind: 'utility', dialect: candidate.id, status: utility.status });
      sendJson(res, utility.status, utility.body);
      return;
    }
    const dialect = detectDialect(method, path);
    if (!dialect) {
      writeTrace({ ...base, kind: 'unknown', status: 404, body: traceBody(raw, json) });
      sendJson(res, 404, {
        error: {
          message: `stub-model: no model route for ${method} ${path}`,
          type: 'not_found_error',
        },
      });
      return;
    }

    const info = dialect.inspect(body, { path });
    const record = {
      n: requests.length + 1,
      ...base,
      dialect: dialect.id,
      model: info.model,
      stream: info.stream,
      userTexts: info.userTexts,
      tools: info.tools.map((tool) => tool.name),
      hasToolResult: info.hasToolResult,
      raw,
      body,
    };
    requests.push(record);
    bodies.push(raw);
    const ctx = {
      index: record.n - 1,
      request: record,
      requests,
      bodies,
      dialect: dialect.id,
      info,
    };
    let step;
    try {
      step = normalizeStep(await resolveStep(ctx));
      const foreign = step.parts.find((part) => !dialect.parts.includes(part.kind));
      if (foreign)
        throw new TypeError(`step part «${foreign.kind}» does not exist in ${dialect.id}`);
      // Заголовков окна у протокола нет (Gemini API) — отказ, а не придуманные заголовки.
      if (step.window && !dialect.windowHeaders)
        throw new TypeError(`step window does not exist in ${dialect.id}`);
    } catch (error) {
      record.scriptError = error instanceof Error ? error.message : String(error);
      step = normalizeStep({ text: `STUB SCRIPT FAILED: ${record.scriptError}` });
    }
    record.reply = replyLabel(step);
    record.status = step.error && (!step.error.midStream || !info.stream) ? step.error.status : 200;
    writeTrace({
      n: record.n,
      ...base,
      kind: 'model',
      dialect: dialect.id,
      model: info.model,
      stream: info.stream,
      status: record.status,
      reply: record.reply,
      ...(record.scriptError ? { scriptError: record.scriptError } : {}),
      body: traceBody(raw, json),
    });
    if (closing) return;
    const meta = {
      n: record.n,
      // `step.model` — модель, которую «назвал» маршрут вместо запрошенной (подмена, P119).
      model: step.model ?? info.model ?? models[0] ?? 'stub-model',
      created: nowSeconds(),
      usage: step.usage,
      extra: step.extra,
      includeUsage: info.includeUsage === true,
      stream: info.stream,
      seq: 0,
    };
    await respond(res, dialect, step, meta, record);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent)
        sendJson(res, 500, { error: { message: `stub-model: ${error?.message ?? error}` } });
      else res.destroy();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const bound = server.address().port;
      resolve({
        port: bound,
        baseUrl: `http://127.0.0.1:${bound}`,
        requests,
        bodies,
        holding: () => holding > 0,
        release: () => {
          for (const sleeper of [...sleepers]) sleeper.finish(true);
        },
        close: () =>
          new Promise((done) => {
            closing = true;
            for (const sleeper of [...sleepers]) sleeper.finish(false);
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
