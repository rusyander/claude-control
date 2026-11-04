import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DlpJournalEntry, DlpRule } from '@agentdeck/contracts';
import type { HopDlpProxyConfig, HopDlpProxyState } from '@agentdeck/contracts/core/hops';
import { apiKindForPath, type DlpApiKind } from '@agentdeck/dlp/api-shapes';
import { appendJournal } from '@agentdeck/dlp/journal';
import { AliasVault } from '@agentdeck/dlp/mask';
import { maskRequestBody } from '@agentdeck/dlp/request-filter';
import { ResponseStreamFilter, restoreJsonResponse } from '@agentdeck/dlp/response-filter';
import { readRules } from '@agentdeck/dlp/rules-file';
import { LOOPBACK } from '../../platform/ports.ts';
import { hopText, localizeText, type TextLanguage } from '../gateway/texts.ts';
import { joinUpstream, readBody, respondJson } from '../http.ts';

/**
 * Прокси защиты данных человека на хосте звеньев (C3c, перенос `DlpProxy` панели). Человек сам
 * пишет в свой CLI адрес `http://127.0.0.1:<port>` — прокси видит тело каждого запроса (промпт,
 * прочитанные файлы, вывод инструментов), маскирует его правилами раздела «Защита данных» и
 * разворачивает метки в ответе. Хост переживает и ядро, и панель, поэтому прокси, как и шлюз
 * человека, живёт здесь: ядро только повторяет настройку из настроек панели.
 *
 * Жёстко, без настроек (как у прежнего прокси панели):
 * 1. Слушатель только на 127.0.0.1: прокси видит расшифрованные запросы вместе с ключами.
 * 2. TLS не вскрывается: CLI ходит сюда по http, наверх прокси идёт сам обычным клиентом.
 * 3. Ключа у прокси нет: заголовки доступа CLI уходят наверх как есть (в отличие от DLP-звена
 *    сеанса, где ключ подставляет звено).
 * 4. Тело, которое прокси не разобрал, не уходит, пока человек сам не выбрал «пропускать
 *    неразобранное», — и пропуск всегда попадает в журнал.
 */

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

const RETRY_MS = 1_000;

export interface DlpProxyOptions {
  /** Каталог данных панели: правила (`dlp-rules.json`) и журнал (`dlp-journal.jsonl`). */
  panelAppData: string | null;
  language: TextLanguage;
  now(): number;
  retryMs?: number;
  fetchImpl?: typeof fetch;
}

export interface DlpProxy {
  /** Открыть/перенастроить (`null` — закрыть). Тот же порт — без перепривязки, счётчики целы. */
  configure(config: HopDlpProxyConfig | null): Promise<HopDlpProxyState | null>;
  state(): HopDlpProxyState | null;
  stop(): Promise<void>;
}

interface Slot {
  port: number;
  server: Server;
  bound: boolean;
  since: number;
  timer?: NodeJS.Timeout;
}

type Stats = { requests: number; masked: number; blocked: number };

type JournalLine = Omit<DlpJournalEntry, 'at'>;

export function startDlpProxy(options: DlpProxyOptions): DlpProxy {
  const retryMs = options.retryMs ?? RETRY_MS;
  let config: HopDlpProxyConfig | null = null;
  let current: Slot | undefined;
  let lastError: string | null = null;
  let stats: Stats = { requests: 0, masked: 0, blocked: 0 };
  // Словарь меток живёт вместе с прокси: одна и та же почта во всех ходах — одна метка, и ответ
  // модели на прошлый ход разворачивается. Закрыли или сменили адрес наверх — забыли всё.
  let vault = new AliasVault();

  const language = (): TextLanguage => options.language;
  const text = (value: string): string => localizeText(value, language());

  const log = (entry: JournalLine): void => {
    if (!config?.journal || !options.panelAppData) return;
    appendJournal(options.panelAppData, { at: new Date(options.now()).toISOString(), ...entry });
  };

  const rules = (): DlpRule[] | { broken: string } => {
    if (!options.panelAppData) return [];
    try {
      return readRules(options.panelAppData);
    } catch (error) {
      return { broken: error instanceof Error ? error.message : String(error) };
    }
  };

  const forward = async (
    upstreamBase: string,
    request: IncomingMessage,
    response: ServerResponse,
    body: string | undefined,
    kind: DlpApiKind | undefined,
    path: string,
  ): Promise<void> => {
    const controller = new AbortController();
    response.on('close', () => {
      if (!response.writableFinished) controller.abort();
    });
    let upstream: Response;
    try {
      upstream = await (options.fetchImpl ?? fetch)(joinUpstream(upstreamBase, path), {
        method: request.method ?? 'GET',
        headers: forwardHeaders(request, body),
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch (error) {
      // Текст ошибки сети — без заголовков и без тела: там ключи.
      return respondJson(response, 502, {
        error: text(hopText('proxy-upstream-unreachable', { reason: describeError(error) })),
      });
    }
    const contentType = upstream.headers.get('content-type') ?? '';
    const reverse = vault.reverse();
    const headers = responseHeaders(upstream);
    if (kind && contentType.includes('text/event-stream')) {
      return streamThrough(response, upstream, headers, new ResponseStreamFilter(kind, reverse));
    }
    if (kind && contentType.includes('application/json')) {
      const raw = await upstream.text();
      response.writeHead(upstream.status, headers);
      response.end(restoreJson(raw, kind, reverse));
      return;
    }
    // Всё остальное (двоичное, текст ошибки, неизвестный тип) — байт в байт.
    const buffer = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, headers);
    response.end(buffer);
  };

  const unknownShape = async (
    active: HopDlpProxyConfig,
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    raw: Buffer,
    reason: string,
  ): Promise<void> => {
    const entry = { path, apiKind: '', bytes: raw.length, hits: [], reason };
    if (!active.passUnknown) {
      stats.blocked += 1;
      log({ ...entry, decision: 'blocked' });
      // 400, а не 403: отказ по настройке прокси, а не по доступу (см. respondBlocked).
      return respondJson(response, 400, {
        error: text(hopText('proxy-stopped-unparsed', { reason })),
      });
    }
    log({ ...entry, decision: 'passed' });
    await forward(active.upstream, request, response, raw.toString('utf8'), undefined, path);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const active = config;
    if (!active) {
      request.resume();
      return respondJson(response, 503, { error: text(hopText('proxy-failed')) });
    }
    const path = request.url ?? '/';
    const kind = apiKindForPath(path);
    const raw = await readBody(request);
    if (raw === undefined) {
      request.resume();
      return respondJson(response, 413, { error: text(hopText('proxy-body-too-large')) });
    }
    stats.requests += 1;
    // Запрос без тела (список моделей, проверка живости): данных нет — идёт как есть.
    if (!raw.length) return forward(active.upstream, request, response, undefined, kind, path);
    if (!kind)
      return unknownShape(active, request, response, path, raw, hopText('proxy-shape-unknown'));
    const set = rules();
    if (!Array.isArray(set)) {
      stats.blocked += 1;
      const reason = hopText('gateway-mask-rules-broken', { error: set.broken });
      log({ path, apiKind: kind, decision: 'blocked', bytes: raw.length, hits: [], reason });
      return respondBlockedText(
        response,
        kind,
        text(hopText('gateway-prefixed', { message: reason })),
      );
    }
    const masked = maskRequestBody(raw.toString('utf8'), kind, set, vault);
    if (!masked)
      return unknownShape(active, request, response, path, raw, hopText('proxy-body-not-json'));
    if (masked.blockedBy) {
      stats.blocked += 1;
      const rule = masked.blockedBy.ruleName;
      log({
        path,
        apiKind: kind,
        decision: 'blocked',
        bytes: raw.length,
        hits: masked.hits,
        reason: rule,
      });
      const message = hopText('gateway-prefixed', {
        message: hopText('gateway-mask-blocked', { rule }),
      });
      return respondBlockedText(response, kind, text(message));
    }
    if (masked.hits.length) stats.masked += 1;
    log({
      path,
      apiKind: kind,
      decision: masked.hits.length ? 'masked' : 'passed',
      bytes: raw.length,
      hits: masked.hits,
    });
    await forward(active.upstream, request, response, masked.body, kind, path);
  };

  const state = (): HopDlpProxyState | null =>
    current && config
      ? {
          port: current.port,
          state: current.bound ? 'listening' : 'waiting',
          since: current.since,
          upstream: config.upstream,
          lastError,
          ...stats,
        }
      : null;

  const close = (): Promise<void> => {
    const was = current;
    current = undefined;
    vault.clear();
    if (!was) return Promise.resolve();
    if (was.timer) clearTimeout(was.timer);
    if (!was.bound) return Promise.resolve();
    return new Promise<void>((done) => {
      was.server.close(() => done());
      was.server.closeAllConnections();
    });
  };

  const open = (port: number): Promise<void> => {
    const server = createServer((request, response) => {
      handle(request, response).catch(() => {
        if (!response.headersSent)
          respondJson(response, 502, { error: text(hopText('proxy-failed')) });
        else response.destroy();
      });
    });
    const slot: Slot = { port, server, bound: false, since: options.now() };
    current = slot;
    let firstSettled: () => void = () => undefined;
    const first = new Promise<void>((done) => (firstSettled = done));
    const tryListen = (): void => {
      if (current !== slot) return;
      // Только петлевой интерфейс — см. пункт 1 в шапке файла.
      server.listen({ host: LOOPBACK, port, exclusive: true });
    };
    server.on('listening', () => {
      slot.bound = true;
      slot.since = options.now();
      lastError = null;
      firstSettled();
    });
    server.on('error', (error: NodeJS.ErrnoException) => {
      lastError = error.code ?? error.message;
      firstSettled();
      if (slot.bound || current !== slot) return;
      // Порт занят (прежний прокси панели ещё держит его) — ждём, пока отпустят.
      slot.timer = setTimeout(tryListen, retryMs);
      slot.timer.unref();
    });
    tryListen();
    return first;
  };

  return {
    async configure(next) {
      const was = config;
      config = next;
      if (!next) {
        await close();
        return null;
      }
      // Другой адрес наверх — другие данные: метки прошлого адреса туда не едут.
      if (was && was.upstream !== next.upstream) vault = new AliasVault();
      if (current?.port !== next.port) {
        await close();
        stats = { requests: 0, masked: 0, blocked: 0 };
        // Ответ называет исход первой попытки (держит / порт занят), а не «ещё не пробовал».
        await open(next.port);
      }
      return state();
    },
    state,
    async stop() {
      config = null;
      await close();
    },
  };
}

function forwardHeaders(request: IncomingMessage, body: string | undefined): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  // Сжатый ответ нельзя ни прочитать, ни развернуть в нём метку — просим несжатый.
  headers.set('accept-encoding', 'identity');
  if (body !== undefined) headers.set('content-length', String(Buffer.byteLength(body)));
  return headers;
}

function responseHeaders(upstream: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower === 'content-encoding' || lower === 'content-length' || lower === 'transfer-encoding')
      return;
    headers[name] = value;
  });
  return headers;
}

async function streamThrough(
  response: ServerResponse,
  upstream: Response,
  headers: Record<string, string>,
  filter: ResponseStreamFilter,
): Promise<void> {
  response.writeHead(upstream.status, headers);
  // Заголовки уходят сразу: первые токены видны до конца ответа.
  response.flushHeaders();
  const body = upstream.body;
  if (!body) {
    response.end(filter.end());
    return;
  }
  const reader = body.getReader();
  // Многобайтовый символ рвётся между кусками — decoder собирает его сам.
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (chunk) response.write(filter.push(chunk));
  }
  response.write(filter.push(decoder.decode()));
  response.end(filter.end());
}

function restoreJson(text: string, kind: DlpApiKind, reverse: ReadonlyMap<string, string>): string {
  try {
    return JSON.stringify(restoreJsonResponse(JSON.parse(text) as unknown, kind, reverse));
  } catch {
    // Не JSON вопреки заголовку — отдаём как пришло, ничего не выдумывая.
    return text;
  }
}

/**
 * Отказ в форме самого API: CLI разбирает ошибку по своей схеме, и понятный текст доходит до
 * человека. 400, а не 403: Claude Code читает 403 как ошибку входа и чинил бы ключ вместо правила.
 */
function respondBlockedText(response: ServerResponse, kind: DlpApiKind, message: string): void {
  const payload =
    kind === 'anthropic'
      ? { type: 'error', error: { type: 'invalid_request_error', message } }
      : { error: { message, type: 'invalid_request_error', code: 'dlp_blocked' } };
  respondJson(response, 400, payload);
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}
