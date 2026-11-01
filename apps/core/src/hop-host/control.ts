import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  hopControlRequestSchema,
  hopTranslates,
  type HopControlReply,
  type HopControlRequest,
  type HopRegistration,
} from '@agentdeck/contracts/core/hops';
import { rulesHashOf } from '@agentdeck/dlp/rules-hash';
import { rulesOf, type HopContext } from './context.ts';
import { driverProblem, hopKindOf, unknownFeatures } from './features.ts';
import type { HopPorts, PortSubstitution } from './host.types.ts';
import { readBody, respondJson } from './http.ts';
import { answerProbe } from './probe.ts';

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
        },
      };
    case 'clear-exhausted':
      return {
        op: 'clear-exhausted',
        ok: true,
        cleared: ctx.spend.clearExhausted(request.routeId),
      };
    case 'spend-of':
      return { op: 'spend-of', ok: true, spend: ctx.spend.spendOf(request.tag) };
    case 'probe':
      return answerProbe(ctx, request);
  }
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
