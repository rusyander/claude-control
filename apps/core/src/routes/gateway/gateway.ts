import type { PlatformModelInfo } from '@agentdeck/contracts/platform';
import { chooseRunModel, type PlatformModelChoice } from '@agentdeck/contracts/platform-models';
import { platformDriverAuth } from '@agentdeck/contracts/platform-presets';
import {
  platformRequestHeaders,
  platformRequestUrl,
} from '@agentdeck/contracts/platform-transport';
import type {
  ReleaseOutcome,
  Route,
  RouteAcquireSpec,
  RouteCaps,
  RouteLease,
  RouteRecorder,
} from '@agentdeck/contracts/core/routes';
import { absent, readFact } from '../../lib/facts/read-fact.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { createCaFetch } from '../../platform/net/ca-fetch.ts';
import { classifyReply, probeUnkeyed } from '../api-key/probe.ts';
import { routeFactDecls } from '../facts.ts';
import { throwIfAborted } from '../lease.ts';
import { catalogItems, isChatModel, readPlatformModels } from './catalog.ts';
import type { GatewayProfile, GatewayRouteOptions } from './gateway.types.ts';

/**
 * Маршрут «шлюз контура» (11 R:PR-01, строка миграции 10:127): запросы идут через звено шлюза
 * (H), ключ контура подставляет звено, в сессии — заглушка. Определение контура — из хранилища
 * панели (только чтение); драйвер, адрес каталога и заголовки — из контрактов `platform-*`, те
 * же, что у панели, поэтому каталог читается так же, как его видит человек.
 *
 * Факты: доступность — проба каталога без ключа (401/403 — жив, закрыт ключом); модели, окно
 * контекста и цена — из каталога (с ключом через звено), не объявлено — `unknown`/только токены;
 * предел — бюджет контура, исчерпание 402 — факт звена, снимает только человек (P122).
 */

/** Срок пробы ниже срока класса (10 с): причина остаётся «timeout пробы». */
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

export function gatewayRouteId(contourId: string): string {
  return `gateway:${contourId}`;
}

/** Имя ключа контура в хранилище ключей панели (`domains/platform/store` `tokenId`). */
export function contourStoreId(contourId: string): string {
  return `platform:${contourId}`;
}

/**
 * Прослойка инструментов карточки в силе: включена человеком и у контура нет своих инструментов
 * (они прослойку гасят, `chooseToolRoute` панели). ОДНО правило для выбора моста
 * (`contourUpstreamDialect`) и возможности звена `tool-shim`, иначе мост шёл бы без прослойки.
 */
export function contourToolShim(profile: Pick<GatewayProfile, 'toolShim' | 'rules'>): boolean {
  return profile.toolShim === true && (profile.rules?.platform.platformTools.length ?? 0) === 0;
}

function authOf(profile: GatewayProfile): { header: string; scheme: string } {
  return platformDriverAuth(profile.driver);
}

/**
 * Модель прогона через контур — ОДНО правило панели и ядра (`chooseRunModel` контрактов):
 * карта соответствия, затем каталог, затем модель потребителя / по умолчанию / первая чатовая.
 * Подмена названа (`replaced`), молча незнакомое имя не уходит.
 */
export function chooseGatewayModel(
  profile: GatewayProfile,
  catalog: readonly PlatformModelInfo[],
  asked: string,
  consumer?: string,
): PlatformModelChoice {
  const chat = catalog.filter(isChatModel).map((model) => model.id);
  const consumerModel = consumer ? (profile.consumerModels[consumer] ?? '').trim() : '';
  const defaultModel = profile.defaultModel.trim();
  let rules: Parameters<typeof chooseRunModel>[0];
  if (consumerModel)
    rules = { model: consumerModel, source: 'consumer', map: profile.modelMap, catalog: chat };
  else if (defaultModel)
    rules = { model: defaultModel, source: 'default', map: profile.modelMap, catalog: chat };
  else rules = { model: chat[0] ?? '', source: 'catalog', map: profile.modelMap, catalog: chat };
  return chooseRunModel(rules, asked);
}

export function createGatewayRoute(options: GatewayRouteOptions): Route {
  const { profile } = options;
  const id = gatewayRouteId(profile.id);
  const storeId = contourStoreId(profile.id);
  const fetchImpl = options.fetch ?? createCaFetch(profile.caCertPath);
  const timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const url = platformRequestUrl(profile.baseUrl, profile.transport, 'models');
  const isCatalog = (payload: unknown): boolean => catalogItems(payload) !== undefined;
  const unkeyedHeaders = platformRequestHeaders(profile.transport, authOf(profile), undefined);

  const unkeyed = () => {
    if (url === undefined) throw new Error('contour base URL is not http(s)');
    return probeUnkeyed({ fetch: fetchImpl, url, headers: unkeyedHeaders, timeoutMs, isCatalog });
  };

  /** Каталог контура: с ключом через звено; без порта — только открытый каталог. */
  const catalog = async (): Promise<PlatformModelInfo[]> => {
    if (url === undefined) throw new Error('contour base URL is not http(s)');
    if (options.keyedProbe) {
      const { header, scheme } = authOf(profile);
      const reply = await options.keyedProbe({
        routeId: id,
        url,
        keyRef: { kind: 'hop-injected', tag: id },
        auth: profile.transport.authHeader.trim()
          ? {
              header: profile.transport.authHeader.trim(),
              scheme: profile.transport.authScheme.trim(),
            }
          : { header, scheme },
        headers: unkeyedHeaders,
      });
      const outcome = classifyReply(reply, isCatalog, true);
      if (outcome.kind === 'catalog') return readPlatformModels(outcome.payload);
    }
    const open = await unkeyed();
    if (open.kind === 'catalog') return readPlatformModels(open.payload);
    throw new Error('contour catalog is locked by the key and no keyed probe port is wired');
  };

  const modelFor = async (asked: string): Promise<PlatformModelInfo | undefined> => {
    const models = await catalog();
    const choice = chooseGatewayModel(profile, models, asked);
    return models.find((model) => model.id === choice.model);
  };

  const caps: RouteCaps = {
    // Звено переводит диалекты (11 §Hop chain): вход — оба, что понимают CLI с каналом.
    dialects: ['anthropic-messages', 'openai-chat'],
    tools: true,
    images: false,
    streaming: true,
    maskable: true,
    offline: false,
    binding: { via: 'endpoint' },
    limitsToTell: false,
    // Инструменты клиента — текстом протокола: звено собирает и разбирает их само (мост).
    ...(contourToolShim(profile) ? { hopFeatures: ['tool-shim'] } : {}),
  };

  return {
    kind: 'gateway',
    id,
    caps,
    facts: routeFactDecls(),
    read: {
      availability: () =>
        readFact('route.availability', async () => {
          // Выключенный контур — маршрута нет по настройке человека: знание, не сбой.
          if (!profile.enabled) return absent();
          await unkeyed();
          return { state: 'up' as const };
        }),
      models: () =>
        readFact('route.models', async () =>
          (await catalog()).filter(isChatModel).map((model) => ({
            id: model.id,
            ...(model.contextLimit !== undefined ? { contextTokens: model.contextLimit } : {}),
            ...(model.functionCalling !== undefined ? { tools: model.functionCalling } : {}),
            ...(model.vision !== undefined ? { images: model.vision } : {}),
          })),
        ),
      limit: () =>
        readFact('route.limit', async () => {
          const status = options.hopStatus ? await options.hopStatus() : {};
          return status.exhaustedAt !== undefined
            ? { kind: 'budget' as const, exhaustedAt: status.exhaustedAt }
            : { kind: 'budget' as const };
        }),
      price: (model) =>
        readFact('route.price', async () => {
          // Цены нет в каталоге — только токены: деньги по догадке не считаются (11 R:PR-06).
          const found = await modelFor(model);
          return found?.price
            ? { unit: 'money' as const, source: 'contour-catalog' }
            : { unit: 'none' as const };
        }),
      credential: () =>
        readFact('route.credential', async () => ({
          kind: 'hop-injected' as const,
          present: await options.credentialPresent(storeId),
        })),
      context: (model) =>
        readFact('route.context', async () => {
          const found = await modelFor(model);
          if (found?.contextLimit === undefined)
            throw new Error(`context of ${model} is not declared by the contour catalog`);
          return found.contextLimit;
        }),
    },
    acquire: async (spec: RouteAcquireSpec) => {
      throwIfAborted(spec, 'gateway lease');
      const lease: RouteLease = { leaseId: newId(), routeId: id, model: spec.model, resources: [] };
      return lease;
    },
    endpoint: async (lease: RouteLease, record: RouteRecorder) => {
      // Адрес шлюза — только порт звена: прямой адрес контура унёс бы ключ в окружение сессии.
      if (options.hopEndpoint) return options.hopEndpoint(lease);
      await record.decision({
        class: 'endpoint',
        facts: [],
        numbers: {},
        reasons: [`${id}: gateway hop client not wired, no address given`],
        output: { kind: 'refuse' },
      });
      return null;
    },
    release: async (): Promise<ReleaseOutcome> => ({ verified: [], leaks: [] }),
  };
}
