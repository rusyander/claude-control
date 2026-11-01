import type { KeyRef, RouteEndpoint, RouteLease } from '@agentdeck/contracts/core/routes';
import type { NetFetch } from '../../platform/net/net.types.ts';

/** Вид API своего адреса — словарь профиля панели (`EndpointApiKind` контрактов). */
export type ApiKeyKind = 'anthropic' | 'google' | 'openai-compat';

/**
 * Как ключ доходит до запроса: `panel-store` — пускатель кладёт его в окружение сессии (CLI без
 * канала звена, названный остаток 11:71); `hop-injected` — звено подставляет ключ само, в сессии
 * только заглушка (11 §Policy, G5).
 */
export type KeyChannel = 'panel-store' | 'hop-injected';

/** Профиль маршрута ключа API: адрес вендора (из фактов запуска CLI) или свой адрес панели. */
export interface ApiKeyProfile {
  /** `api-key:<vendor>` или `api-key:endpoint:<profileId>`. */
  routeId: string;
  baseUrl: string;
  apiKind: ApiKeyKind;
  /** Имя в хранилище ключей панели: id провайдера или `endpoint:<profileId>`. */
  storeId: string;
  /** Модель, объявленная профилем ('' — не объявлена). */
  model?: string;
  /** Корень доверия компании; пусто — системный. */
  caCertPath?: string;
  /** Предел расхода человека на этом ключе, USD: есть — вид предела `budget`. */
  userCapUsd?: number;
  keyChannel: KeyChannel;
  /** Без интернета (свой адрес на этой машине). Нет — по хосту адреса. */
  offline?: boolean;
}

/** Запрос каталога С КЛЮЧОМ: ключ подставляет звено по `keyRef`, ядро значения не видит. */
export interface KeyedProbeRequest {
  routeId: string;
  url: string;
  keyRef: KeyRef;
  /** Куда звену положить ключ: заголовок (имя + слово перед ключом) или параметр адреса. */
  auth: { header: string; scheme: string } | { query: string };
  /** Прочие заголовки запроса (без ключа). */
  headers: Record<string, string>;
}

export interface KeyedProbeReply {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * Порт чтения с ключом (W/H проводят его через управляющий запрос звена `probe`). Нет порта —
 * чтение каталога с ключом невозможно, и факт честно `unknown` с этой причиной.
 */
export type KeyedProbe = (request: KeyedProbeRequest) => Promise<KeyedProbeReply>;

/** Состояние ключа у звена: исчерпание (402) и пауза частоты (429) — факты звена (P122). */
export interface HopRouteStatus {
  /** Момент ответа 402, мс эпохи; снимает только человек (`clear-exhausted`). */
  exhaustedAt?: number;
}

export interface ApiKeyRouteOptions {
  profile: ApiKeyProfile;
  /** СТРОГОЕ наличие ключа (`@agentdeck/keys` `readKeyPresence`): бросок — `unknown`, не «нет». */
  credentialPresent: (storeId: string) => boolean | Promise<boolean>;
  /** Сеть без ключа; по умолчанию — свой корень доверия профиля и прокси окружения. */
  fetch?: NetFetch;
  keyedProbe?: KeyedProbe;
  hopStatus?: () => Promise<HopRouteStatus>;
  /** Есть ли у модели цена в таблице (`packages/pricing`, зона L); нет порта — цена `unknown`. */
  priceKnown?: (model: string) => boolean | Promise<boolean>;
  /** Метка сеанса у звена для `hop-injected`; нет — id маршрута. */
  hopTag?: string;
  /** Срок пробы, мс: меньше срока класса чтения, чтобы причина была «timeout», а не общий срок. */
  probeTimeoutMs?: number;
  /** Адрес аренды через звено (G4: ключ подставляет звено); нет — прямой адрес профиля. */
  hopEndpoint?: (lease: RouteLease) => Promise<RouteEndpoint | null>;
}

/** Итог пробы без ключа. Всё прочее — бросок с причиной (факт `unknown`, P111). */
export type ProbeOutcome =
  | { kind: 'catalog'; status: number; payload: unknown }
  /** 401/403 без ключа: адрес жив и это модельный API, каталог закрыт ключом. */
  | { kind: 'locked'; status: number };
