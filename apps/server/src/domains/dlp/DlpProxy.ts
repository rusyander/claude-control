import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DlpRule, DlpStatus } from '@claude-control/contracts';
import { apiKindForPath, type DlpApiKind } from './api-shapes.ts';
import { AliasVault } from './mask.ts';
import { maskRequestBody } from './request-filter.ts';
import { ResponseStreamFilter, restoreJsonResponse } from './response-filter.ts';
import { appendJournal } from './journal.ts';

/**
 * Локальный прокси между CLI и моделью.
 *
 * CLI ходит в модель по адресу — если этот адрес указать сюда, панель видит
 * тело каждого запроса: промпт, содержимое прочитанных агентом файлов, вывод
 * инструментов. Это принципиально больше, чем видит хук на промпте, и
 * принципиально иначе, чем «свой эндпоинт»: тот решает, КУДА уходит запрос,
 * этот — ЧТО в нём уходит.
 *
 * Три вещи, заданные жёстко и не выносимые в настройки:
 *
 * 1. Слушатель поднимается ТОЛЬКО на 127.0.0.1. Прокси видит расшифрованные
 *    запросы вместе с ключами — доступ к нему из сети означал бы, что чужой
 *    может и читать чужие промпты, и ходить в модель за счёт хозяина.
 * 2. TLS не вскрывается. CLI обращается сюда по http, а наверх прокси идёт сам,
 *    обычным https-клиентом: ни подменных сертификатов, ни доверенных
 *    корневых, ни MITM. Оттого и настройка сводится к смене одного адреса.
 * 3. Тело, которое панель не разобрала, по умолчанию НЕ пропускается.
 *    Прокси, молча пропускающий непонятое, опаснее отсутствия прокси: он
 *    создаёт уверенность, которой не заслужил.
 */

/** Потолок тела запроса: больше — почти наверняка вложенный файл, а не промпт. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Заголовки соединения не пересылаются: они про ЭТОТ канал, а не про запрос. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'accept-encoding',
]);

export interface DlpRuntime {
  port: number;
  /** Куда пересылать — абсолютный адрес, уже разрешённый вызывающим. */
  upstream: string;
  rules: DlpRule[];
  passUnknown: boolean;
  journal: boolean;
  appDataDir: string;
}

export class DlpProxy {
  #server?: Server;
  #config?: DlpRuntime;
  #error?: string;
  #vault = new AliasVault();
  #stats = { requests: 0, masked: 0, blocked: 0 };

  get running(): boolean {
    return Boolean(this.#server?.listening);
  }

  status(): DlpStatus {
    return {
      running: this.running,
      address: this.#config ? `http://127.0.0.1:${this.#config.port}` : '',
      upstream: this.#config?.upstream ?? '',
      error: this.#error,
      ...this.#stats,
    };
  }

  /** Сколько значений сейчас в словаре меток (сами значения наружу не отдаются). */
  get vaultSize(): number {
    return this.#vault.size;
  }

  async start(config: DlpRuntime): Promise<void> {
    await this.stop();
    this.#error = undefined;
    this.#config = config;
    this.#stats = { requests: 0, masked: 0, blocked: 0 };

    const server = createServer((request, response) => {
      void this.#handle(request, response).catch(() => {
        respondJson(response, 502, { error: 'прокси не смог обработать запрос' });
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.on('error', (error: Error) => {
        this.#error = error.message;
        this.#server = undefined;
        reject(error);
      });
      // Только петлевой интерфейс — см. пункт 1 в шапке файла.
      server.listen(config.port, '127.0.0.1', () => resolve());
    });

    this.#server = server;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Словарь меток живёт вместе с прокси: остановили — забыли всё.
    this.#vault.clear();
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const config = this.#config;
    if (!config) return respondJson(response, 503, { error: 'прокси не настроен' });

    const path = request.url ?? '/';
    const kind = apiKindForPath(path);

    const raw = await readBody(request);
    if (raw === undefined)
      return respondJson(response, 413, { error: 'тело запроса слишком велико' });

    this.#stats.requests += 1;

    // Запрос без тела (список моделей, проверки живости) разбирать нечего:
    // пользовательских данных в нём нет, он идёт как есть.
    if (!raw.length) return this.#forward(config, request, response, undefined, kind, path);

    if (!kind) {
      return this.#unknownShape(
        config,
        request,
        response,
        path,
        raw,
        'форма запроса не разбирается',
      );
    }

    const masked = maskRequestBody(raw.toString('utf8'), kind, config.rules, this.#vault);
    if (!masked) {
      return this.#unknownShape(config, request, response, path, raw, 'тело запроса не JSON');
    }

    if (masked.blockedBy) {
      this.#stats.blocked += 1;
      this.#log(config, {
        path,
        apiKind: kind,
        decision: 'blocked',
        bytes: raw.length,
        hits: masked.hits,
        reason: masked.blockedBy.ruleName,
      });
      return respondBlocked(response, kind, masked.blockedBy.ruleName);
    }

    if (masked.hits.length) this.#stats.masked += 1;
    this.#log(config, {
      path,
      apiKind: kind,
      decision: masked.hits.length ? 'masked' : 'passed',
      bytes: raw.length,
      hits: masked.hits,
    });

    await this.#forward(config, request, response, masked.body, kind, path);
  }

  /**
   * Незнакомая форма: отклонить (по умолчанию) либо пропустить нетронутой, если
   * человек сознательно выбрал это в настройках. Пропуск ВСЕГДА попадает в
   * журнал — иначе такие запросы стали бы невидимой дырой.
   */
  async #unknownShape(
    config: DlpRuntime,
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    raw: Buffer,
    reason: string,
  ): Promise<void> {
    if (!config.passUnknown) {
      this.#stats.blocked += 1;
      this.#log(config, {
        path,
        apiKind: '',
        decision: 'blocked',
        bytes: raw.length,
        hits: [],
        reason,
      });
      return respondJson(response, 403, {
        error: `Claude Control: ${reason}, запрос остановлен (настройка «пропускать неразобранное» выключена)`,
      });
    }

    this.#log(config, {
      path,
      apiKind: '',
      decision: 'passed',
      bytes: raw.length,
      hits: [],
      reason,
    });
    await this.#forward(config, request, response, raw.toString('utf8'), undefined, path);
  }

  async #forward(
    config: DlpRuntime,
    request: IncomingMessage,
    response: ServerResponse,
    body: string | undefined,
    kind: DlpApiKind | undefined,
    path: string,
  ): Promise<void> {
    const controller = new AbortController();
    request.on('close', () => controller.abort());

    let upstream: Response;
    try {
      upstream = await fetch(joinUpstream(config.upstream, path), {
        method: request.method ?? 'GET',
        headers: forwardHeaders(request, body),
        body,
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch (error) {
      // Текст ошибки сети — без заголовков и без тела: там ключи.
      return respondJson(response, 502, {
        error: `Claude Control: адрес модели не отвечает (${describeError(error)})`,
      });
    }

    const contentType = upstream.headers.get('content-type') ?? '';
    const reverse = this.#vault.reverse();
    const headers = responseHeaders(upstream);

    if (kind && contentType.includes('text/event-stream')) {
      return streamThrough(response, upstream, headers, new ResponseStreamFilter(kind, reverse));
    }

    if (kind && contentType.includes('application/json')) {
      const text = await upstream.text();
      const restored = restoreJson(text, kind, reverse);
      headers.delete('content-length');
      response.writeHead(upstream.status, Object.fromEntries(headers));
      response.end(restored);
      return;
    }

    // Всё остальное (двоичное, текст ошибки, неизвестный тип) — байт в байт.
    const buffer = Buffer.from(await upstream.arrayBuffer());
    headers.delete('content-length');
    response.writeHead(upstream.status, Object.fromEntries(headers));
    response.end(buffer);
  }

  #log(config: DlpRuntime, entry: Omit<Parameters<typeof appendJournal>[1], 'at'>): void {
    if (!config.journal) return;
    appendJournal(config.appDataDir, { at: new Date().toISOString(), ...entry });
  }
}

/**
 * Адрес наверх: путь запроса приклеивается к настроенному. Префикс из настройки
 * добавляется только если его ещё нет — иначе шлюз с адресом `…/v1` и CLI,
 * который сам просит `/v1/messages`, дали бы `/v1/v1/messages`.
 */
export function joinUpstream(upstream: string, path: string): string {
  const base = new URL(upstream);
  const prefix = base.pathname.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const full = !prefix || suffix.startsWith(`${prefix}/`) ? suffix : `${prefix}${suffix}`;
  return `${base.origin}${full}`;
}

function forwardHeaders(request: IncomingMessage, body: string | undefined): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  // Сжатый ответ нельзя ни прочитать, ни подменить в нём метку, поэтому
  // просим несжатый: разжимать и пережимать поток ради этого — лишний риск.
  headers.set('accept-encoding', 'identity');
  if (body !== undefined) headers.set('content-length', String(Buffer.byteLength(body)));
  return headers;
}

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (
      lower === 'content-encoding' ||
      lower === 'content-length' ||
      lower === 'transfer-encoding'
    ) {
      return;
    }
    headers.set(name, value);
  });
  return headers;
}

async function streamThrough(
  response: ServerResponse,
  upstream: Response,
  headers: Headers,
  filter: ResponseStreamFilter,
): Promise<void> {
  response.writeHead(upstream.status, Object.fromEntries(headers));
  // Заголовки уходят сразу: поток событий тем и ценен, что первые токены
  // видны до конца ответа.
  response.flushHeaders();

  const body = upstream.body;
  if (!body) {
    response.end(filter.end());
    return;
  }

  const reader = body.getReader();
  // Многобайтовый символ тоже рвётся между кусками — decoder собирает его сам.
  const decoder = new TextDecoder();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (text) response.write(filter.push(text));
  }

  response.write(filter.push(decoder.decode()));
  response.end(filter.end());
}

function restoreJson(text: string, kind: DlpApiKind, reverse: ReadonlyMap<string, string>): string {
  try {
    return JSON.stringify(restoreJsonResponse(JSON.parse(text), kind, reverse));
  } catch {
    // Не JSON вопреки заголовку — отдаём как пришло, ничего не выдумывая.
    return text;
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

/**
 * Отказ в форме самого API: CLI разбирает ошибку по своей схеме, и понятный
 * текст доходит до человека, а не превращается в «unexpected response».
 */
function respondBlocked(response: ServerResponse, kind: DlpApiKind, ruleName: string): void {
  const message = `Claude Control: запрос остановлен правилом «${ruleName}» — в нём нашлись данные, которые не должны уходить в модель`;

  const payload =
    kind === 'anthropic'
      ? { type: 'error', error: { type: 'invalid_request_error', message } }
      : { error: { message, type: 'invalid_request_error', code: 'dlp_blocked' } };

  respondJson(response, 403, payload);
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}
