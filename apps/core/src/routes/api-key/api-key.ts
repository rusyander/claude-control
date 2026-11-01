import type {
  Dialect,
  KeyRef,
  ReleaseOutcome,
  Route,
  RouteAcquireSpec,
  RouteCaps,
  RouteLease,
  RouteModel,
  RouteRecorder,
} from '@agentdeck/contracts/core/routes';
import { absent, readFact } from '../../lib/facts/read-fact.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { createCaFetch } from '../../platform/net/ca-fetch.ts';
import { routeFactDecls } from '../facts.ts';
import { throwIfAborted } from '../lease.ts';
import type { ApiKeyKind, ApiKeyRouteOptions, KeyedProbeRequest } from './api-key.types.ts';
import {
  classifyReply,
  endpointModelsUrl,
  extractModels,
  parseHttpUrl,
  probeUnkeyed,
} from './probe.ts';

/**
 * Маршрут «ключ API» (11 R:PR-01, строки миграции 10:139, 10:140): адрес вендора или свой адрес
 * панели, доступ — ключ из хранилища панели. Ключа ядро не держит никогда (09, G5): факт доступа —
 * только НАЛИЧИЕ, каталог с ключом читает звено по `keyRef`.
 *
 * Доступность — проба списка моделей БЕЗ ключа: 401/403 значит «адрес жив, закрыт ключом».
 * Предел — частота (429 + retry-after в потоке), с пределом человека — бюджет; исчерпание (402)
 * — факт звена. Цена — из таблицы цен (зона L) по порту; не названа — `unknown`, деньги не
 * угадываются.
 */

const DIALECT_OF: Record<ApiKeyKind, Dialect> = {
  anthropic: 'anthropic-messages',
  google: 'google-genai',
  'openai-compat': 'openai-chat',
};

/** Срок пробы ниже срока класса (10 с): причина остаётся «timeout пробы», а не общий срок. */
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

/** Диалект адреса профиля этого вида API. */
export function apiKeyDialect(apiKind: ApiKeyKind): Dialect {
  return DIALECT_OF[apiKind];
}

export function apiKeyRouteId(subject: string): string {
  return `api-key:${subject}`;
}

function isLoopbackUrl(raw: string): boolean {
  const url = parseHttpUrl(raw);
  if (!url) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/** Куда звену положить ключ для этого вида API (как у вендора в документации). */
export function keyPlacement(apiKind: ApiKeyKind): KeyedProbeRequest['auth'] {
  if (apiKind === 'anthropic') return { header: 'x-api-key', scheme: '' };
  // Google — заголовком `x-goog-api-key`, не параметром адреса: правило звена «ключ никогда в
  // адресе» (адрес попадает в журналы и следы, заголовок — нет).
  if (apiKind === 'google') return { header: 'x-goog-api-key', scheme: '' };
  return { header: 'authorization', scheme: 'Bearer' };
}

function headersOf(apiKind: ApiKeyKind): Record<string, string> {
  return apiKind === 'anthropic'
    ? { accept: 'application/json', 'anthropic-version': '2023-06-01' }
    : { accept: 'application/json' };
}

export function createApiKeyRoute(options: ApiKeyRouteOptions): Route {
  const { profile } = options;
  const id = profile.routeId;
  const fetchImpl = options.fetch ?? createCaFetch(profile.caCertPath ?? '');
  const timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const url = endpointModelsUrl(profile.baseUrl, profile.apiKind);
  const isCatalog = (payload: unknown): boolean =>
    extractModels(payload, profile.apiKind) !== undefined;
  const keyRef: KeyRef =
    profile.keyChannel === 'hop-injected'
      ? { kind: 'hop-injected', tag: options.hopTag ?? id }
      : { kind: 'panel-store', name: profile.storeId };

  const unkeyed = () =>
    probeUnkeyed({
      fetch: fetchImpl,
      url,
      headers: headersOf(profile.apiKind),
      timeoutMs,
      isCatalog,
    });

  /** Каталог: с ключом через звено, иначе открытый ответ без ключа, иначе модель профиля. */
  const catalog = async (): Promise<RouteModel[]> => {
    if (options.keyedProbe) {
      const reply = await options.keyedProbe({
        routeId: id,
        url,
        keyRef,
        auth: keyPlacement(profile.apiKind),
        headers: headersOf(profile.apiKind),
      });
      const outcome = classifyReply(reply, isCatalog, true);
      if (outcome.kind === 'catalog') return modelsOf(outcome.payload);
    }
    const open = await unkeyed();
    if (open.kind === 'catalog') return modelsOf(open.payload);
    if (profile.model) return [{ id: profile.model }];
    throw new Error('catalog is locked by the key and no keyed probe port is wired');
  };
  const modelsOf = (payload: unknown): RouteModel[] =>
    (extractModels(payload, profile.apiKind) ?? []).map((model) => ({ id: model }));

  const caps: RouteCaps = {
    dialects: [DIALECT_OF[profile.apiKind]],
    tools: true,
    images: false,
    streaming: true,
    // Тело Google DLP-звено не разбирает (`dlp_opaque`, 11 R:PR-05): объявить иное было бы ложью.
    maskable: profile.apiKind !== 'google',
    offline: profile.offline ?? isLoopbackUrl(profile.baseUrl),
    binding: { via: 'endpoint' },
    limitsToTell: false,
  };

  return {
    kind: 'api-key',
    id,
    caps,
    facts: routeFactDecls(),
    read: {
      availability: () =>
        readFact('route.availability', async () => {
          // Не http(s) — маршрута нет по настройке: это ЗНАНИЕ, а не сбой чтения.
          if (!parseHttpUrl(url)) return absent();
          await unkeyed();
          return { state: 'up' as const };
        }),
      models: () => readFact('route.models', catalog),
      limit: () =>
        readFact('route.limit', async () => {
          const status = options.hopStatus ? await options.hopStatus() : {};
          if (status.exhaustedAt !== undefined)
            return { kind: 'budget' as const, exhaustedAt: status.exhaustedAt };
          return profile.userCapUsd ? { kind: 'budget' as const } : { kind: 'rate' as const };
        }),
      price: (model) =>
        readFact('route.price', async () => {
          if (!options.priceKnown) throw new Error('no pricing table port wired');
          // Цена не названа таблицей — только токены, деньги не угадываются (11 R:PR-06).
          return (await options.priceKnown(model))
            ? { unit: 'money' as const, source: 'pricing-table' }
            : { unit: 'none' as const };
        }),
      credential: () =>
        readFact('route.credential', async () => ({
          kind: profile.keyChannel,
          present: await options.credentialPresent(profile.storeId),
        })),
      context: (model) =>
        readFact('route.context', async () => {
          const found = (await catalog()).find((entry) => entry.id === model);
          if (found?.contextTokens === undefined)
            throw new Error(`context of ${model} is not declared by the catalog`);
          return found.contextTokens;
        }),
    },
    acquire: async (spec: RouteAcquireSpec) => {
      throwIfAborted(spec, 'api-key lease');
      const lease: RouteLease = { leaseId: newId(), routeId: id, model: spec.model, resources: [] };
      return lease;
    },
    endpoint: async (lease: RouteLease, record: RouteRecorder) => {
      // Ключ подставляет звено (G4): адрес даёт его клиент; прямой адрес — только без звена,
      // иначе ключ поехал бы в окружение сессии мимо выбранного канала.
      if (profile.keyChannel === 'hop-injected') {
        if (options.hopEndpoint) return options.hopEndpoint(lease);
        await record.decision({
          class: 'endpoint',
          facts: [],
          numbers: {},
          reasons: [`${id}: key goes through the hop, hop client not wired`],
          output: { kind: 'refuse' },
        });
        return null;
      }
      return {
        baseUrl: profile.baseUrl.trim().replace(/\/+$/, ''),
        dialect: DIALECT_OF[profile.apiKind],
        keyRef,
      };
    },
    // Ресурсов маршрут не заводит: метку у звена ведёт клиент `routes/hops`.
    release: async (): Promise<ReleaseOutcome> => ({ verified: [], leaks: [] }),
  };
}
