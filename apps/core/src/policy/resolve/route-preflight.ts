import type { UnknownAction } from '@agentdeck/contracts/core/facts';
import type { RouteFactName, RouteKind } from '@agentdeck/contracts/core/routes';
import { describeError } from '../../lib/facts/read-fact.ts';
import { routeCovers } from './resolve.ts';
import type { AllowedRoute } from './resolve.types.ts';
import type {
  PreflightRoute,
  RouteCheck,
  RoutePreflightInput,
  RoutePreflightRow,
  RoutePreflightVerdict,
} from './route-preflight.types.ts';

/**
 * Предпроверка маршрута до запуска (11 R:PR-13, P128): выбранный маршрут недоступен, доступа
 * нет, памяти карты мало — запуска нет, причина названа вместе с исправлением. Годные
 * альтернативы из разрешённого набора ПЕРЕЧИСЛЕНЫ, но никогда не взяты: тихая смена маршрута
 * при запуске — это смена того, куда уходит код и кто платит, без слова человека. Взять другую
 * тройку может только команда уровня 2 `set-route`.
 *
 * Непрочитанное — `unknown` с действием, объявленным маршрутом для этого факта (P111): облачная
 * доступность `retry-until` — запуск ждёт в безопасной точке (P77), нечитаемое хранилище
 * ключей — `refuse`, никогда не «ключа нет».
 */

const label = (r: AllowedRoute): string => `${r.adapter}/${r.route.id}/${r.modelPattern}`;

const UNAVAILABLE_FIX: Record<RouteKind, string> = {
  'cli-login': 'log in to the CLI in a terminal (its own login command), then start again',
  'api-key':
    'check the endpoint address and the network (company CA, HTTPS_PROXY), then start again',
  local: 'start the local model server or install the model, then start again',
  gateway: 'enable the contour in the panel and check its address, then start again',
  stub: 'start the stub server of the task, then start again',
};

const CREDENTIAL_FIX: Record<RouteKind, string> = {
  'cli-login': 'log in to the CLI in a terminal (its own login command)',
  'api-key': 'add the key in the panel (Providers → key), then start again',
  local: 'the local route needs no key: check the route config',
  gateway: 'add the contour key in the panel (Contour → key), then start again',
  stub: 'the stub needs no key: check the route config',
};

function onUnknownOf(route: PreflightRoute, fact: RouteFactName): UnknownAction {
  return route.facts.find((decl) => decl.fact === fact)?.onUnknown ?? 'refuse';
}

async function availabilityCheck(route: PreflightRoute): Promise<RouteCheck> {
  const fact = await route.read.availability().catch((error: unknown) => ({
    unknown: describeError(error),
  }));
  if ('value' in fact) return { check: 'availability', status: 'ok', detail: fact.value.state };
  if ('absent' in fact)
    return { check: 'availability', status: 'fail', detail: `${route.id} is not available` };
  return {
    check: 'availability',
    status: 'unknown',
    detail: `${route.id} availability unread: ${fact.unknown}`,
    onUnknown: onUnknownOf(route, 'availability'),
  };
}

async function credentialCheck(route: PreflightRoute): Promise<RouteCheck> {
  const fact = await route.read.credential().catch((error: unknown) => ({
    unknown: describeError(error),
  }));
  if ('value' in fact) {
    return fact.value.present
      ? { check: 'credential', status: 'ok', detail: `${fact.value.kind}: present` }
      : { check: 'credential', status: 'fail', detail: `${fact.value.kind}: no key in the store` };
  }
  if ('absent' in fact)
    return { check: 'credential', status: 'fail', detail: 'credential: none configured' };
  return {
    check: 'credential',
    status: 'unknown',
    detail: `credential unread: ${fact.unknown}`,
    onUnknown: onUnknownOf(route, 'credential'),
  };
}

async function memoryCheck(
  input: RoutePreflightInput,
  triple: AllowedRoute,
  kind: RouteKind,
): Promise<RouteCheck | undefined> {
  if (kind !== 'local') return undefined;
  if (!input.memoryFit)
    return { check: 'memory', status: 'not-checked', detail: 'gpu memory fit not wired' };
  try {
    const fit = await input.memoryFit(triple);
    if (!fit) return { check: 'memory', status: 'not-checked', detail: 'no model to fit yet' };
    return { check: 'memory', status: fit.short ? 'fail' : 'ok', detail: fit.detail };
  } catch (error) {
    // Память карты непрочитана — подбор по оценке, названный (P129): запуск не запрещён.
    return {
      check: 'memory',
      status: 'unknown',
      detail: `gpu memory unread: ${describeError(error)}`,
      onUnknown: 'run',
    };
  }
}

function fixOf(kind: RouteKind, failed: RouteCheck): string {
  if (failed.check === 'credential') return CREDENTIAL_FIX[kind];
  if (failed.check === 'memory')
    return 'pick a smaller model or a shorter context, or free the GPU memory, then start again';
  return UNAVAILABLE_FIX[kind];
}

/** Строка одной тройки: реестр → доступность и доступ → память (только своя модель). */
export async function routePreflightRow(
  input: RoutePreflightInput,
  triple: AllowedRoute,
): Promise<RoutePreflightRow> {
  const base = {
    routeId: triple.route.id,
    adapter: triple.adapter,
    modelPattern: triple.modelPattern,
  };
  const route = input.routeOf(triple.route.id);
  if (!route || route.kind !== triple.route.kind) {
    const detail = route
      ? `${triple.route.id}: registry kind ${route.kind}, task names ${triple.route.kind}`
      : `${triple.route.id}: not in the route registry`;
    return {
      ...base,
      kind: 'unregistered',
      status: 'fail',
      checks: [{ check: 'registry', status: 'fail', detail }],
      fix: 'add the route to the core route config or allow an existing one',
    };
  }
  const [availability, credential] = await Promise.all([
    availabilityCheck(route),
    credentialCheck(route),
  ]);
  const memory = await memoryCheck(input, triple, route.kind);
  const checks: RouteCheck[] = [
    { check: 'registry', status: 'ok', detail: `${route.id} (${route.kind})` },
    availability,
    credential,
    ...(memory ? [memory] : []),
  ];
  const failed = checks.find((check) => check.status === 'fail');
  if (failed)
    return { ...base, kind: route.kind, status: 'fail', checks, fix: fixOf(route.kind, failed) };
  // Отказ среди неизвестных главнее ожидания: нечитаемое хранилище ключей не ждут.
  const unknowns = checks.filter((check) => check.status === 'unknown');
  if (unknowns.length === 0) return { ...base, kind: route.kind, status: 'ok', checks };
  const refusing = unknowns.find((check) => check.onUnknown === 'refuse');
  const action = (refusing ?? unknowns[0])?.onUnknown ?? 'refuse';
  return {
    ...base,
    kind: route.kind,
    status: 'unknown',
    checks,
    onUnknown: action,
    ...(action === 'refuse' ? { fix: fixOf(route.kind, refusing ?? unknowns[0]!) } : {}),
  };
}

function rowText(row: RoutePreflightRow): string {
  const bad = row.checks.filter((check) => check.status === 'fail' || check.status === 'unknown');
  return `${row.adapter}/${row.routeId}: ${bad.map((check) => check.detail).join('; ')}`;
}

/**
 * Предпроверка выбранной тройки и разрешённого набора. Строки — по каждой тройке набора;
 * выбранная вне набора — отказ с именем (расширяет набор только `set-route`).
 */
export async function preflightRoutes(input: RoutePreflightInput): Promise<RoutePreflightVerdict> {
  const others = input.allowed.filter((triple) => label(triple) !== label(input.chosen));
  const [chosenRow, ...rest] = await Promise.all(
    [input.chosen, ...others].map((triple) => routePreflightRow(input, triple)),
  );
  const chosen = chosenRow!;
  const inside = input.allowed.some((triple) => routeCovers(triple, input.chosen));
  if (!inside) {
    chosen.status = 'fail';
    chosen.checks.unshift({
      check: 'registry',
      status: 'fail',
      detail: `${label(input.chosen)} is outside the allowed set`,
    });
    chosen.fix = 'allow the route with the set-route command (level 2), then start again';
    delete chosen.onUnknown;
  }
  const alternatives = rest.filter((row) => row.status === 'ok');
  const waits = chosen.status === 'unknown' && chosen.onUnknown === 'retry-until';
  const start =
    chosen.status === 'ok' || (chosen.status === 'unknown' && chosen.onUnknown !== 'refuse');
  const reasons: string[] = [];
  if (!start) {
    reasons.push(rowText(chosen));
    if (chosen.fix) reasons.push(`fix: ${chosen.fix}`);
    reasons.push(
      alternatives.length > 0
        ? `alternatives (not taken; choose one with set-route): ${alternatives
            .map((row) => `${row.adapter}/${row.routeId}`)
            .join(', ')}`
        : 'no usable alternative in the allowed set',
    );
  } else if (waits) {
    reasons.push(`${rowText(chosen)}; units wait at a safe point (${chosen.onUnknown})`);
  }
  return { start, waits, chosen, alternatives, rows: [chosen, ...rest], reasons };
}
