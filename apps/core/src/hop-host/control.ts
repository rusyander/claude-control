import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  hopControlRequestSchema,
  hopTranslates,
  type HopControlMessage,
  type HopControlReply,
  type HopControlRequest,
  type HopRegistration,
} from '@agentdeck/contracts/core/hops';
import { rulesHashOf } from '@agentdeck/dlp/rules-hash';
import type { PlatformGatewayEvent } from '@agentdeck/contracts';
import { contourIdOf } from './contour-book/record.ts';
import { rulesOf, type HopContext } from './context.ts';
import {
  summarizedInRun,
  summarizedMessageIds,
  summarizedReport,
} from './gateway/summarized-ledger/summarized-ledger.ts';
import { driverProblem, hopKindOf, unknownFeatures } from './features.ts';
import type { HopPorts, PortSubstitution } from './host.types.ts';
import { readBody, respondJson } from './http.ts';
import { answerProbe } from './probe.ts';
import type { DlpProxy } from './dlp-proxy/dlp-proxy.ts';
import type { UserGateway } from './user-gateway/user-gateway.ts';

/**
 * Управление хостом (протокол `@agentdeck/contracts/core/hops`): ядро регистрирует метку сеанса,
 * снимает её, спрашивает статус и расход, читает каталог с ключом (`probe`), человек снимает
 * отметку исчерпания. Доступ — токен `hops/control.token` (файл 0600 в доме ядра): порт на
 * loopback видят все процессы машины, а регистрация метки = право тратить ключ маршрута.
 * Форма сообщения — схема контракта: что она не приняла, до хоста не доходит.
 */

export interface ControlDeps {
  ctx: HopContext;
  token: string;
  ports: HopPorts;
  substitutions: PortSubstitution[];
  pid: number;
  /** Каталог данных панели, с которым запущен хост (статус называет его ядру). */
  panelAppData?: string | null;
  /** Шлюз человека (этап 10); нет — op `user-gateway` отказывает. */
  userGateway?: UserGateway;
  /** Прокси защиты данных человека (C3c); нет — op `dlp-proxy` отказывает. */
  dlpProxy?: DlpProxy;
}

type Failure = Extract<HopControlReply, { ok: false }>;
type Op = HopControlRequest['op'];

const OPS: readonly Op[] = [
  'register',
  'unregister',
  'status',
  'clear-exhausted',
  'spend-of',
  'probe',
  'user-gateway',
  'dlp-proxy',
  'contours',
  'contour-spend',
  'activity',
];

function fail(op: Op, code: string, detail: string): Failure {
  return { op, ok: false, code, detail };
}

function bearerOk(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? '';
  const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Op отказа: названный в сообщении, если он из протокола, иначе `status`. */
function opOf(message: unknown): Op {
  const op = message && typeof message === 'object' ? (message as { op?: unknown }).op : undefined;
  return OPS.find((known) => known === op) ?? 'status';
}

/**
 * Регистрация. Отказ — до выдачи заглушки: неизвестная возможность или драйвер (маршрут шёл бы
 * без них молча) и хэш правил, не совпавший с правилами, которые звено применит (сеанс думал бы,
 * что маскируется одним набором, а маскировался бы другим).
 */
function register(
  deps: ControlDeps,
  spec: HopRegistration,
  sessionKey: string | undefined,
): HopControlReply {
  // Перевод, которого мост не умеет, — отказ до заглушки: сеанс иначе получал бы 404 на каждом
  // ходу. Список — тот же, по которому судья `compat` ядра открывает канал (`HOP_TRANSLATIONS`).
  if (!hopTranslates(spec.from, spec.to))
    return fail(
      'register',
      'unknown_translation',
      `hop does not translate ${spec.from} → ${spec.to}`,
    );
  const unknown = unknownFeatures(spec.features);
  if (unknown.length > 0)
    return fail('register', 'unknown_feature', `hop does not know: ${unknown.join(', ')}`);
  const driver = driverProblem(spec);
  if (driver) return fail('register', driver.code, driver.detail);
  if (spec.dlp.rulesHash !== null) {
    const set = rulesOf(deps.ctx, spec);
    if ('broken' in set) return fail('register', 'dlp_rules_broken', set.broken);
    const actual = rulesHashOf(set.rules);
    if (actual !== spec.dlp.rulesHash)
      return fail(
        'register',
        'dlp_rules_mismatch',
        `rules hash ${spec.dlp.rulesHash} != hop rules ${actual}`,
      );
  }
  const placeholder = deps.ctx.tags.register(spec, deps.ctx.now(), sessionKey);
  const port = hopKindOf(spec) === 'gateway' ? deps.ports.gateway : deps.ports.dlp;
  return { op: 'register', ok: true, reply: { port, placeholder } };
}

export async function answerControl(deps: ControlDeps, message: unknown): Promise<HopControlReply> {
  const parsed = hopControlRequestSchema.safeParse(message);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    return fail(opOf(message), 'bad_request', `${where}${issue?.message ?? 'bad message'}`);
  }
  const { ctx } = deps;
  const request = parsed.data;
  switch (request.op) {
    case 'register':
      return register(deps, request.spec, request.sessionKey);
    case 'unregister':
      ctx.tags.unregister(request.tag);
      return { op: 'unregister', ok: true };
    case 'status':
      return {
        op: 'status',
        ok: true,
        status: {
          pid: deps.pid,
          ports: { dlp: deps.ports.dlp, gateway: deps.ports.gateway },
          tags: ctx.tags.tags(),
          exhausted: ctx.spend.exhausted(),
          ...(deps.substitutions.length > 0 ? { substitutions: [...deps.substitutions] } : {}),
          panelAppData: deps.panelAppData ?? null,
          userGateway: deps.userGateway?.state() ?? null,
          dlpProxy: deps.dlpProxy?.state() ?? null,
        },
      };
    case 'clear-exhausted': {
      // Маршрут контура держит две отметки: отказ маршрута звена (G11) и отметку на карточке
      // контура. Человек продлил бюджет — гаснут обе, иначе одна из них соврала бы.
      const route = ctx.spend.clearExhausted(request.routeId);
      const platformId = contourIdOf(request.routeId);
      const contour = platformId !== undefined && ctx.contours.clearExhausted(platformId);
      return { op: 'clear-exhausted', ok: true, cleared: route || contour };
    }
    case 'spend-of':
      return { op: 'spend-of', ok: true, spend: ctx.spend.spendOf(request.tag) };
    case 'probe':
      return answerProbe(ctx, request);
    case 'user-gateway':
      return configureUserGateway(deps, request);
    case 'dlp-proxy':
      return configureDlpProxy(deps, request.config);
    case 'contours':
      return {
        op: 'contours',
        ok: true,
        contours: { ...ctx.contours.snapshot(), summarized: summarizedReport(ctx.stateDir) },
      };
    case 'contour-spend':
      return { op: 'contour-spend', ok: true, records: ctx.contours.records() };
    case 'contour-run': {
      const toolCalls = toolCallsSince(ctx.contours.snapshot().events, request.since);
      return {
        op: 'contour-run',
        ok: true,
        summarized: summarizedInRun(ctx.stateDir, request.runTag),
        ...(toolCalls === undefined ? {} : { toolCalls }),
      };
    }
    case 'contour-summarized':
      return {
        op: 'contour-summarized',
        ok: true,
        messageIds: [...summarizedMessageIds(ctx.stateDir)],
      };
    case 'activity':
      // Ход локальных маршрутов: без ленты в контексте — пустой список.
      return { op: 'activity', ok: true, routes: ctx.activity?.snapshot() ?? [] };
  }
}

/**
 * Вызовы инструментов агента (прослойкой и родным полем) в запросах контура с `sinceMs` — ответу
 * чата чужого CLI, у которого своего транскрипта вызовов нет. `undefined` — запросов за это
 * время не было. Счёт по следу, а не по прогону: два чата через один контур в одно время
 * сложатся — цена пропущенная подсказка, не ложная.
 */
function toolCallsSince(
  events: readonly PlatformGatewayEvent[],
  sinceMs: number,
): number | undefined {
  let requests = 0;
  let calls = 0;
  for (const event of events) {
    if (Date.parse(event.at) < sinceMs) continue;
    requests += 1;
    calls += (event.toolCalls ?? 0) + (event.nativeCalls ?? 0);
  }
  return requests > 0 ? calls : undefined;
}

/**
 * Шлюз человека: маршрут с переводом, которого мост не умеет, или с незнакомой возможностью —
 * отказ всей настройки (как у регистрации метки): частично настроенный шлюз молча терял бы контур.
 */
async function configureUserGateway(
  deps: ControlDeps,
  request: Extract<HopControlMessage, { op: 'user-gateway' }>,
): Promise<HopControlReply> {
  if (!deps.userGateway)
    return fail('user-gateway', 'unsupported', 'this hop host has no user gateway');
  for (const route of request.routes) {
    const unknown = unknownFeatures(route.spec.features);
    if (unknown.length > 0)
      return fail(
        'user-gateway',
        'unknown_feature',
        `${route.platformId}: hop does not know: ${unknown.join(', ')}`,
      );
    const driver = driverProblem(route.spec);
    if (driver) return fail('user-gateway', driver.code, `${route.platformId}: ${driver.detail}`);
  }
  try {
    const state = await deps.userGateway.configure(request.port, request.routes);
    return { op: 'user-gateway', ok: true, state };
  } catch (error) {
    return fail('user-gateway', 'bad_port', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Прокси защиты данных человека: порт шлюза человека или порт самого хоста — отказ, а не прокси,
 * который вечно ждал бы порта, занятого самим хостом. Порт по умолчанию у раздела — 5179 (внутри
 * 5170–5180): это порт продукта, выбранный человеком, поэтому запретный диапазон здесь не судит;
 * прокси настраивает только настоящее ядро (`bootCore({ dlpProxy })`), тестовые загрузки — нет.
 */
async function configureDlpProxy(
  deps: ControlDeps,
  config: Extract<HopControlMessage, { op: 'dlp-proxy' }>['config'],
): Promise<HopControlReply> {
  if (!deps.dlpProxy) return fail('dlp-proxy', 'unsupported', 'this hop host has no dlp proxy');
  if (config) {
    if (deps.userGateway?.state()?.port === config.port)
      return fail('dlp-proxy', 'port_taken', `port ${config.port} is the user gateway port`);
    if (Object.values(deps.ports).includes(config.port))
      return fail('dlp-proxy', 'bad_port', `port ${config.port} is a hop host port`);
  }
  return { op: 'dlp-proxy', ok: true, state: await deps.dlpProxy.configure(config) };
}

export async function handleControlRequest(
  deps: ControlDeps,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!bearerOk(request, deps.token)) {
    request.resume();
    return respondJson(response, 401, { ok: false, code: 'unauthorized', detail: 'bad token' });
  }
  if (request.method !== 'POST' || (request.url ?? '/') !== '/hops') {
    request.resume();
    return respondJson(response, 404, { ok: false, code: 'not_found', detail: request.url });
  }
  const raw = await readBody(request);
  let message: unknown;
  try {
    message = raw === undefined ? undefined : (JSON.parse(raw.toString('utf8')) as unknown);
  } catch {
    message = undefined;
  }
  const reply = await answerControl(deps, message);
  respondJson(response, reply.ok ? 200 : 400, reply);
}
