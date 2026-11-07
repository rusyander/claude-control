import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hopControlReplySchema,
  hopHostProcRowSchema,
  type HopControlReply,
  type HopContours,
  type HopControlRequest,
  type HopHostLaunch,
  type HopHostProcRow,
  type HopProbeReply,
  type HopProbeRequest,
  type HopRegisterReply,
  type HopRegisterSpec,
  type HopSpend,
  type HopStatus,
  type HopTag,
  type HopUserGatewayState,
  type HopDlpProxyConfig,
  type HopDlpProxyState,
  type HopUserRoute,
  type CoreContourRunReply,
} from '@agentdeck/contracts/core/hops';
import type { RouteId } from '@agentdeck/contracts/core/routes';
import type { PlatformSpendRecord } from '@agentdeck/contracts/platform';
import { helperEnv, launchDetached } from '../../platform/detached-launch.ts';
import { httpJson } from '../../platform/http-json.ts';
import { hasValue, sleep } from '../../platform/os-kind.ts';
import { pathKey } from '../../platform/paths.ts';
import { LOOPBACK } from '../../platform/ports.ts';
import { identityOfPid } from '../../platform/process-identity.ts';
import { readProcs } from '../../platform/procs-file.ts';
import { readToken } from '../../platform/token-file.ts';
import type { EnsureHopHostOptions, HopEnvSpec, HopHostHandle } from './hops.types.ts';

export type { EnsureHopHostOptions, HopEnvSpec, HopHostHandle } from './hops.types.ts';

/**
 * Клиент ядра к хосту звеньев (11 §Hop chain): найти живой хост по `procs.json` или запустить
 * отвязанным, зарегистрировать метку сеанса, спросить расход и статус. Импорт хоста через слой
 * запрещён (depcruise: маршруты не знают `hop-host/`) — хост запускается файлом, а пути его
 * состояния повторены здесь (`hop-host/paths.ts` — тот же список).
 */

const HOST_ENTRY = fileURLToPath(new URL('../../hop-host/main.ts', import.meta.url));
const CONTROL_TIMEOUT_MS = 10_000;

export class HopHostError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`hop host ${code}: ${detail}`);
    this.code = code;
  }
}

function tokenPathOf(home: string): string {
  return join(home, 'hops', 'control.token');
}

/** Строка живого хоста: pid жив с тем же стартом, что записан (номер мог уйти другому). */
async function liveRow(home: string): Promise<HopHostProcRow | undefined> {
  const read = readProcs(join(home, 'procs.json'));
  if (!('value' in read)) return undefined;
  const rows = read.value.servers.filter((row) => row.kind === 'hop-host');
  for (const raw of rows.reverse()) {
    const parsed = hopHostProcRowSchema.safeParse(raw);
    if (!parsed.success) continue;
    const row = parsed.data;
    const identity = await identityOfPid(row.pid);
    if (!hasValue(identity) || identity.value.start !== row.pidStart) continue;
    return row;
  }
  return undefined;
}

async function handleOf(
  home: string,
  launched: boolean,
): Promise<{ handle: HopHostHandle; status: HopStatus } | undefined> {
  const row = await liveRow(home);
  if (!row) return undefined;
  const token = readToken(tokenPathOf(home));
  if (!('value' in token)) return undefined;
  const handle: HopHostHandle = {
    url: `http://${LOOPBACK}:${row.port}`,
    token: token.value,
    pid: row.pid,
    dlpPort: row.dlpPort,
    gatewayPort: row.gatewayPort,
    launched,
  };
  // Строка жива, но хост мог ещё не слушать или зависнуть: ответ на статус — доказательство.
  const status = await control(handle, { op: 'status' }).catch(() => undefined);
  return status?.ok && status.op === 'status' ? { handle, status: status.status } : undefined;
}

const dirKey = (dir: string | null | undefined): string | null =>
  dir ? pathKey(resolve(dir)) : null;

/**
 * Живой хост с ДРУГИМ каталогом данных панели — отказ с причиной, не перезапуск: хостом пользуются
 * сеансы других задач, а ключи `panel-store` и правила маски он читает из своего каталога —
 * сеанс этого ядра ушёл бы с чужими ключами и правилами молча.
 */
function sameAppData(
  found: { handle: HopHostHandle; status: HopStatus },
  options: Pick<EnsureHopHostOptions, 'panelAppData'>,
): HopHostHandle {
  const live = found.status.panelAppData ?? null;
  if (dirKey(live) !== dirKey(options.panelAppData))
    throw new HopHostError(
      'panel_data_mismatch',
      `live hop host ${found.handle.pid} reads panel data ${live ?? 'none'}, this core asks ${options.panelAppData ?? 'none'}`,
    );
  return found.handle;
}

/**
 * Только живой хост, без запуска: читателю, которому нечего читать без трафика (извещения о
 * бюджете), незачем заводить процесс. Чужой каталог панели — тот же отказ, что у `ensureHopHost`.
 */
export async function findHopHost(
  options: Pick<EnsureHopHostOptions, 'home' | 'panelAppData'>,
): Promise<HopHostHandle | undefined> {
  const found = await handleOf(options.home, false);
  return found ? sameAppData(found, options) : undefined;
}

/**
 * Живой хост дома или новый. Гонка двух ядер безопасна: второй хост не берёт замок и выходит,
 * а оба ядра читают строку победителя.
 */
export async function ensureHopHost(options: EnsureHopHostOptions): Promise<HopHostHandle> {
  const found = await handleOf(options.home, false);
  if (found) return sameAppData(found, options);
  const config: HopHostLaunch = {
    home: options.home,
    ...(options.panelAppData ? { panelAppData: options.panelAppData } : {}),
    ...(options.stallMs !== undefined ? { stallMs: options.stallMs } : {}),
    ...(options.flushMs !== undefined ? { flushMs: options.flushMs } : {}),
    ...(options.retryPauseMs !== undefined ? { retryPauseMs: options.retryPauseMs } : {}),
    ...(options.ownerBootId ? { ownerBootId: options.ownerBootId } : {}),
    ...(options.language ? { language: options.language } : {}),
  };
  const started = await launchDetached({
    file: process.execPath,
    args: [
      '--experimental-strip-types',
      '--no-warnings',
      HOST_ENTRY,
      Buffer.from(JSON.stringify(config), 'utf8').toString('base64url'),
    ],
    cwd: options.home,
    // Окружение хоста — только системное: ключи `env` хост читает из СВОЕГО окружения, и
    // секреты ядра туда не переезжают молча (остаток назван в отчёте зоны).
    env: helperEnv(),
    ...(options.breakaway ? { breakaway: true } : {}),
  });
  if (!started.ok) throw new HopHostError('launch_failed', started.reason);
  const deadline = Date.now() + (options.startTimeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    // Гонку мог выиграть хост другого ядра — тот же суд каталога панели.
    const launched = await handleOf(options.home, true);
    if (launched) return sameAppData(launched, options);
    await sleep(100);
  }
  throw new HopHostError('start_timeout', `no live hop-host row in ${options.home}/procs.json`);
}

async function control(
  handle: HopHostHandle,
  message: HopControlRequest,
): Promise<HopControlReply> {
  const outcome = await httpJson({
    url: `${handle.url}/hops`,
    method: 'POST',
    bearer: handle.token,
    body: message,
    timeoutMs: CONTROL_TIMEOUT_MS,
  });
  if (outcome.kind === 'unreachable') throw new HopHostError('unreachable', outcome.reason);
  // Ответ — по схеме контракта: чужой процесс на порту или битая форма — не ответ хоста.
  const parsed = hopControlReplySchema.safeParse(outcome.body);
  if (!parsed.success) throw new HopHostError('bad_reply', `status ${outcome.status}`);
  return parsed.data as HopControlReply;
}

/**
 * Регистрация в полной форме провода: новые поля контракта вызывающий может не знать — их
 * значения по умолчанию ставит клиент (драйвер из возможности `driver:<id>` хост найдёт сам).
 */
function registerMessage(spec: HopRegisterSpec, sessionKey?: string): HopControlRequest {
  return {
    op: 'register',
    ...(sessionKey ? { sessionKey } : {}),
    spec: {
      ...spec,
      dlp: { ...spec.dlp, rules: spec.dlp.rules ?? null },
      driver: spec.driver ?? null,
      price: spec.price ?? null,
    },
  };
}

function unwrap<Op extends HopControlRequest['op']>(
  reply: HopControlReply,
  op: Op,
): Extract<HopControlReply, { op: Op; ok: true }> {
  if (!reply.ok) throw new HopHostError(reply.code, reply.detail);
  if (reply.op !== op) throw new HopHostError('bad_reply', `asked ${op}, got ${reply.op}`);
  return reply as Extract<HopControlReply, { op: Op; ok: true }>;
}

/**
 * Регистрация метки. `sessionKey` — значение ключа `env` из пина задачи: хост держит его в
 * памяти метки, не в файле; сеанс получает только заглушку.
 */
export async function registerTag(
  handle: HopHostHandle,
  spec: HopRegisterSpec,
  sessionKey?: string,
): Promise<HopRegisterReply> {
  return unwrap(await control(handle, registerMessage(spec, sessionKey)), 'register').reply;
}

/**
 * Чтение с ключом через звено (порт `keyedProbe` маршрутов `api-key`/`gateway`): ключ читает и
 * подставляет хост, ядро получает только ответ верха с вычищенным ключом. Отказ хоста —
 * `HopHostError` с его кодом (`key_unresolved`, `route_exhausted`, …).
 */
export async function probeRoute(
  handle: HopHostHandle,
  request: HopProbeRequest,
): Promise<HopProbeReply> {
  return unwrap(await control(handle, { op: 'probe', ...request }), 'probe').reply;
}

export async function unregisterTag(handle: HopHostHandle, tag: HopTag): Promise<void> {
  unwrap(await control(handle, { op: 'unregister', tag }), 'unregister');
}

export async function spendOf(handle: HopHostHandle, tag: HopTag): Promise<HopSpend | null> {
  return unwrap(await control(handle, { op: 'spend-of', tag }), 'spend-of').spend;
}

export async function hopStatus(handle: HopHostHandle): Promise<HopStatus> {
  return unwrap(await control(handle, { op: 'status' }), 'status').status;
}

/**
 * Управляющий запрос как есть, ответ хоста — по схеме контракта: так его ждёт команда человека
 * `clear-exhausted` (`CommandEnv.hops`), которая сама называет отказ хоста в своём исходе.
 */
export function hopControl(
  handle: HopHostHandle,
  message: HopControlRequest,
): Promise<HopControlReply> {
  return control(handle, message);
}

/**
 * Шлюз человека на хосте (этап 10): порт и маршруты контуров целиком; `port: null` — закрыть.
 * Значения по умолчанию спеки ставит клиент, как у регистрации.
 */
export async function configureUserGateway(
  handle: HopHostHandle,
  port: number | null,
  routes: HopUserRoute[],
): Promise<HopUserGatewayState | null> {
  const full = routes.map((route) => {
    const message = registerMessage(route.spec) as Extract<HopControlRequest, { op: 'register' }>;
    return { ...route, spec: message.spec };
  });
  return unwrap(await control(handle, { op: 'user-gateway', port, routes: full }), 'user-gateway')
    .state;
}

/** Прокси защиты данных человека (C3c): открыть/перенастроить, `null` — закрыть. */
export async function configureDlpProxy(
  handle: HopHostHandle,
  config: HopDlpProxyConfig | null,
): Promise<HopDlpProxyState | null> {
  return unwrap(await control(handle, { op: 'dlp-proxy', config }), 'dlp-proxy').state;
}

/** Учёт контуров звена (C3b): след, счётчики от запуска, сводка сжатий, извещения о бюджете. */
export async function contoursOf(handle: HopHostHandle): Promise<HopContours> {
  return unwrap(await control(handle, { op: 'contours' }), 'contours').contours;
}

/** Постоянный учёт контуров по дням (то, что панель держала в `state.json` → `platformSpend`). */
export async function contourSpend(
  handle: HopHostHandle,
): Promise<Record<string, PlatformSpendRecord>> {
  return unwrap(await control(handle, { op: 'contour-spend' }), 'contour-spend').records;
}

/** Факты прогона чужого CLI (сжатие по метке, вызовы инструментов с `since`). */
export async function contourRun(
  handle: HopHostHandle,
  runTag: string,
  since: number,
): Promise<CoreContourRunReply> {
  const { summarized, toolCalls } = unwrap(
    await control(handle, { op: 'contour-run', runTag, since }),
    'contour-run',
  );
  return { summarized, ...(toolCalls === undefined ? {} : { toolCalls }) };
}

/** Id сообщений со сжатием истории контуром — ленте Claude. */
export async function contourSummarizedIds(handle: HopHostHandle): Promise<string[]> {
  return unwrap(await control(handle, { op: 'contour-summarized' }), 'contour-summarized')
    .messageIds;
}

export async function clearExhausted(handle: HopHostHandle, routeId: RouteId): Promise<boolean> {
  return unwrap(await control(handle, { op: 'clear-exhausted', routeId }), 'clear-exhausted')
    .cleared;
}

/** Имена, под которыми CLI ищут ключ: в окружении сеанса с каналом звена их не остаётся. */
const KEY_NAMES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY'] as const;

/**
 * Окружение сеанса, идущего через звено (P112): адрес звена и ЗАГЛУШКА ключа; настоящего ключа
 * нет — ни под известными именами, ни под именем ссылки `env` маршрута. Новое окружение,
 * входное не меняется.
 */
export function applyHopEnv(
  env: Readonly<Record<string, string | undefined>>,
  spec: HopEnvSpec,
  reply: HopRegisterReply,
): Record<string, string> {
  const out: Record<string, string> = {};
  const scrub = new Set<string>(KEY_NAMES);
  if (spec.keyRef?.kind === 'env') scrub.add(spec.keyRef.name);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if ([...scrub].some((name) => name.toUpperCase() === upper)) continue;
    out[key] = value;
  }
  const origin = `http://${LOOPBACK}:${reply.port}`;
  if (spec.from === 'anthropic-messages') {
    out.ANTHROPIC_BASE_URL = origin;
    out.ANTHROPIC_API_KEY = reply.placeholder;
  } else {
    out.OPENAI_BASE_URL = `${origin}/v1`;
    out.OPENAI_API_KEY = reply.placeholder;
  }
  return out;
}
