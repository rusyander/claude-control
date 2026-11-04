import {
  HOP_DLP_PARSES,
  HOP_TRANSLATIONS,
  type HopRegisterSpec,
  type HopRequestRules,
  type HopUpstreamAuth,
} from '@agentdeck/contracts/core/hops';
import type {
  AdapterChannelSummary,
  CompatDecision,
  CompatPolicy,
  Route,
  RouteEndpoint,
} from '@agentdeck/contracts/core/routes';
import type { PlatformManifestOverrides } from '@agentdeck/contracts/platform-presets';
import {
  applyHopEnv,
  HopHostError,
  registerTag,
  unregisterTag,
  type HopHostHandle,
} from '../../routes/hops/hops.ts';

/**
 * Звено на дороге сессии (11 §Hop chain, G4): когда сеанс идёт через хост звеньев, как его
 * зарегистрировать и что сеанс получает взамен адреса маршрута — порт звена и ЗАГЛУШКУ ключа.
 * Ключ маршрута (`panel-store`) читает и подставляет только звено (G5, P112): ядро и окружение
 * сеанса его не видят.
 */

/** Факты звена маршрута: драйвер, маска политики и как ключ идёт наверх (карточка контура). */
export interface RoadHopFacts {
  driver: string | null;
  dlpRequired: boolean;
  /** Заголовок ключа верха (свой контура или пресета); нет — по диалекту верха. */
  upstreamAuth?: HopUpstreamAuth | null;
  upstreamHeaders?: Record<string, string>;
  upstreamQuery?: Record<string, string>;
  /** Адрес верха — корень версии (контур, совместимый шлюз): `/v1` пути не удваивается. */
  upstreamRooted?: boolean;
  /** Манифест контура (пресет ⊕ карточка) для драйвера звена; нет — драйвер базы как есть. */
  manifest?: PlatformManifestOverrides | null;
  /** Управляемые правила контура в полях провода (`contourRequestRules`); нет — без правил. */
  requestRules?: HopRequestRules | null;
}

/** Хост звеньев для дороги и факты звена по маршруту (профили панели, `panel-routes.ts`). */
export interface RoadHops {
  handle(): Promise<HopHostHandle>;
  /** Связь с хостом не прошла — следующий зов найдёт или поднимет его заново. */
  forget?(): void;
  factsOf(routeId: string): RoadHopFacts;
}

/**
 * Политика судьи `compat` про звено: маска — по политике маршрута; разбор и переводы — только
 * если хост звеньев проведён (без хоста не маскирует и не переводит никто).
 */
export function hopPolicy(
  hops: RoadHops | undefined,
  routeId: string,
): Pick<CompatPolicy, 'dlp' | 'translations'> {
  const required = hops?.factsOf(routeId).dlpRequired ?? false;
  return {
    // Списки — контракта хоста (`contracts/core/hops`): хост отказывает регистрации вне них.
    dlp: { required, parses: hops ? [...HOP_DLP_PARSES] : [] },
    translations: hops ? [...HOP_TRANSLATIONS] : [],
  };
}

/** Почему сеансу нужно звено (G4); `null` — не нужно, адрес маршрута идёт в сеанс как есть. */
export function hopReason(
  route: Route,
  endpoint: RouteEndpoint,
  compat: CompatDecision,
  hops: RoadHops | undefined,
): string | null {
  if (route.kind === 'gateway') return 'gateway route';
  if (compat.kind === 'via-gateway') return `translation ${compat.from} → ${compat.to}`;
  const ref = endpoint.keyRef;
  if (ref !== null && ref.kind !== 'env') return `key ${ref.kind} is injected by the hop`;
  if ((route.caps.hopFeatures?.length ?? 0) > 0) return 'route asks hop features';
  if (hops?.factsOf(route.id).dlpRequired) return 'policy requires DLP';
  return null;
}

export interface HopLinked {
  /** Адрес звена этого сеанса и заглушка ключа — то, что видит CLI. */
  baseUrl: string;
  key: string;
  /** Пин без ключей и с адресом звена (`applyHopEnv`). */
  pin: Record<string, string>;
  hops: { kind: 'dlp' | 'gateway'; port: number }[];
  handle: HopHostHandle;
  tag: string;
  /** Ключ `env` из пина, отданный звену в память метки: имя и значение — маске `known` (P61). */
  sessionKey?: { name: string; value: string };
}

export interface HopLinkInput {
  hops: RoadHops | undefined;
  reason: string;
  sessionId: string;
  route: Route;
  endpoint: RouteEndpoint;
  channel: AdapterChannelSummary;
  compat: CompatDecision;
  pin: Record<string, string>;
}

/** Регистрация метки сеанса у звена; отказ — строкой причины, сеанс не запускается. */
export async function linkHop(input: HopLinkInput): Promise<HopLinked | { refused: string }> {
  const { hops, route, endpoint, channel, compat } = input;
  if (!hops)
    return { refused: `route ${route.id} needs the hop (${input.reason}); hop host not wired` };
  // Ключ `env` живёт в пине задачи, а не в окружении хоста (он общий на дом ядра): значение
  // уходит звену при регистрации и держится в памяти метки; из окружения сеанса оно вычищается
  // (`applyHopEnv`), так что CLI видит только заглушку (G5, P112).
  const ref = endpoint.keyRef;
  let sessionKey: HopLinked['sessionKey'];
  if (ref?.kind === 'env') {
    const value = input.pin[ref.name];
    if (!value)
      return { refused: `route ${route.id}: key variable ${ref.name} not in the task pin` };
    sessionKey = { name: ref.name, value };
  }
  const facts = hops.factsOf(route.id);
  const spec: HopRegisterSpec = {
    tag: input.sessionId,
    sessionId: input.sessionId,
    routeId: route.id,
    upstream: endpoint.baseUrl,
    from: channel.dialect,
    to: compat.kind === 'via-gateway' ? compat.to : endpoint.dialect,
    keyRef: endpoint.keyRef,
    dlp: { required: facts.dlpRequired, rulesHash: null },
    features: [...(route.caps.hopFeatures ?? [])],
    driver: facts.driver,
    upstreamAuth: facts.upstreamAuth ?? null,
    upstreamHeaders: { ...facts.upstreamHeaders },
    upstreamQuery: { ...facts.upstreamQuery },
    upstreamRooted: facts.upstreamRooted ?? false,
    manifest: facts.manifest ?? null,
    requestRules: facts.requestRules ?? null,
  };
  let handle: HopHostHandle;
  try {
    handle = await hops.handle();
    const reply = await registerTag(handle, spec, sessionKey?.value);
    const kind = reply.port === handle.gatewayPort ? 'gateway' : 'dlp';
    return {
      baseUrl: `http://127.0.0.1:${reply.port}`,
      key: reply.placeholder,
      pin: applyHopEnv(input.pin, { from: channel.dialect, keyRef: endpoint.keyRef }, reply),
      hops: [{ kind, port: reply.port }],
      handle,
      tag: spec.tag,
      ...(sessionKey ? { sessionKey } : {}),
    };
  } catch (error) {
    // Отказ регистрации назван хостом; обрыв связи — хост забыт, следующий сеанс поднимет его.
    if (!(error instanceof HopHostError)) hops.forget?.();
    return { refused: `hop: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Снять метку сеанса у звена; хост ушёл — метки нет вместе с ним, причина в заметку. */
export async function unlinkHop(
  linked: Pick<HopLinked, 'handle' | 'tag'>,
  note: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  await unregisterTag(linked.handle, linked.tag).catch((error: unknown) =>
    note('hop.unregister.failed', {
      tag: linked.tag,
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
}
