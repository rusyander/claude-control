import type { CoreHomeLayout } from '../platform/core-home.ts';
import type { ContourPolicy } from '../policy/resolve/resolve.types.ts';
import { contourStoreId, gatewayRouteId } from '../routes/gateway/gateway.ts';
import { keyPresencePort } from './economy-wiring/r.ts';
import { createHopAccess, type HopAccess } from './hop-access.ts';
import { panelAppDataDir, readPanelProfiles, type PanelProfiles } from './panel-profiles.ts';
import { routeHopFacts, type PanelRouteSources, type RouteHopFacts } from './panel-routes.ts';

/**
 * Сборка загрузки для маршрутов через панель и звено (W2b): каталог данных панели (только чтение),
 * его профили, порт наличия ключа и доступ к хосту звеньев. Хост — один на дом ядра и поднимается
 * лениво; каталог панели передаётся ему же, ключи `panel-store` он читает сам.
 */
export interface PanelWiring {
  /** Нет каталога панели — маршрутов `api-key`/`gateway` нет. */
  sources?: PanelRouteSources;
  hops: HopAccess;
  hopFactsOf(routeId: string): RouteHopFacts;
  /**
   * Активный контур панели как политика уровня 1 (06 §Precedence): `required` сводит набор
   * к `gateway:<id>`. Контур не выбран — `undefined`. Читается заново на КАЖДЫЙ зов (s10 G7):
   * смена режима или активного контура доходит до следующей команды и шага без перезапуска ядра.
   */
  contour(routeKnown: (routeId: string) => boolean): ContourPolicy | undefined;
  /** Профили, прочитанные заново сейчас (шлюз человека видит новые и выключенные контуры). */
  profilesNow(): PanelProfiles;
  /** Каталог данных панели этой загрузки; `null` — без панели. */
  appData: string | null;
}

/**
 * Политика контура из профилей панели (только чтение их файла). Шлюз `down` — дойти нечем:
 * маршрута контура нет в реестре этой загрузки или ключа контура нет в хранилище панели (те же
 * две причины, что `unreachable` сервера: шлюз лежит / нет токена; P118 — отказ, не облако
 * вендора). Хранилище не читается — `unknown`, как и «ключ есть»: живую доступность судит звено
 * при запуске, а не загрузка.
 */
export function contourPolicyOf(
  profiles: Pick<PanelProfiles, 'contours' | 'activeContourId'>,
  routeKnown: (routeId: string) => boolean,
  keyPresent?: (storeId: string) => boolean,
): ContourPolicy | undefined {
  const id = profiles.activeContourId;
  const card = id ? profiles.contours.find((c) => c.id === id) : undefined;
  if (!card) return undefined;
  let gateway: ContourPolicy['gateway'] = routeKnown(gatewayRouteId(card.id)) ? 'unknown' : 'down';
  if (gateway === 'unknown' && keyPresent) {
    try {
      if (!keyPresent(contourStoreId(card.id))) gateway = 'down';
    } catch {
      gateway = 'unknown';
    }
  }
  const model = card.defaultModel.trim();
  return { contourId: card.id, mode: card.mode, gateway, ...(model ? { model } : {}) };
}

const NO_PROFILES: PanelProfiles = {
  endpoints: [],
  contours: [],
  dlpOn: false,
  contourMask: {},
  activeContourId: null,
  forceStream: true,
  problems: [],
};

/**
 * `panelAppData`: строка — этот каталог; `null` — без панели; нет — `panelAppDataDir()` (явная
 * переменная, иначе каталог панели по её же правилу, но не при перенесённом доме ядра).
 */
export function panelWiring(
  layout: CoreHomeLayout,
  options: { panelAppData?: string | null; bootId: string },
  note: (event: string, data: Record<string, unknown>) => void,
): PanelWiring {
  const appData =
    options.panelAppData === undefined ? panelAppDataDir() : (options.panelAppData ?? undefined);
  const hops = createHopAccess({
    home: layout.root,
    ownerBootId: options.bootId,
    ...(appData ? { panelAppData: appData } : {}),
  });
  const profiles = appData ? readPanelProfiles(appData) : NO_PROFILES;
  // Запись панели, которая не прочиталась, названа в журнале ядра, а не пропала молча.
  for (const problem of profiles.problems) note('panel.profile.unread', { problem });
  const profilesNow = (): PanelProfiles => (appData ? readPanelProfiles(appData) : NO_PROFILES);
  return {
    ...(appData
      ? { sources: { keys: { credentialPresent: keyPresencePort(appData) }, profiles, hops } }
      : {}),
    hops,
    // Факты звена — со свежего чтения (s10 G7): контур, заведённый после загрузки, получает свою
    // маску и драйвер, а не факты маршрута не из профилей.
    hopFactsOf: (routeId) => routeHopFacts(profilesNow(), routeId),
    // Политика — со свежего чтения: человек переключил режим на карточке, а ядро живёт дальше.
    // Маршрут контура, заведённого после загрузки, появляется в реестре на `POST /v1/contours/apply`
    // (пересборка маршрутов панели); до неё шлюз `down`, то есть отказ, а не облако вендора.
    contour: (routeKnown) =>
      contourPolicyOf(profilesNow(), routeKnown, appData ? keyPresencePort(appData) : undefined),
    profilesNow,
    appData: appData ?? null,
  };
}
