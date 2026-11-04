import type { HopRequestRules, HopUpstreamAuth } from '@agentdeck/contracts/core/hops';
import type { Dialect, KeyRef, Route, RouteEndpoint } from '@agentdeck/contracts/core/routes';
import {
  platformDeclaresAnonymization,
  platformDriverAuth,
  platformManifestOf,
  platformPreset,
  type PlatformManifestOverrides,
} from '@agentdeck/contracts/platform-presets';
import {
  parseTransportHeaders,
  parseTransportQuery,
  platformRequestUrl,
} from '@agentdeck/contracts/platform-transport';
import { dataMaskDecision } from '@agentdeck/dlp/data-mask';
import { apiKeyDialect, createApiKeyRoute, keyPlacement } from '../routes/api-key/api-key.ts';
import type {
  ApiKeyKind,
  HopRouteStatus,
  KeyedProbe,
  KeyedProbeRequest,
} from '../routes/api-key/api-key.types.ts';
import {
  contourStoreId,
  contourToolShim,
  createGatewayRoute,
  gatewayRouteId,
} from '../routes/gateway/gateway.ts';
import { vendorProfiles } from '../routes/api-key/vendor-profiles.ts';
import { contourRequestRules } from '../routes/gateway/contour-rules.ts';
import type { GatewayProfile } from '../routes/gateway/gateway.types.ts';
import { hopStatus, probeRoute } from '../routes/hops/hops.ts';
import type { KeyPresencePort } from './economy-wiring/r.ts';
import type { HopAccess } from './hop-access.ts';
import type { PanelProfiles } from './panel-profiles.ts';

/**
 * Маршруты из профилей панели (решение стадии 5, W2b): `api-key:<cli>` на ключ вендора с адресом
 * из фактов запуска, `api-key:endpoint:<id>` на каждый свой адрес человека и `gateway:<id>` на
 * каждый контур. Ключа ядро не держит (09, G5): наличие — порт хранилища, чтение каталога с
 * ключом и исчерпание 402 — хост звеньев, адрес аренды — ВЕРХ цепи со ссылкой на ключ в
 * хранилище панели; звено перед ним ставит дорога сессии (`hop-link.ts`), так что ключ доходит
 * только до звена.
 */

export interface PanelRouteSources {
  keys: { credentialPresent: KeyPresencePort };
  profiles: PanelProfiles;
  /** Хост звеньев; нет — каталог с ключом и исчерпание `unknown`, сеанс через звено — отказ. */
  hops?: HopAccess;
}

/**
 * Факты звена маршрута из профиля: драйвер контура, требование маски (политика панели) и как
 * ключ идёт наверх — заголовок карточки или пресета, постоянные заголовки и параметры адреса.
 */
export interface RouteHopFacts {
  driver: string | null;
  dlpRequired: boolean;
  upstreamAuth: HopUpstreamAuth | null;
  upstreamHeaders: Record<string, string>;
  upstreamQuery: Record<string, string>;
  /** Адрес верха — корень API с версией (`HopRegisterSpec.upstreamRooted`). */
  upstreamRooted: boolean;
  /** Пресет ⊕ карточка (`HopRegisterSpec.manifest`); `null` — маршрут не контура. */
  manifest: PlatformManifestOverrides | null;
  /** Управляемые правила контура в полях провода (`contourRequestRules`); `null` — не контур. */
  requestRules: HopRequestRules | null;
}

const storeRef = (storeId: string): KeyRef => ({ kind: 'panel-store', name: storeId });

/**
 * Чтение каталога с ключом через звено. Ссылка ключа — имя в хранилище панели: `hop-injected`
 * маршрута значит «ключ подставит звено», а у пробы нет сеанса, чья метка несла бы ключ.
 */
function hopProbe(hops: HopAccess, storeId: string): KeyedProbe {
  return async (request: KeyedProbeRequest) =>
    probeRoute(await hops.handle(), { ...request, keyRef: storeRef(storeId) });
}

/** Исчерпание (402) маршрута — факт хоста звеньев; держится, пока его не снимет человек. */
function hopExhaustion(hops: HopAccess, routeId: string): () => Promise<HopRouteStatus> {
  return async () => {
    const status = await hopStatus(await hops.handle());
    const row = status.exhausted.find((item) => item.routeId === routeId);
    return row ? { exhaustedAt: row.exhaustedAt } : {};
  };
}

const origin = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, '');

/**
 * Корень API контура тем же правилом, что у панели (`platformRequestUrl`: версия `auto`/`as-is`),
 * без строки запроса: параметры адреса и настройки звено ставит само (`upstreamQuery`).
 */
export function contourRoot(contour: GatewayProfile): {
  root: string;
  query: Record<string, string>;
} {
  const built = platformRequestUrl(contour.baseUrl, { ...contour.transport, query: '' }, '');
  if (built === undefined) return { root: origin(contour.baseUrl), query: {} };
  const url = new URL(built);
  const query: Record<string, string> = {};
  for (const [name, value] of url.searchParams) query[name] = value;
  for (const [name, value] of parseTransportQuery(contour.transport.query).pairs)
    query[name] = value;
  return { root: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, query };
}

/**
 * Манифест контура поверх базы: пресет, затем карточка, поле за полем (`platformManifestDeclared`
 * панели тем же порядком). Звено знает только базы, поэтому объявленное пресетом едет с регистрацией.
 */
export function contourManifest(contour: GatewayProfile): PlatformManifestOverrides {
  return { ...platformPreset(contour.driver).manifest, ...platformManifestOf(contour.manifest) };
}

/**
 * Диалект верха контура. Объявлена родная ручка Anthropic (LiteLLM, OpenRouter, vLLM, …) — клиент
 * Anthropic идёт к ней без моста: мост теряет размышления, метки кэша и подписанные блоки. Прослойка
 * инструментов карточки сильнее манифеста (её протокол собран под мост), кроме контура со своими
 * инструментами — то же правило, что `nativeMessagesPath` шлюза панели. Иначе — мост в openai-chat.
 */
export function contourUpstreamDialect(contour: GatewayProfile): Dialect {
  if (!contourManifest(contour).anthropicMessages) return 'openai-chat';
  return contourToolShim(contour) ? 'openai-chat' : 'anthropic-messages';
}

export function panelRoutes(sources: PanelRouteSources): Route[] {
  const { keys, profiles, hops } = sources;
  const routes: Route[] = [];
  for (const profile of [...vendorProfiles(), ...profiles.endpoints]) {
    const upstream: RouteEndpoint = {
      baseUrl: origin(profile.baseUrl),
      dialect: apiKeyDialect(profile.apiKind),
      keyRef: storeRef(profile.storeId),
    };
    routes.push(
      createApiKeyRoute({
        profile,
        credentialPresent: keys.credentialPresent,
        hopEndpoint: async () => upstream,
        ...(hops
          ? {
              keyedProbe: hopProbe(hops, profile.storeId),
              hopStatus: hopExhaustion(hops, profile.routeId),
            }
          : {}),
      }),
    );
  }
  for (const contour of profiles.contours) {
    const routeId = gatewayRouteId(contour.id);
    const storeId = contourStoreId(contour.id);
    // Диалект верха контура — родная ручка Anthropic по манифесту, иначе openai-chat (мост звена).
    const upstream: RouteEndpoint = {
      baseUrl: contourRoot(contour).root,
      dialect: contourUpstreamDialect(contour),
      keyRef: storeRef(storeId),
    };
    routes.push(
      createGatewayRoute({
        profile: contour,
        credentialPresent: keys.credentialPresent,
        hopEndpoint: async () => upstream,
        ...(hops
          ? { keyedProbe: hopProbe(hops, storeId), hopStatus: hopExhaustion(hops, routeId) }
          : {}),
      }),
    );
  }
  return routes;
}

function keyHeader(apiKind: ApiKeyKind): HopUpstreamAuth {
  const placement = keyPlacement(apiKind);
  // Ключ профиля API — всегда заголовком (правило звена «ключ никогда в адресе»).
  return 'header' in placement ? placement : { header: 'authorization', scheme: 'Bearer' };
}

/**
 * Факты звена по id маршрута. Маска контура — тем же решением, что у шлюза панели
 * (`dataMaskOn`): выбор карточки, а не выбрал — объявил ли драйвер подмену данных; общий
 * выключатель сильнее обоих. Маршруты не из профилей панели — без маски политики (вход CLI,
 * заглушки, своя модель) и с ключом по диалекту звена.
 */
export function routeHopFacts(profiles: PanelProfiles, routeId: string): RouteHopFacts {
  const contour = profiles.contours.find((c) => gatewayRouteId(c.id) === routeId);
  if (contour) {
    // Звено знает драйверы БАЗ (`openai-compat`, `enterprise-platform`), а карточка хранит имя
    // пресета (`litellm`, `vllm`, …): без сведения регистрация отказывала бы `unknown_driver`.
    const driver = platformPreset(contour.driver).base;
    const { on } = dataMaskDecision({
      globalOn: profiles.dlpOn,
      choice: profiles.contourMask[contour.id],
      declared: platformDeclaresAnonymization(contour.driver),
    });
    // Ключ — в заголовок карточки (`transport.authHeader`/`authScheme`), иначе пресета (Azure —
    // `api-key` без слова), иначе `Authorization: Bearer`: как `platformRequestHeaders` панели.
    const own = contour.transport.authHeader.trim();
    const driverAuth = platformDriverAuth(contour.driver);
    const upstreamAuth = own
      ? { header: own.toLowerCase(), scheme: contour.transport.authScheme.trim() }
      : driverAuth;
    const { headers } = parseTransportHeaders(contour.transport.headers, driverAuth.header, own);
    return {
      driver,
      dlpRequired: on,
      upstreamAuth,
      upstreamHeaders: headers,
      upstreamQuery: contourRoot(contour).query,
      upstreamRooted: true,
      manifest: contourManifest(contour),
      requestRules: contourRequestRules(contour, profiles.forceStream),
    };
  }
  const endpoint = [...vendorProfiles(), ...profiles.endpoints].find((e) => e.routeId === routeId);
  return {
    driver: null,
    dlpRequired: endpoint ? profiles.dlpOn : false,
    upstreamAuth: endpoint ? keyHeader(endpoint.apiKind) : null,
    upstreamHeaders: {},
    upstreamQuery: {},
    // `openai-compat` профиля — адрес вместе с версией (`endpointProfileSchema.baseUrl`).
    upstreamRooted: endpoint?.apiKind === 'openai-compat',
    manifest: null,
    requestRules: null,
  };
}
