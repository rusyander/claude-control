import {
  panelHopTag,
  panelRouteHopTag,
  type CoreContourLinkReply,
  type CoreContourRunReply,
  type HopRegisterSpec,
  type HopUserGatewayState,
} from '@agentdeck/contracts/core/hops';
import { ContourLinkRefused, type ContoursPort } from '../api/contours.ts';
import { LOOPBACK } from '../platform/ports.ts';
import { apiKeyDialect } from '../routes/api-key/api-key.ts';
import { vendorProfiles } from '../routes/api-key/vendor-profiles.ts';
import { gatewayRouteId } from '../routes/gateway/gateway.ts';
import {
  clearExhausted,
  contourSpend,
  contourRun,
  contoursOf,
  contourSummarizedIds,
  HopHostError,
  hopStatus,
  recordContour,
  registerTag,
  type HopHostHandle,
} from '../routes/hops/hops.ts';
import type { HopAccess } from './hop-access.ts';
import type { PanelProfiles } from './panel-profiles.ts';
import { routeHopFacts } from './panel-routes.ts';
import { userRouteOf } from './user-gateway-wiring.ts';

export interface ContoursPortOptions {
  /** Профили панели, прочитанные заново на каждый зов адреса. */
  profiles: () => PanelProfiles;
  /** Порт постоянного адреса своей модели (`localFrontPortOf`), как у шлюза человека. */
  localFront?: number;
  /**
   * Такт шлюза человека со свежим чтением профилей (`UserGatewayWiring.apply`); нет — шлюза у
   * этого ядра нет, правка панели применяется ответом `applied: false`.
   */
  applyUserGateway?: () => Promise<HopUserGatewayState | null>;
  /**
   * Пересборка маршрутов панели в реестре ядра (s10 G7) — до такта шлюза: контур, заведённый
   * после загрузки, становится маршрутом `gateway:<id>`, а не шлюзом `down` под `required`.
   * Нет — реестр этого ядра неизменен (подставленный набором проверок).
   */
  refreshRoutes?: () => void;
}

/**
 * Метка запросов самой панели в контур: факты маршрута — те же, что у шлюза человека
 * (`userRouteOf`), диалект клиента — OpenAI chat: картинки и презентации панели говорят им.
 */
export function panelLinkSpec(
  profiles: PanelProfiles,
  platformId: string,
  localFront?: number,
): HopRegisterSpec | null {
  const contour = profiles.contours.find((item) => item.id === platformId);
  if (!contour?.enabled) return null;
  const { spec } = userRouteOf(profiles, contour, localFront);
  // Диалект OpenAI chat с ОБЕИХ сторон: ручки картинок и разговора у контура OpenAI-вида есть и
  // при родной ручке Anthropic (её выбрал бы `userRouteOf`), а перевода openai→anthropic у моста
  // нет. Прослойки нет: панель инструментов не шлёт.
  return {
    ...spec,
    tag: panelHopTag(platformId),
    sessionId: panelHopTag(platformId),
    from: 'openai-chat',
    to: 'openai-chat',
    features: [],
  };
}

/**
 * Метка прямых вызовов API самой панели по ключу (Q5): свой эндпоинт (`api-key:endpoint:<id>`) или
 * ключ вендора (`api-key:<cli>`) — те же профили и факты звена, что у маршрута сеанса
 * (`panelRoutes`/`routeHopFacts`); диалект клиента и верха — вид API профиля, перевода нет.
 * Профиля нет (не сохранён, у вендора нет адреса в фактах запуска) — `null`.
 */
export function panelRouteLinkSpec(
  profiles: PanelProfiles,
  routeId: string,
): HopRegisterSpec | null {
  const profile = [...vendorProfiles(), ...profiles.endpoints].find(
    (item) => item.routeId === routeId,
  );
  if (!profile) return null;
  const facts = routeHopFacts(profiles, routeId);
  const dialect = apiKeyDialect(profile.apiKind);
  return {
    tag: panelRouteHopTag(routeId),
    sessionId: panelRouteHopTag(routeId),
    routeId,
    upstream: profile.baseUrl.trim().replace(/\/+$/, ''),
    from: dialect,
    to: dialect,
    keyRef: { kind: 'panel-store', name: profile.storeId },
    dlp: { required: facts.dlpRequired, rulesHash: null },
    features: [],
    driver: facts.driver,
    upstreamAuth: facts.upstreamAuth,
    upstreamHeaders: facts.upstreamHeaders,
    upstreamQuery: facts.upstreamQuery,
    upstreamRooted: facts.upstreamRooted,
    manifest: facts.manifest,
    requestRules: facts.requestRules,
  };
}

/**
 * Учёт контуров для API (`/v1/contours*`, C3b) над хостом звеньев. Чтение карточки и запись
 * шлюза панели поднимают хост, как любой зов (`handle`); извещения о бюджете — только у живого
 * (`live`): без звена трафика не было. Зов, не прошедший до хоста, забывает его — следующий
 * найдёт или поднимет заново.
 */
export function createContoursPort(hops: HopAccess, options: ContoursPortOptions): ContoursPort {
  // Регистрация выдаёт НОВУЮ заглушку и гасит прежнюю (`tags.register`): повторять её на каждую
  // картинку значило бы отзывать ключ у соседнего запроса. Держим выданное, пока факты контура
  // и хост те же; `fresh` (хост отверг заглушку) регистрирует заново.
  const links = new Map<string, { facts: string; host: number; reply: CoreContourLinkReply }>();
  const call = async <T>(
    pick: () => Promise<HopHostHandle | undefined>,
    run: (handle: HopHostHandle) => Promise<T>,
    absent: () => T,
  ): Promise<T> => {
    const handle = await pick();
    if (!handle) return absent();
    try {
      return await run(handle);
    } catch (error) {
      hops.forget();
      throw error;
    }
  };
  // `handle` хост всегда находит или поднимает — ветки «хоста нет» у этих зовов не бывает.
  const any = () => hops.handle();
  const never = (): never => {
    throw new Error('hop host handle missing');
  };
  return {
    applyUserGateway: async () => {
      options.refreshRoutes?.();
      const apply = options.applyUserGateway;
      return apply
        ? { applied: true, userGateway: await apply() }
        : { applied: false, userGateway: null };
    },
    read: () =>
      call(
        any,
        async (handle) => {
          const [live, records, status] = await Promise.all([
            contoursOf(handle),
            contourSpend(handle),
            hopStatus(handle),
          ]);
          return { live, records, userGateway: status.userGateway ?? null };
        },
        never,
      ),
    notices: (after) =>
      call(
        () => hops.live(),
        async (handle) => (await contoursOf(handle)).notices.filter((item) => item.seq > after),
        () => [],
      ),
    record: (body) => call(any, (handle) => recordContour(handle, body), never),
    clearExhausted: (platformId) =>
      call(any, (handle) => clearExhausted(handle, gatewayRouteId(platformId)), never),
    // Факты прогона — только у живого звена: прогон через контур поднял его своей записью, а
    // без звена запросов не было.
    run: (runTag, since) =>
      call<CoreContourRunReply>(
        () => hops.live(),
        (handle) => contourRun(handle, runTag, since),
        () => ({ summarized: false }),
      ),
    // Журнал сжатий лежит на диске звена и нужен старой переписке и после перезапуска: читатель
    // поднимает звено, как любой зов.
    summarizedIds: () => call(any, (handle) => contourSummarizedIds(handle), never),
    link: (platformId, fresh) =>
      linkOf(panelLinkSpec(options.profiles(), platformId, options.localFront), fresh),
    linkRoute: (routeId, fresh) => linkOf(panelRouteLinkSpec(options.profiles(), routeId), fresh),
  };

  /** Регистрация метки панели с памятью по метке (см. `links`); `null` — маршрута нет. */
  async function linkOf(
    spec: HopRegisterSpec | null,
    fresh: boolean,
  ): Promise<CoreContourLinkReply | null> {
    if (!spec) return null;
    const facts = JSON.stringify(spec);
    const handle = await hops.handle();
    const held = links.get(spec.tag);
    if (!fresh && held && held.facts === facts && held.host === handle.pid) return held.reply;
    try {
      const registered = await registerTag(handle, spec);
      const reply = {
        baseUrl: `http://${LOOPBACK}:${registered.port}`,
        key: registered.placeholder,
      };
      links.set(spec.tag, { facts, host: handle.pid, reply });
      return reply;
    } catch (error) {
      links.delete(spec.tag);
      if (error instanceof HopHostError && error.code !== 'unreachable')
        throw new ContourLinkRefused(error.code, error.message);
      hops.forget();
      throw error;
    }
  }
}
