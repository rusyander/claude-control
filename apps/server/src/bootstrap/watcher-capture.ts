import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { WATCH_SEEN_HEADER } from '@agentdeck/contracts/watcher';
import { observeCliExits, observeSpawnFailures } from '../lib/cli-spawn.ts';
import { maskSecretsInText } from '../lib/secret-mask.ts';
import type { WatchSignal } from '../domains/watcher/types.ts';

/**
 * Откуда фоновый наблюдатель узнаёт о проблемах сервера — всё пассивно, ни
 * одного действия от имени человека:
 *   - ответ 5xx любого маршрута (текст и стек — из `onError` того же запроса);
 *   - ответ 4xx, который значит ошибку своего же интерфейса: 400/422 (тело не
 *     прошло схему — страница шлёт не то), 404 на путь `/api`, которому нет
 *     маршрута, и 409, повторившийся на одном маршруте по кругу. Прочие 4xx —
 *     отказ по существу (записи нет, доступа нет) и сбоем панели не считаются;
 *   - ответ дольше порога (`slowRequestMs`), кроме потоков событий;
 *   - записи уровня warn и error в журнале Fastify, которые сделал код панели.
 *     Собственная запись Fastify о 5xx пропускается: этот же сбой уже пришёл
 *     ответом 5xx;
 *   - необработанное исключение и отказ промиса — через
 *     `uncaughtExceptionMonitor`, который НЕ меняет поведения процесса (обычный
 *     `unhandledRejection` проглотил бы падение);
 *   - неудавшийся запуск CLI (`observeSpawnFailures`) и CLI, завершившийся с
 *     ненулевым кодом (`observeCliExits`) — так же приходят и ошибки
 *     провайдера: CLI сообщает о них кодом выхода.
 *
 * Записанный сервером сбой помечается заголовком `x-agentdeck-watch`: страница
 * по нему не шлёт тот же отказ второй раз.
 *
 * Приёмник — позднее связывание: журнал Fastify создаётся раньше, чем
 * долгоживущие объекты, а наблюдатель — один из них.
 */

export interface WatchSink {
  signal: (signal: WatchSignal) => boolean;
  /** Порог «медленного ответа»; нет — медленные не собираются. */
  readonly thresholds?: { slowRequestMs: number };
}

export interface WatchCapture {
  /** Поток журнала Fastify: пишет в stdout как раньше и подсматривает ошибки. */
  logStream: { write: (line: string) => void };
  attach: (sink: WatchSink) => void;
  /** Хуки на экземпляр — ДО маршрутов, иначе к ним они не применятся. */
  registerHooks: (app: FastifyInstance) => void;
}

const WARN_LEVEL = 40;
const ERROR_LEVEL = 50;
/** Цветовые коды терминала: ESC `[` … буква. ESC собран кодом — правило линтера против управляющих знаков в литерале. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');
const ERROR_LINE =
  /error|ошибк|fail|denied|invalid|unauthori[sz]ed|forbidden|overloaded|rate.?limit|quota|timed? ?out|not found|exception|fatal|refused/i;
const CAUSE_MAX = 200;

/**
 * Строка причины из stderr CLI: последняя с признаком ошибки (провайдер пишет
 * её в конце, после шума запуска), иначе последняя непустая. Без цветовых
 * кодов терминала и не длиннее `CAUSE_MAX`.
 */
export function stderrCause(stderr: string): string | undefined {
  const lines = stderr
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const line = [...lines].reverse().find((candidate) => ERROR_LINE.test(candidate)) ?? lines.at(-1);
  if (!line) return undefined;
  return line.length > CAUSE_MAX ? `${line.slice(0, CAUSE_MAX)}…` : line;
}

/** 409 на одном маршруте столько раз за окно — это круг, а не отказ по существу. */
export const CONFLICT_LOOP_COUNT = 3;
export const CONFLICT_LOOP_WINDOW_MS = 60_000;
/** Текст отказа из тела ответа — не больше: хватит на поиск по коду. */
const PAYLOAD_TEXT_MAX = 500;

function send(sink: WatchSink | undefined, signal: WatchSignal): boolean {
  if (!sink) return false;
  try {
    return sink.signal(signal);
  } catch {
    // Наблюдатель никогда не роняет то, за чем наблюдает.
    return false;
  }
}

/** Разбор строки журнала pino: ошибка или предупреждение кода панели → сигнал. */
export function logLineSignal(line: string): WatchSignal | undefined {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof entry.level !== 'number' || entry.level < WARN_LEVEL) return undefined;
  // Запись самого Fastify об ответе 5xx: у неё и `res`, и `err`. Этот сбой уже
  // пришёл из хука ответа — второй раз он был бы дублем.
  if (entry.res !== undefined && entry.err !== undefined) return undefined;
  const err = entry.err as { message?: unknown; stack?: unknown } | undefined;
  const isError = entry.level >= ERROR_LEVEL;
  const message =
    (typeof entry.msg === 'string' && entry.msg) ||
    (typeof err?.message === 'string' && err.message) ||
    (isError ? 'Ошибка в журнале без текста' : 'Предупреждение в журнале без текста');
  const errText = typeof err?.message === 'string' && err.message !== message ? err.message : '';
  return {
    source: 'server',
    kind: isError ? 'log-error' : 'log-warn',
    message: errText ? `${message}: ${errText}` : message,
    ...(typeof err?.stack === 'string' ? { stack: err.stack } : {}),
  };
}

/** Текст отказа из тела ответа: `message` JSON, иначе начало текста. */
export function payloadText(payload: unknown): string | undefined {
  const raw =
    typeof payload === 'string'
      ? payload
      : Buffer.isBuffer(payload)
        ? payload.toString('utf8')
        : undefined;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; error?: unknown; code?: unknown };
    const text =
      (typeof parsed.message === 'string' && parsed.message) ||
      (typeof parsed.error === 'string' && parsed.error) ||
      '';
    const code = typeof parsed.code === 'string' ? parsed.code : '';
    const joined = [code, text].filter(Boolean).join(': ');
    return joined ? joined.slice(0, PAYLOAD_TEXT_MAX) : undefined;
  } catch {
    return raw.trim().slice(0, PAYLOAD_TEXT_MAX) || undefined;
  }
}

function routeOf(request: FastifyRequest): string | undefined {
  return request.routeOptions?.url;
}

function pathOf(request: FastifyRequest): string {
  // Шаблон маршрута (`/api/chats/:id`), а не адрес с конкретным id: одинаковые
  // сбои разных записей — один сбой.
  return routeOf(request) ?? request.url.split('?')[0] ?? request.url;
}

export function createWatchCapture(
  out: { write: (line: string) => void } = process.stdout,
  now: () => number = Date.now,
): WatchCapture {
  let sink: WatchSink | undefined;
  /** Моменты 409 по маршруту — для «по кругу». */
  const conflicts = new Map<string, number[]>();

  const logStream = {
    write(line: string): void {
      out.write(line);
      const signal = logLineSignal(line);
      if (signal) send(sink, signal);
    },
  };

  /** Какой сигнал даёт этот ответ; `undefined` — никакого. */
  const responseSignal = (
    request: FastifyRequest,
    reply: FastifyReply,
    error: Error | undefined,
    payload: unknown,
  ): WatchSignal | undefined => {
    const status = reply.statusCode;
    const base = {
      source: 'server' as const,
      method: request.method,
      path: pathOf(request),
      status,
    };
    if (status >= 500) {
      return {
        ...base,
        kind: 'http-5xx',
        message: error?.message || payloadText(payload) || `Ответ ${status}`,
        ...(error?.stack ? { stack: error.stack } : {}),
      };
    }
    if (status === 400 || status === 422) {
      return {
        ...base,
        kind: 'http-4xx',
        message: payloadText(payload) || error?.message || `Ответ ${status}`,
      };
    }
    if (status === 404 && request.is404 && request.url.startsWith('/api/')) {
      return {
        ...base,
        path: request.url.split('?')[0] ?? request.url,
        kind: 'http-4xx',
        message: `Маршрута нет: ${request.method} ${request.url.split('?')[0]}`,
      };
    }
    if (status === 409) {
      const key = `${request.method} ${pathOf(request)}`;
      const at = now();
      const recent = (conflicts.get(key) ?? []).filter((t) => at - t < CONFLICT_LOOP_WINDOW_MS);
      recent.push(at);
      conflicts.set(key, recent);
      if (conflicts.size > 200) conflicts.clear();
      if (recent.length < CONFLICT_LOOP_COUNT) return undefined;
      conflicts.delete(key);
      return {
        ...base,
        kind: 'http-4xx',
        message: `409 по кругу: ${CONFLICT_LOOP_COUNT} раза за минуту — ${payloadText(payload) ?? 'конфликт'}`,
      };
    }
    return undefined;
  };

  const isEventStreamHeaders = (headers: unknown): boolean => {
    if (!headers || typeof headers !== 'object') return false;
    // writeHead принимает объект, массив пар или плоский массив «имя, значение, …».
    const pairs: unknown[][] = [];
    if (!Array.isArray(headers)) pairs.push(...Object.entries(headers));
    else if (headers.every(Array.isArray)) pairs.push(...(headers as unknown[][]));
    else for (let i = 0; i < headers.length; i += 2) pairs.push([headers[i], headers[i + 1]]);
    return pairs.some(
      ([name, value]) =>
        String(name).toLowerCase() === 'content-type' &&
        String(value).includes('text/event-stream'),
    );
  };

  const registerHooks = (app: FastifyInstance): void => {
    const errors = new WeakMap<object, Error>();
    // Чат, панельный агент и песочница открывают поток через `reply.raw.writeHead`
    // мимо Fastify: на настоящем сокете ни `reply.getHeader`, ни `raw.getHeader`
    // такой заголовок не видят. Без этой пометки каждый ход чата дольше порога
    // шёл «медленным ответом» в отчёт и в платный разбор (живой прогон 29.09).
    const rawStreams = new WeakSet<object>();
    app.addHook('onRequest', (_request, reply, done) => {
      const raw = reply.raw;
      const writeHead = raw.writeHead;
      raw.writeHead = function (this: typeof raw, ...args: unknown[]) {
        if (args.some(isEventStreamHeaders)) rawStreams.add(raw);
        return (writeHead as (...a: unknown[]) => typeof raw).apply(this, args);
      } as typeof raw.writeHead;
      done();
    });
    app.addHook('onError', (request, _reply, error, done) => {
      errors.set(request, error);
      done();
    });
    app.addHook('onSend', (request, reply, payload, done) => {
      if (reply.statusCode >= 400) {
        const signal = responseSignal(request, reply, errors.get(request), payload);
        if (signal && send(sink, signal)) reply.header(WATCH_SEEN_HEADER, 'seen');
      }
      done(null, payload);
    });
    app.addHook('onResponse', (request, reply, done) => {
      const limit = sink?.thresholds?.slowRequestMs;
      const type = String(reply.getHeader('content-type') ?? '');
      // Поток событий открыт, пока открыта страница, — его длительность не медлительность.
      const stream = type.includes('text/event-stream') || rawStreams.has(reply.raw);
      if (limit && reply.elapsedTime > limit && !stream) {
        send(sink, {
          source: 'server',
          kind: 'slow-request',
          method: request.method,
          path: pathOf(request),
          status: reply.statusCode,
          durationMs: Math.round(reply.elapsedTime),
          message: `Ответ дольше ${Math.round(limit / 100) / 10} с: ${Math.round(reply.elapsedTime)} мс`,
        });
      }
      done();
    });
  };

  return {
    logStream,
    attach(next) {
      sink = next;
      observeSpawnFailures((command, error) =>
        send(sink, {
          source: 'server',
          kind: 'spawn-failed',
          message: `Не запустился «${command}»: ${error.message}`,
          ...(error.stack ? { stack: error.stack } : {}),
        }),
      );
      observeCliExits(({ command, args, code, pid, stderr: raw }) => {
        // Хвост stderr уходит наблюдателю — модели и в отчёт. CLI и MCP-серверы
        // печатают при сбое токены и адреса прокси с паролем: маска до отправки.
        const stderr = raw ? maskSecretsInText(raw) : raw;
        // Причина из stderr — часть текста, а значит и отпечатка: «перегружен»
        // и «неверный ключ» — два раздела, один и тот же отказ дважды — один.
        const cause = stderr ? stderrCause(stderr) : undefined;
        send(sink, {
          source: 'server',
          kind: 'cli-exit',
          message: `«${command}» завершился с кодом ${code}${args.length ? ` (${args.slice(0, 3).join(' ')})` : ''}${cause ? `: ${cause}` : ''}`,
          ...(pid !== undefined ? { pid } : {}),
          ...(stderr ? { output: stderr } : {}),
        });
      });
      process.on('uncaughtExceptionMonitor', (error, origin) =>
        send(sink, {
          source: 'server',
          kind: 'process-crash',
          message: `${origin}: ${error instanceof Error ? error.message : String(error)}`,
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        }),
      );
    },
    registerHooks,
  };
}
