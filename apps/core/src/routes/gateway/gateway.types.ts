import type { Platform } from '@agentdeck/contracts/platform';
import type { RouteEndpoint, RouteLease } from '@agentdeck/contracts/core/routes';
import type { NetFetch } from '../../platform/net/net.types.ts';
import type { HopRouteStatus, KeyedProbe } from '../api-key/api-key.types.ts';

/**
 * Контур, как его видит маршрут шлюза: определение из хранилища панели (только чтение), без
 * ключа — ключ лежит в хранилище ключей под `platform:<id>`, и подставляет его звено.
 */
export type GatewayProfile = Pick<
  Platform,
  | 'id'
  | 'title'
  | 'driver'
  | 'baseUrl'
  | 'enabled'
  | 'mode'
  | 'budgetUsd'
  | 'defaultModel'
  | 'consumerModels'
  | 'modelMap'
  | 'caCertPath'
  | 'transport'
> &
  /**
   * Манифест карточки и прослойка инструментов — вход выбора «родная ручка Anthropic или мост»
   * (`contourUpstreamDialect`) и переопределений драйвера звена. Нет — как у пресета, без прослойки.
   */
  Partial<Pick<Platform, 'manifest' | 'toolShim' | 'rules'>>;

export interface GatewayRouteOptions {
  profile: GatewayProfile;
  /** СТРОГОЕ наличие ключа контура (`platform:<id>`); бросок — `unknown`. */
  credentialPresent: (storeId: string) => boolean | Promise<boolean>;
  fetch?: NetFetch;
  keyedProbe?: KeyedProbe;
  /** Исчерпание бюджета контура (402) — факт звена (H); снимает только `clear-exhausted`. */
  hopStatus?: () => Promise<HopRouteStatus>;
  /** Адрес аренды — порт звена шлюза (H, `routes/hops`); нет — адреса нет, решение в журнал. */
  hopEndpoint?: (lease: RouteLease) => Promise<RouteEndpoint | null>;
  probeTimeoutMs?: number;
}
