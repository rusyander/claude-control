import type { UserRoute } from '@agentdeck/contracts/core/config';
import type {
  ReleaseOutcome,
  Route,
  RouteAcquireSpec,
  RouteCaps,
  RouteLease,
  RouteModel,
} from '@agentdeck/contracts/core/routes';
import { absent, readFact } from '../../../lib/facts/read-fact.ts';
import { newId } from '../../../lib/ids/uuidv7.ts';
import type { NetFetch } from '../../../platform/net/net.types.ts';
import { extractModels, parseHttpUrl, probeError, probeUnkeyed } from '../../api-key/probe.ts';
import { routeFactDecls } from '../../facts.ts';
import { throwIfAborted } from '../../lease.ts';

/**
 * Маршрут `local:user:<id>` (этап 10, 11 R:PR-04 «сервер человека»): сервер моделей, который
 * человек держит сам (llama-server, LM Studio, vLLM). Ядро говорит с ним ТОЛЬКО по HTTP: проба
 * `/v1/models` (и `/health`, если сервер её знает), факт моделей, адрес сеансу. Процесса ядро
 * не запускает, не останавливает и не снимает никогда — в этом модуле нет ни одного импорта
 * процессов, и тест держит это (мутант «маршрут поднимает сервер»). Сервер не ответил —
 * доступность `absent` с причиной `user_server_down`: поднять его может только человек.
 *
 * Ключ — ИМЯ переменной (`keyVar`): значение берёт дорога сеанса из закрепа задачи, в журнал и
 * в эту настройку оно не попадает.
 */

/** Срок пробы ниже срока класса чтения: причина остаётся «timeout пробы», а не общий срок. */
const DEFAULT_PROBE_TIMEOUT_MS = 4_000;

/** Причина отсутствия, которую читает судья совместимости (код отказа `user_server_down`). */
export const USER_SERVER_DOWN = 'user_server_down';

export function userRouteId(id: string): string {
  return `local:user:${id}`;
}

export interface UserRouteOptions {
  route: UserRoute;
  /** Сеть; по умолчанию — `fetch` процесса (сервер человека, обычно на этой машине). */
  fetch?: NetFetch;
  /** Окружение ядра: есть ли переменная ключа (значение не читается). */
  env?: Record<string, string | undefined>;
  probeTimeoutMs?: number;
  /** Причина последнего `absent` доступности — для решения и для теста. */
  onDown?: (reason: string) => void;
}

export interface UserServerRoute extends Route {
  /** Чем кончилась последняя проба: `up` или причина `user_server_down: …`. */
  lastProbe(): string | undefined;
}

function isLoopback(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/**
 * Причина «сервер лёг» — только для того, что ЗНАНИЕ: никто не слушает порт (ECONNREFUSED),
 * не ответил за срок пробы, ответил «не готов» (503/5xx/429). Всё прочее — отказ ключа, не
 * модельный API, мусор, неведомая сетевая ошибка — не «нет», а сбой чтения (01 §Facts, P44).
 */
export function downReason(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;
  if (code === 'timeout' || code === 'not-ready') return (error as Error).message;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  if (code === 'ECONNREFUSED' || cause?.code === 'ECONNREFUSED') return 'connection refused';
  return undefined;
}

/** Адрес сеансу — корень сервера: `…/v1` в настройке снимается, иначе CLI получил бы `/v1/v1`. */
export function userOrigin(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function createUserRoute(options: UserRouteOptions): UserServerRoute {
  const { route } = options;
  const id = userRouteId(route.id);
  const fetchImpl: NetFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const env = options.env ?? process.env;
  const origin = userOrigin(route.baseUrl);
  const parsed = parseHttpUrl(origin);
  const modelsUrl = `${origin}/v1/models`;
  const isCatalog = (payload: unknown) => extractModels(payload, 'openai-compat') !== undefined;
  let last: string | undefined;

  const down = (why: string) => {
    last = `${USER_SERVER_DOWN}: ${why}`;
    options.onDown?.(last);
  };

  /** `/health` знают llama-server и vLLM; 404 — сервер его не знает, это не «лёг». */
  const health = async (): Promise<void> => {
    let response: Response;
    try {
      response = await fetchImpl(`${origin}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Сеть — решит проба списка: она скажет точнее (timeout / отказ соединения).
      return;
    }
    await response.text().catch(() => '');
    // 503 у llama-server — «модель грузится»: сервер жив, но не готов.
    if (response.status === 503) throw probeError('not-ready', 'health answers 503: loading');
  };

  const probe = async () => {
    await health();
    return probeUnkeyed({
      fetch: fetchImpl,
      url: modelsUrl,
      headers: { accept: 'application/json' },
      timeoutMs,
      isCatalog,
    });
  };

  const catalog = async (): Promise<RouteModel[]> => {
    if (route.models?.length) return route.models.map((model) => ({ id: model }));
    const outcome = await probe();
    if (outcome.kind !== 'catalog') {
      throw new Error(`model list is locked (${outcome.status}) and the config names no models`);
    }
    return (extractModels(outcome.payload, 'openai-compat') ?? []).map((model) => ({
      id: model,
    }));
  };

  const caps: RouteCaps = {
    dialects: [route.dialect],
    tools: true,
    images: false,
    streaming: true,
    maskable: true,
    offline: parsed ? isLoopback(parsed) : false,
    binding: { via: 'endpoint' },
    // Окно контекста сервера CLI обязан знать, как у своей модели (11 R:PR-04).
    limitsToTell: true,
  };

  return {
    kind: 'local',
    id,
    caps,
    facts: routeFactDecls(),
    lastProbe: () => last,
    read: {
      availability: () =>
        readFact('route.availability', async () => {
          if (!parsed) {
            down('address is not an http(s) URL');
            return absent();
          }
          const outcome = await probe().then(
            () => ({ up: true as const }),
            (error: unknown) => {
              const why = downReason(error);
              // Не знание «лёг» (не API, мусор, отказ ключа) — сбой чтения: unknown.
              if (why === undefined) throw error;
              return { why };
            },
          );
          if ('why' in outcome) {
            down(outcome.why);
            return absent();
          }
          last = 'up';
          return { state: 'up' as const };
        }),
      models: () => readFact('route.models', catalog),
      // Пределов частоты и бюджета у своего сервера нет; число слотов он не обязан называть.
      limit: () => readFact('route.limit', () => ({ kind: 'none' as const })),
      price: () => readFact('route.price', () => ({ unit: 'none' as const })),
      credential: () =>
        readFact('route.credential', () =>
          route.keyVar
            ? { kind: 'env' as const, present: Boolean(env[route.keyVar]) }
            : { kind: 'none' as const, present: true },
        ),
      context: (model) =>
        readFact('route.context', async () => {
          const found = (await catalog()).find((entry) => entry.id === model);
          if (found?.contextTokens === undefined)
            throw new Error(`context of ${model} is not declared by the user server`);
          return found.contextTokens;
        }),
    },
    acquire: async (spec: RouteAcquireSpec) => {
      throwIfAborted(spec, 'local:user lease');
      const lease: RouteLease = { leaseId: newId(), routeId: id, model: spec.model, resources: [] };
      return lease;
    },
    endpoint: async () => ({
      baseUrl: origin,
      dialect: route.dialect,
      keyRef: route.keyVar ? { kind: 'env' as const, name: route.keyVar } : null,
    }),
    // Ресурсов маршрут не заводит и ничего не останавливает: сервер принадлежит человеку.
    release: async (): Promise<ReleaseOutcome> => ({ verified: [], leaks: [] }),
  };
}
