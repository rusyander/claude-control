import { join, resolve } from 'node:path';
import {
  HOP_USER_GATEWAY_PORT,
  userGatewayPortOf,
  type HopRegisterSpec,
  type HopUserGatewayState,
  type HopUserRoute,
} from '@agentdeck/contracts/core/hops';
import { LOCAL_PLATFORM_ID } from '@agentdeck/contracts/platform-layers';
import { CORE_HOME_ENV } from '../platform/core-home.ts';
import { currentOs, homeDir, type OsKind } from '../platform/os-kind.ts';
import { LOOPBACK } from '../platform/ports.ts';
import {
  contourStoreId,
  contourToolShim,
  cliDisplayNames,
  gatewayRouteId,
} from '../routes/gateway/gateway.ts';
import type { GatewayProfile } from '../routes/gateway/gateway.types.ts';
import { configureUserGateway, HopHostError } from '../routes/hops/hops.ts';
import type { HopAccess } from './hop-access.ts';
import type { PanelProfiles } from './panel-profiles.ts';
import { contourRoot, contourUpstreamDialect, routeHopFacts } from './panel-routes.ts';

/**
 * Шлюз человека (этап 10): ядро держит настройку шлюза на хосте звеньев — порт и маршрут на
 * каждый контур панели. Хост переживает ядро и панель, поэтому шлюз не закрывается с ядром;
 * зато хост может перезапуститься с пустой настройкой — ядро повторяет её каждый такт
 * (`configure` с тем же портом не перепривязывает, только меняет маршруты). Так же подхватываются
 * контуры, которые человек завёл или выключил в панели.
 */

export interface UserGatewayWiringOptions {
  /** Порт на этом такте: из окружения постоянный, из настроек панели — читается заново. */
  port: () => number;
  hops: HopAccess;
  /** Профили панели, прочитанные заново на такте. */
  profiles: () => PanelProfiles;
  /** Порт постоянного адреса своей модели (`localFrontPortOf`); нет — контур своей модели как есть. */
  localFront?: number;
  intervalMs?: number;
  note: (event: string, data: Record<string, unknown>) => void;
}

export interface UserGatewayWiring {
  /** Последнее состояние, которое назвал хост; `null` — ещё не настроен. */
  state(): HopUserGatewayState | null;
  /** Один такт сейчас (тесты и первый запуск ждут его). */
  tick(): Promise<void>;
  /**
   * Панель записала контур (`POST /v1/contours/apply`): такт со СВЕЖИМ чтением профилей. Идущий
   * такт мог прочитать state.json до записи — его дожидаемся и идём ещё раз, иначе ответ «применено»
   * пришёл бы раньше, чем хост узнал правку.
   */
  apply(): Promise<HopUserGatewayState | null>;
  stop(): void;
}

const INTERVAL_MS = 5_000;

export { userGatewayPortOf } from '@agentdeck/contracts/core/hops';

/** Порт задан окружением — он; `panel` — порт из настроек панели на каждом такте. */
export type UserGatewayPlan = { kind: 'fixed'; port: number } | { kind: 'panel' };

/**
 * Где ядро держит шлюз человека (этап 10, шлюза у панели больше нет). Окружение решает первым
 * (`AGENTDECK_USER_GATEWAY_PORT`: порт — он, `0` или не порт — шлюза нет). Не задано: ядро на
 * доме человека (`~/.agentdeck/core`, без `AGENTDECK_CORE_HOME` и без чужого `--home`) слушает
 * порт из настроек панели — 5179 по умолчанию, тот, что уже вписан в конфиги CLI; ядро на
 * отдельном доме (стенды QA, тесты) шлюза не открывает: иначе оно заняло бы адрес человека.
 */
export function userGatewayPlanOf(
  env: NodeJS.ProcessEnv,
  argvHome?: string,
  os: OsKind = currentOs(),
): UserGatewayPlan | null {
  const set = userGatewayPortOf(env);
  if (set === null) return null;
  if (set !== undefined) return { kind: 'fixed', port: set };
  if ((env[CORE_HOME_ENV] ?? '').trim() !== '') return null;
  if (argvHome === undefined) return { kind: 'panel' };
  const norm = (path: string): string =>
    os === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  return norm(argvHome) === norm(join(homeDir(env, os), '.agentdeck', 'core'))
    ? { kind: 'panel' }
    : null;
}

/** Порт шлюза из настроек панели (`settings.platformGateway.port`); панели нет — 5179. */
export function panelGatewayPort(settings: { gateway: { port: number } } | undefined): number {
  return settings?.gateway.port ?? HOP_USER_GATEWAY_PORT;
}

/**
 * Маршрут контура для шлюза человека — те же факты, что у метки сеанса (`hop-link.ts`): корень
 * API, диалект верха, ключ в хранилище панели, маска политики, драйвер, заголовки, прослойка,
 * управляемые правила; плюс открытые разделы контура.
 * `from` звено ставит по ручке запроса.
 *
 * Контур своей модели (`LOCAL_PLATFORM_ID`) идёт на постоянный адрес ядра (`localFront`, сервер
 * удержания `local:own` за ним), а не на `baseUrl` карточки: тот называл порт прежнего сервера
 * панели, а порт аренды меняется с каждым запуском. Ключа у своей модели нет.
 */
export function userRouteOf(
  profiles: PanelProfiles,
  contour: GatewayProfile,
  localFront?: number,
): HopUserRoute {
  const routeId = gatewayRouteId(contour.id);
  const facts = routeHopFacts(profiles, routeId);
  const to = contourUpstreamDialect(contour);
  const local = contour.id === LOCAL_PLATFORM_ID && localFront !== undefined;
  const spec: HopRegisterSpec = {
    tag: `user:${contour.id}`,
    sessionId: `user:${contour.id}`,
    routeId,
    upstream: local ? `http://${LOOPBACK}:${localFront}/v1` : contourRoot(contour).root,
    from: to,
    to,
    keyRef: local ? null : { kind: 'panel-store', name: contourStoreId(contour.id) },
    dlp: { required: facts.dlpRequired, rulesHash: null },
    features: contourToolShim(contour) ? ['tool-shim'] : [],
    driver: facts.driver,
    upstreamAuth: facts.upstreamAuth,
    upstreamHeaders: { ...facts.upstreamHeaders },
    upstreamQuery: local ? {} : { ...facts.upstreamQuery },
    upstreamRooted: facts.upstreamRooted,
    manifest: facts.manifest,
    requestRules: facts.requestRules,
  };
  return {
    platformId: contour.id,
    title: contour.title,
    enabled: contour.enabled,
    consumers: [...(contour.consumers ?? [])],
    cliNames: cliDisplayNames(),
    spec,
  };
}

export function startUserGatewayWiring(options: UserGatewayWiringOptions): UserGatewayWiring {
  let last: HopUserGatewayState | null = null;
  let lastProblem: string | null = null;
  let lastState: string | null = null;
  let running: Promise<void> | undefined;
  const once = async (): Promise<void> => {
    try {
      const profiles = options.profiles();
      const routes = profiles.contours.map((contour) =>
        userRouteOf(profiles, contour, options.localFront),
      );
      last = await configureUserGateway(await options.hops.handle(), options.port(), routes);
      lastProblem = null;
      // Журнал слышит смену состояния (ждёт → держит), а не каждый такт.
      const now = last ? `${last.state}:${last.port}` : 'closed';
      if (now !== lastState) {
        lastState = now;
        options.note('user-gateway', { ...(last ?? { state: 'closed' }) });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Хост не ответил — забыть: следующий такт найдёт или поднимет его заново.
      if (error instanceof HopHostError && error.code === 'unreachable') options.hops.forget();
      if (reason !== lastProblem) {
        lastProblem = reason;
        options.note('user-gateway.failed', { reason });
      }
    }
  };
  const tick = (): Promise<void> => (running ??= once().finally(() => (running = undefined)));
  // Свежий такт после идущего: просьбы, пришедшие во время ожидания, сходятся в один такт.
  let fresh: Promise<void> | undefined;
  const apply = async (): Promise<HopUserGatewayState | null> => {
    fresh ??= (async () => {
      await running?.catch(() => undefined);
      fresh = undefined;
      await tick();
    })();
    await fresh;
    return last;
  };
  const timer = setInterval(() => void tick(), options.intervalMs ?? INTERVAL_MS);
  timer.unref();
  return { state: () => last, tick, apply, stop: () => clearInterval(timer) };
}
