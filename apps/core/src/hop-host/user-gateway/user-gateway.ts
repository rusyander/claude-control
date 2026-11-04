import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  HOP_USER_GATEWAY_PORT,
  hopTranslates,
  type HopUserGatewayState,
  type HopRegistration,
} from '@agentdeck/contracts/core/hops';
import type { Dialect } from '@agentdeck/contracts/core/routes';
import {
  foreignProviderId,
  parseSectionPath,
  SECTION_SEGMENT,
} from '@agentdeck/contracts/platform-consumers';
import { isReserved, LOOPBACK } from '../../platform/ports.ts';
import { sessionContext, type HopContext } from '../context.ts';
import { edgeRouteOf, type EdgeRoute } from '../gateway/edge.ts';
import { googleResponse } from '../gateway/google-bridge/google-bridge.ts';
import { kindOfRoute, serveGatewayEntry } from '../gateway/handler.ts';
import { hopText } from '../gateway/texts.ts';
import type { TagEntry } from '../host.types.ts';
import { refuse, respondJson } from '../http.ts';
import { credentialOf } from '../tags.ts';

/**
 * Шлюз человека на хосте звеньев (этап 10, план §0 и Q3): CLI человека (переключатель Claude,
 * Codex, Gemini, терминал) ходит на ОДИН постоянный адрес `http://127.0.0.1:5179/<контур>/v1/...`
 * — тот же, что писал прежний шлюз панели, поэтому конфиги CLI при переходе не меняются.
 *
 * Конвейер тот же, что у метки сеанса (`serveGatewayEntry`): маска, ключ, перевод, расход и след
 * не расходятся. Метка — своя на контур (`user:<контур>`), диалект клиента — по ручке запроса.
 *
 * Порт занят (прежний шлюз панели ещё держит его) — звено пробует снова, пока порт не отпустят:
 * переход без перерыва. Раздел из отметки `/_s/<раздел>` проходит, только если он открыт на
 * контуре (`consumers`); незнакомая отметка — отказ, а не адрес без отметки.
 */

export interface UserRoute {
  platformId: string;
  title: string;
  enabled: boolean;
  /** Открытые разделы контура (`HopUserRoute.consumers`). */
  consumers: readonly string[];
  /** Имена чужих CLI по id — готовыми от ядра: реестр CLI хосту звеньев не положен. */
  cliNames?: Readonly<Record<string, string>>;
  spec: HopRegistration;
}

export interface UserGatewayOptions {
  ctx: HopContext;
  /** Шаг повтора, пока порт занят. */
  retryMs?: number;
  note?: (event: string, data: Record<string, unknown>) => void;
}

export interface UserGateway {
  /** Открыть/перенастроить (`port: null` — закрыть); маршруты заменяются целиком. */
  configure(port: number | null, routes: UserRoute[]): Promise<HopUserGatewayState | null>;
  state(): HopUserGatewayState | null;
  stop(): Promise<void>;
}

const RETRY_MS = 1_000;

const FROM_OF_ROUTE: Record<EdgeRoute, Dialect> = {
  messages: 'anthropic-messages',
  chat: 'openai-chat',
  responses: 'openai-responses',
  google: 'google-genai',
};

/** Порт шлюза человека: вне 5170–5180, кроме самого порта продукта. */
export function userGatewayPortProblem(port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return `bad port ${port}`;
  if (isReserved(port) && port !== HOP_USER_GATEWAY_PORT)
    return `port ${port} is in the reserved range 5170-5180 (only ${HOP_USER_GATEWAY_PORT} is allowed)`;
  return null;
}

interface Parsed {
  platformId: string;
  run: string | null;
  /** Раздел из отметки `_s/<раздел>`; нет — адрес без отметки. */
  section?: string;
  /** Отметка стоит, но раздел в ней не читается: опечатка не открывает закрытое. */
  badSection?: true;
  /** Путь без префикса контура и без строки запроса. */
  path: string;
}

/** Метка прогона в адресе — тем же правилом, что у прежнего шлюза панели. */
const RUN_TAG = /^[A-Za-z0-9-]{1,64}$/;

/**
 * `/<контур>[/_s/<раздел>][/_run/<метка>]/v1/...` → части; корня контура нет — `null`. Порядок
 * сегментов — тот, которым панель пишет адрес CLI (`gatewayUrlFor`): раздел, затем метка.
 */
export function parseUserPath(url: string): Parsed | null {
  const pathname = url.split('?')[0] ?? '/';
  const parts = pathname.split('/').filter((part) => part !== '');
  const platformId = parts[0];
  if (!platformId) return null;
  const id = decodeURIComponent(platformId);
  let at = 1;
  let section: string | undefined;
  if (parts[at] === SECTION_SEGMENT) {
    const read = parseSectionPath(parts, at + 1);
    if (!read) return { platformId: id, run: null, badSection: true, path: rest(parts, at + 1) };
    section = read.consumer;
    at += 1 + read.used;
  }
  const withSection = section === undefined ? {} : { section };
  const tag = parts[at] === '_run' ? parts[at + 1] : undefined;
  if (tag !== undefined && RUN_TAG.test(tag))
    return { platformId: id, run: tag, ...withSection, path: rest(parts, at + 2) };
  return { platformId: id, run: null, ...withSection, path: rest(parts, at) };
}

function rest(parts: readonly string[], from: number): string {
  return `/${parts.slice(from).join('/')}`;
}

/**
 * Отказ закрытому разделу — своя фраза у каждого (код тот же, что у панели): подстановка имени
 * раздела осталась бы русской в английском интерфейсе.
 */
function sectionClosedText(
  section: string,
  title: string,
  cliNames: Readonly<Record<string, string>> = {},
): string {
  const cli = foreignProviderId(section);
  if (cli !== undefined)
    return hopText('gateway-section-closed-foreign', { cli: cliNames[cli] ?? cli, title });
  switch (section) {
    case 'chat':
      return hopText('gateway-section-closed-chat', { title });
    case 'groups':
      return hopText('gateway-section-closed-groups', { title });
    case 'tests':
      return hopText('gateway-section-closed-tests', { title });
    case 'assistant':
      return hopText('gateway-section-closed-assistant', { title });
    default:
      return hopText('gateway-section-closed-terminal', { title });
  }
}

/**
 * Диалект верха для этого клиента. Родная ручка Anthropic (`manifest.anthropicMessages`) есть
 * только у OpenAI-совместимой базы: её чат (`/v1/chat/completions`) никуда не делся. Клиент не
 * Anthropic (Codex, Qwen Code, Gemini) идёт туда, как шёл через шлюз панели, а не получает 400
 * «перевода нет».
 */
function upstreamFor(spec: HopRegistration, from: Dialect): Dialect {
  if (from === 'anthropic-messages' || spec.to !== 'anthropic-messages') return spec.to;
  return spec.manifest?.anthropicMessages ? 'openai-chat' : spec.to;
}

function entryOf(
  route: UserRoute,
  from: Dialect,
  to: Dialect,
  parsed: Parsed,
  since: number,
): TagEntry {
  const tag = parsed.run ? `user:${route.platformId}:${parsed.run}` : `user:${route.platformId}`;
  return {
    spec: { ...route.spec, from, to, tag, sessionId: tag },
    placeholderHash: '',
    registeredAt: since,
    title: route.title,
    ...(parsed.section ? { section: parsed.section } : {}),
    ...(parsed.run ? { runTag: parsed.run } : {}),
  };
}

async function handle(
  ctx: HopContext,
  routes: ReadonlyMap<string, UserRoute>,
  since: number,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = request.url ?? '/';
  // Проба живости, которую читают CLI и сторож (как у прежнего шлюза панели).
  if (url === '/api/hello') {
    request.resume();
    return respondJson(response, 200, { ok: true, gateway: 'hop' });
  }
  const parsed = parseUserPath(url);
  const edge = parsed ? edgeRouteOf(parsed.path) : undefined;
  const out = edge === 'google' ? googleResponse(response) : response;
  const kind = kindOfRoute(edge, parsed?.path ?? url);
  const route = parsed ? routes.get(parsed.platformId) : undefined;
  const fail = (status: number, code: string, message: string): void => {
    request.resume();
    refuse(out, kind, { status, code, message }, ctx.language);
  };
  if (!parsed || !route)
    return fail(
      404,
      'not_found_error',
      hopText('gateway-contour-unknown', { id: parsed?.platformId ?? '' }),
    );
  if (!route.enabled)
    return fail(403, 'permission_error', hopText('hop-contour-off', { id: route.platformId }));
  if (parsed.badSection || (parsed.section && !route.consumers.includes(parsed.section))) {
    const message = parsed.badSection
      ? hopText('gateway-section-unknown')
      : sectionClosedText(parsed.section ?? '', route.title, route.cliNames);
    ctx.trace.write({
      at: ctx.now(),
      tag: `user:${route.platformId}`,
      routeId: route.spec.routeId,
      hop: 'gateway',
      path: parsed.path,
      status: 403,
      code: 'permission_error',
      error: message,
      ...(parsed.section ? { section: parsed.section } : {}),
    });
    return fail(403, 'permission_error', message);
  }
  const from = edge ? FROM_OF_ROUTE[edge] : route.spec.to;
  const to = upstreamFor(route.spec, from);
  if (!hopTranslates(from, to))
    return fail(
      400,
      'invalid_request_error',
      hopText('hop-untranslatable', { id: route.platformId, from, to }),
    );
  const entry = entryOf(route, from, to, parsed, since);
  await serveGatewayEntry(sessionContext(ctx, entry), entry, {
    request,
    response: out,
    raw: response,
    credential: credentialOf(request) ?? '',
    path: parsed.path,
    route: edge,
  });
}

export function startUserGateway(options: UserGatewayOptions): UserGateway {
  const retryMs = options.retryMs ?? RETRY_MS;
  let routes = new Map<string, UserRoute>();
  let current:
    | { port: number; server: Server; bound: boolean; since: number; timer?: NodeJS.Timeout }
    | undefined;
  let lastError: string | null = null;

  const state = (): HopUserGatewayState | null =>
    current
      ? {
          port: current.port,
          state: current.bound ? 'listening' : 'waiting',
          since: current.since,
          routes: [...routes.keys()],
          lastError,
        }
      : null;

  const close = (): Promise<void> => {
    const was = current;
    current = undefined;
    if (!was) return Promise.resolve();
    if (was.timer) clearTimeout(was.timer);
    if (!was.bound) return Promise.resolve();
    return new Promise<void>((done) => {
      was.server.close(() => done());
      was.server.closeAllConnections();
    });
  };

  const open = (port: number): void => {
    const since = options.ctx.now();
    const server = createServer((request, response) => {
      handle(options.ctx, routes, since, request, response).catch((error: unknown) => {
        respondJson(response, 500, {
          error: { message: error instanceof Error ? error.message : String(error) },
        });
      });
    });
    const slot: NonNullable<typeof current> = { port, server, bound: false, since };
    current = slot;
    let busyNoted = false;
    const tryListen = (): void => {
      if (current !== slot) return;
      server.listen({ host: LOOPBACK, port, exclusive: true });
    };
    server.on('listening', () => {
      slot.bound = true;
      slot.since = options.ctx.now();
      lastError = null;
      options.note?.('user-gateway', { port, state: 'listening' });
    });
    server.on('error', (error: NodeJS.ErrnoException) => {
      lastError = error.code ?? error.message;
      if (slot.bound) {
        options.note?.('user-gateway', { port, state: 'error', reason: lastError });
        return;
      }
      // Занят — ждём, пока отпустят; журнал слышит о занятости один раз, не каждую секунду.
      if (!busyNoted) {
        busyNoted = true;
        options.note?.('user-gateway', { port, state: 'waiting', reason: lastError });
      }
      if (current !== slot) return;
      slot.timer = setTimeout(tryListen, retryMs);
      slot.timer.unref();
    });
    tryListen();
  };

  return {
    async configure(port, next) {
      if (port !== null) {
        const problem = userGatewayPortProblem(port);
        if (problem) throw new Error(problem);
      }
      routes = new Map(next.map((route) => [route.platformId, route]));
      if (current?.port !== port) {
        await close();
        if (port !== null) open(port);
      }
      return state();
    },
    state,
    stop: close,
  };
}
