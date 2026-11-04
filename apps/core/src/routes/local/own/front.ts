import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
export { localFrontPortOf } from '@agentdeck/contracts/core/local-hold';
import { isReserved, LOOPBACK } from '../../../platform/ports.ts';
import type { HoldServed, HoldTarget } from './hold.ts';
import { matchRouterId, restoreModelName, restoreSseLines, type NameBack } from './model-id.ts';
import type { SlotCache } from '../../../platform/slot-cache.ts';
import {
  clampReplyTokens,
  dialectOf,
  estimateTokens,
  firstTokenTimeoutMs,
  LOCAL_REPLY_RESERVE_TOKENS,
  maxTokensOverflowMessage,
  needsPrecount,
  overflowOfUpstream,
  promptLimitOf,
  promptTooLongMessage,
  refusalBody,
  sessionOf,
  type WindowDialect,
} from './window.ts';

/**
 * Постоянный адрес своей модели (этап 10, зона C): CLI человека (settings.json переключателя
 * Claude, терминал, расширение редактора) ходит на один порт, а сервер аренды каждый запуск
 * получает новый. Ядро слушает этот порт и пересылает запрос серверу удержания как есть, потоком.
 *
 * Порт занят (прежний llama-server панели ещё держит его) — ядро пробует снова, пока порт не
 * освободится: переход без перерыва — порт берётся в тот миг, когда его отпустили.
 */

export interface LocalFrontOptions {
  port: number;
  /** `stale` — адрес, который только что не принял соединение (`LocalHold.target`). */
  target: (stale?: string) => Promise<HoldTarget>;
  /** Шаг повтора, пока порт занят. */
  retryMs?: number;
  note?: (event: string, data: Record<string, unknown>) => void;
  /** Кеш слота по разговорам (`platform/slot-cache.ts`): нет — слот не трогается. */
  slots?: SlotCache;
  /** Нижняя граница срока первого байта (`LOCAL_FIRST_TOKEN_FLOOR_MS`); проверки ставят короче. */
  firstByteFloorMs?: number;
}

export interface LocalFront {
  readonly port: number;
  readonly url: string;
  listening(): boolean;
  stop(): Promise<void>;
}

const RETRY_MS = 1_000;

/** Проба здоровья llama-server: 503 у неё значит «модель грузится», а не «сервера нет». */
const HEALTH_PATH = '/health';

function refuse(res: ServerResponse, type: string, message: string, path = ''): void {
  // Форма ошибки Anthropic Messages: её читает Claude Code; клиенты OpenAI читают `error.message`.
  // Проба `/health` при отказе — 404: панель и любой клиент llama-server читают 503 как «модель
  // грузится» и ждали бы загрузки, которой нет; 404 читается как «сервера модели нет».
  const status = path.split('?')[0] === HEALTH_PATH ? 404 : 503;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

function reply(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

/** Сколько ждать точного счёта у сервера, прежде чем остаться при оценке. */
const COUNT_TOKENS_TIMEOUT_MS = 20_000;

/** Точный счёт токенов у сервера (`/v1/messages/count_tokens`); нет ответа — `undefined`. */
async function exactTokens(origin: string, body: Buffer): Promise<number | undefined> {
  try {
    const response = await fetch(`${origin}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(COUNT_TOKENS_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const count = Number(((await response.json()) as { input_tokens?: unknown }).input_tokens);
    return Number.isFinite(count) && count > 0 ? count : undefined;
  } catch {
    return undefined;
  }
}

const MODELS_TIMEOUT_MS = 5_000;

/**
 * Имя удержанной модели у маршрутизатора (`model-id.ts`), раз на адрес: адрес сервера аренды
 * новый каждый запуск. Список не прочитан — имя удержания как есть, без запоминания.
 */
function createRouterIds(): (origin: string, model: string) => Promise<string> {
  const known = new Map<string, string>();
  return async (origin, model) => {
    const key = `${origin}\n${model}`;
    const cached = known.get(key);
    if (cached) return cached;
    try {
      const response = await fetch(`${origin}/models`, {
        signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
      });
      if (!response.ok) return model;
      const data = ((await response.json()) as { data?: unknown }).data;
      if (!Array.isArray(data)) return model;
      const ids = data
        .map((row: unknown) => (row as { id?: unknown } | null)?.id)
        .filter((id): id is string => typeof id === 'string');
      const id = matchRouterId(ids, model) ?? model;
      if (known.size > 16) known.clear();
      known.set(key, id);
      return id;
    } catch {
      return model;
    }
  };
}

/**
 * `?model=` запроса (`/props`, `/slots`) — имя маршрутизатора: за адресом одна удержанная модель,
 * как у прежнего сервера панели, которому имя было безразлично. Менять нечего — `undefined`.
 */
function pathWithModel(url: string, model: string): string | undefined {
  const at = url.indexOf('?');
  if (at < 0) return undefined;
  const query = new URLSearchParams(url.slice(at + 1));
  const asked = query.get('model');
  if (asked === null || asked === model) return undefined;
  query.set('model', model);
  return `${url.slice(0, at)}?${query.toString()}`;
}

/** Запрос после окна: тело для сервера, его токены, диалект и окно — для срока и подмены отказа. */
interface Windowed {
  body: Buffer;
  /** Путь с `?model=` маршрутизатора; нет — путь запроса как есть. */
  path?: string;
  promptTokens: number;
  dialect?: WindowDialect;
  context?: number;
  session?: string;
  firstByteMs?: number;
  /** Имя запроса сменено на имя маршрутизатора — ответ получает имя клиента обратно. */
  back?: NameBack;
}

/**
 * Ответ сервера клиенту. Имя не менялось — поток как есть. Менялось — поток SSE идёт дальше по
 * целым строкам с именем клиента (кадры не задерживаются дольше строки), тело JSON — целиком,
 * с пересчитанной длиной.
 */
function relay(
  answer: IncomingMessage,
  res: ServerResponse,
  status: number,
  back?: NameBack,
): void {
  if (!back) {
    res.writeHead(status, answer.headers);
    answer.pipe(res);
    return;
  }
  // Длина тела меняется: ни прежняя длина, ни прежний способ передачи с новой длиной не уживаются
  // (Content-Length рядом с Transfer-Encoding клиент отвергает); Node выберет способ сам.
  const headers = { ...answer.headers };
  delete headers['content-length'];
  delete headers['transfer-encoding'];
  if (String(answer.headers['content-type'] ?? '').includes('text/event-stream')) {
    res.writeHead(status, headers);
    let rest = '';
    answer.setEncoding('utf8');
    answer.on('data', (chunk: string) => {
      rest += chunk;
      const end = rest.lastIndexOf('\n');
      if (end < 0) return;
      res.write(restoreSseLines(rest.slice(0, end + 1), back));
      rest = rest.slice(end + 1);
    });
    answer.on('end', () => res.end(rest ? restoreSseLines(rest, back) : undefined));
    answer.on('error', (error) => res.destroy(error));
    return;
  }
  const chunks: Buffer[] = [];
  answer.on('data', (chunk: Buffer) => chunks.push(chunk));
  answer.on('end', () => {
    const raw = Buffer.concat(chunks);
    let out = raw;
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      if (restoreModelName(parsed, back)) out = Buffer.from(JSON.stringify(parsed));
    } catch {
      // Не JSON — как пришло.
    }
    res.writeHead(status, { ...headers, 'content-length': String(out.length) });
    res.end(out);
  });
  answer.on('error', (error) => res.destroy(error));
}

/**
 * Окно модели до пересылки: не влезающий промпт — отказ в диалекте клиента, Claude Code с
 * `max_tokens` сверх остатка — отказ, по которому он уменьшит его сам, клиент OpenAI — `max_tokens`
 * урезан здесь. Окно неизвестно или тело не JSON — запрос как есть. `undefined` — уже отказано.
 */
async function applyWindow(
  req: IncomingMessage,
  res: ServerResponse,
  served: HoldServed,
  body: Buffer,
): Promise<Windowed | undefined> {
  const dialect = dialectOf(req.method, req.url ?? '');
  const context = served.context;
  const path = pathWithModel(req.url ?? '/', served.model);
  const asIs = { body, promptTokens: 0, ...(path ? { path } : {}) };
  if (!dialect) return asIs;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return context ? { ...asIs, dialect, context } : asIs;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return context ? { ...asIs, dialect, context } : asIs;
  let record = parsed as Record<string, unknown>;
  // Имя модели человека (`qwen3.8:27b`) маршрутизатор не знает (`model-id.ts`): за адресом одна
  // удержанная модель — запрос идёт ей, как шёл прежнему серверу панели.
  const asked = record.model;
  // Ответ уходит клиенту с ЕГО именем модели (`restoreModelName`), не с именем маршрутизатора.
  const back: NameBack | undefined =
    typeof asked === 'string' && asked !== served.model
      ? { routerId: served.model, asked }
      : undefined;
  if (back) record = { ...record, model: served.model };
  const sent = back ? Buffer.from(JSON.stringify(record)) : body;
  const named = back ? { back } : {};
  if (!context) return { ...asIs, ...named, body: sent };
  let promptTokens = estimateTokens(body.length);
  // Оценка по символам промахивается на плотном выводе (код, JSON): у края окна — точный счёт.
  if (dialect === 'anthropic' && needsPrecount(promptTokens, context))
    promptTokens = (await exactTokens(served.origin, sent)) ?? promptTokens;
  if (promptTokens + LOCAL_REPLY_RESERVE_TOKENS > context) {
    reply(
      res,
      400,
      refusalBody(
        dialect,
        'invalid_request_error',
        promptTooLongMessage(promptTokens, promptLimitOf(context)),
        'context_length_exceeded',
      ),
    );
    return undefined;
  }
  let out = sent;
  if (dialect === 'anthropic') {
    const reduce = maxTokensOverflowMessage(promptTokens, record.max_tokens, context);
    if (reduce) {
      reply(res, 400, refusalBody(dialect, 'invalid_request_error', reduce));
      return undefined;
    }
  } else {
    const clamped = clampReplyTokens(record, promptTokens, context);
    if (clamped) out = Buffer.from(JSON.stringify(clamped));
  }
  const session = sessionOf(record);
  return {
    ...asIs,
    ...named,
    body: out,
    promptTokens,
    dialect,
    context,
    ...(session ? { session } : {}),
  };
}

/** Соединение с сервером модели не установилось: сервер умер, порт закрыт — повтор через подъём. */
const DEAD_UPSTREAM = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE']);

/**
 * Переслать запрос серверу модели потоком. `onDead` — соединение не установилось и ответ ещё
 * не начат: вызывающий поднимает сервер и повторяет тот же запрос (тело уже прочитано).
 */
function forward(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string,
  windowed: Windowed,
  onDead?: (error: Error) => void,
): void {
  const url = new URL(windowed.path ?? req.url ?? '/', origin);
  const { body } = windowed;
  // Тело могло измениться (урезанный `max_tokens`): длина — его, не исходного запроса.
  const headers = { ...req.headers, host: url.host, 'content-length': String(body.length) };
  delete headers['transfer-encoding'];
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const upstream = request(
    {
      host: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: req.method,
      headers,
    },
    (answer) => {
      if (timer) clearTimeout(timer);
      const status = answer.statusCode ?? 502;
      // 400 сервера «не влезает в окно» клиент не узнаёт: подменяется отказом, который он узнаёт.
      if (status === 400 && windowed.dialect && windowed.context) {
        const dialect = windowed.dialect;
        const chunks: Buffer[] = [];
        answer.on('data', (chunk: Buffer) => chunks.push(chunk));
        answer.on('end', () => {
          const raw = Buffer.concat(chunks);
          let overflow: ReturnType<typeof overflowOfUpstream>;
          try {
            overflow = overflowOfUpstream(status, JSON.parse(raw.toString('utf8')));
          } catch {
            overflow = undefined;
          }
          if (!overflow) {
            res.writeHead(status, answer.headers);
            res.end(raw);
            return;
          }
          reply(
            res,
            400,
            refusalBody(
              dialect,
              'invalid_request_error',
              promptTooLongMessage(overflow.tokens, promptLimitOf(overflow.context)),
              'context_length_exceeded',
            ),
          );
        });
        return;
      }
      relay(answer, res, status, windowed.back);
    },
  );
  // Срок первого байта по длине промпта: разбор 130 тысяч токенов законно идёт минуты.
  const firstByteMs = windowed.firstByteMs;
  if (firstByteMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      upstream.destroy();
      if (res.headersSent) return;
      reply(
        res,
        504,
        refusalBody(
          windowed.dialect ?? 'anthropic',
          'local_first_byte_timeout',
          `model server sent nothing for ${Math.round(firstByteMs / 1000)} s (prompt ~${windowed.promptTokens} tokens)`,
        ),
      );
    }, firstByteMs);
    timer.unref();
  }
  upstream.on('error', (error: NodeJS.ErrnoException) => {
    if (timer) clearTimeout(timer);
    if (timedOut) return;
    if (res.headersSent) res.destroy(error);
    else if (onDead && error.code !== undefined && DEAD_UPSTREAM.has(error.code)) onDead(error);
    else refuse(res, 'local_upstream_error', `model server did not answer: ${error.message}`);
  });
  // Клиент ушёл посреди ответа — сервер модели не продолжает генерацию впустую.
  res.on('close', () => {
    if (timer) clearTimeout(timer);
    if (!res.writableFinished) upstream.destroy();
  });
  upstream.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => done(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

export function startLocalFront(options: LocalFrontOptions): LocalFront {
  if (isReserved(options.port))
    throw new Error(`local front port ${options.port} is in the reserved range 5170-5180`);
  const retryMs = options.retryMs ?? RETRY_MS;
  let bound = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let busyNoted = false;
  const routerIdOf = createRouterIds();
  const server = createServer((req, res) => {
    // Тело читается целиком до пересылки: сервер, умерший мгновение назад (сбой, ООМ), узнаётся
    // по отказу соединения, и тот же запрос уходит поднятому заново — человек не видит ошибки.
    const answer = async (): Promise<void> => {
      const body = await readBody(req);
      const held = await options.target();
      if (!('origin' in held)) return refuse(res, held.refused, held.reason, req.url);
      const first: HoldServed = { ...held, model: await routerIdOf(held.origin, held.model) };
      const windowed = await applyWindow(req, res, first, body);
      if (!windowed) return;
      // Разговор сменился — кеш слота прежнего на диск, этого из файла (до запроса, не после).
      if (options.slots && windowed.dialect) {
        await options.slots.prepare(windowed.session, {
          origin: first.origin,
          model: first.model,
          shape: first.shape,
          dir: first.slotDir,
        });
        options.slots.noteTokens(windowed.promptTokens);
      }
      const timed: Windowed = windowed.dialect
        ? {
            ...windowed,
            firstByteMs: firstTokenTimeoutMs(
              windowed.promptTokens,
              first.promptTokensPerSecond,
              options.firstByteFloorMs,
            ),
          }
        : windowed;
      forward(req, res, first.origin, timed, (error) => {
        options.note?.('local.front', { state: 'upstream-dead', reason: error.message });
        options
          .target(first.origin)
          .then((again) => {
            if ('origin' in again) forward(req, res, again.origin, timed);
            else refuse(res, again.refused, again.reason, req.url);
          })
          .catch((retryError: unknown) => {
            refuse(
              res,
              'local_front_error',
              retryError instanceof Error ? retryError.message : String(retryError),
              req.url,
            );
          });
      });
    };
    answer().catch((error: unknown) => {
      refuse(
        res,
        'local_front_error',
        error instanceof Error ? error.message : String(error),
        req.url,
      );
    });
  });
  const tryListen = (): void => {
    if (stopped) return;
    server.listen({ host: LOOPBACK, port: options.port, exclusive: true });
  };
  server.on('listening', () => {
    bound = true;
    options.note?.('local.front', { port: options.port, state: 'listening' });
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (bound) {
      options.note?.('local.front', { port: options.port, state: 'error', reason: error.message });
      return;
    }
    // Занят — ждём, пока отпустят; о занятости журнал слышит один раз, не каждую секунду.
    if (!busyNoted) {
      busyNoted = true;
      options.note?.('local.front', {
        port: options.port,
        state: 'busy',
        reason: error.code ?? error.message,
      });
    }
    timer = setTimeout(tryListen, retryMs);
    timer.unref();
  });
  tryListen();
  return {
    port: options.port,
    url: `http://${LOOPBACK}:${options.port}`,
    listening: () => bound,
    stop: () =>
      new Promise<void>((done) => {
        stopped = true;
        if (timer) clearTimeout(timer);
        if (!bound) {
          done();
          return;
        }
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
