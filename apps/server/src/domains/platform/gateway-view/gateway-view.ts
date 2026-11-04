import type { Platform, PlatformGatewayRoute, PlatformGatewayStatus } from '@agentdeck/contracts';
import type { CompromiseId } from '@agentdeck/contracts/compromises';
import { GATEWAY_ROUTES } from '@agentdeck/contracts/platform-gateway-routes';
import type { AppStore } from '../../../lib/app-store/app-store.ts';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import { reconcileManagedProfiles } from '../apply/profile.ts';
import type { CoreContours } from '../contours/index.ts';
import { driverOf } from '../drivers/index.ts';
import type { PlatformDriver } from '../drivers/driver.ts';
import { effectivePlatform } from '../rules-apply/rules-apply.ts';
import { readPlatforms, readToken } from '../store/store.ts';
import { toolShimReport } from '../tool-shim-report/tool-shim-report.ts';
import { violationReport } from '../violations/violations.ts';

/**
 * Шлюз контуров глазами панели (этап 10, C3b). Слушателя у панели нет: адрес CLI
 * `127.0.0.1:<порт>/<контур>/v1` держит шлюз человека на хосте звеньев ядра (5179 по умолчанию,
 * `AGENTDECK_USER_GATEWAY_PORT`), учёт запросов — его же книга контуров. Здесь — карточка шлюза
 * в прежней форме `PlatformGatewayStatus` из последнего ответа ядра и просьба «поднять»: поднимает
 * ядро само, панель только спрашивает его свежим.
 */

/** Ядро ещё не ответило — порт, который оно возьмёт по умолчанию. */
const DEFAULT_PORT = 5179;

const GATEWAY_COMPROMISES: CompromiseId[] = [
  'dialect-bridge',
  'vendor-sse-frames',
  'status-451-bridge',
  // compromise: gateway-required — CLI ходят в шлюз ядра, а не в контур: ядро не поднято — модели у них нет
  'gateway-required',
  'nonstream-120s',
  'context-managed',
  // Цена прослойки инструментов: правила и схемы едут в КАЖДОМ ходе, кэша промпта у платформы
  // нет. Значка на экране у этой подписи нет — платит за неё шлюз, а не элемент интерфейса.
  'shim-no-cache',
];

/**
 * Родная ручка Anthropic у платформы: тогда шлюз ядра не переводит диалект, и подпись моста
 * была бы неправдой. Прослойка инструментов без своих инструментов платформы ведёт мостом.
 */
function nativeMessagesPath(
  platform: Pick<Platform, 'toolShim' | 'rules'>,
  driver: Pick<PlatformDriver, 'anthropic'>,
): string | undefined {
  if (!driver.anthropic) return undefined;
  const shim = platform.toolShim && platform.rules.platform.platformTools.length === 0;
  return shim ? undefined : driver.anthropic.messages;
}

/**
 * Шлюз человека у ядра слушает на \`port\`: порт уходит в состояние панели (\`platformGatewayPort\`
 * — его читает \`activeGatewaySettings\`), и управляемые профили пересобираются — адрес CLI вписан
 * в них. Тот же порт — ничего не пишется; 0 (ядро молчит) — тоже: CLI держат прошлый адрес.
 */
export function adoptUserGatewayPort(store: AppStore, port: number): void {
  if (port <= 0 || store.getState().platformGatewayPort === port) return;
  store.setPlatformGatewayPort(port);
  reconcileManagedProfiles(store);
}

export interface CoreGatewayViewDeps {
  store: AppStore;
  appDataDir: string;
  contours: CoreContours;
}

export interface CoreGatewayView {
  readonly contours: CoreContours;
  /** Шлюз человека у ядра слушает. */
  readonly running: boolean;
  status(): PlatformGatewayStatus;
  /**
   * Спросить ядро свежим и убедиться, что шлюз слушает. Не слушает — исключение со словами
   * ядра (ждёт порт, причина), их увидит человек на карточке и в активации.
   */
  ensure(): Promise<void>;
}

export function createCoreGatewayView(deps: CoreGatewayViewDeps): CoreGatewayView {
  const { store, appDataDir, contours } = deps;
  const enabled = (): Platform[] => readPlatforms(store).filter((platform) => platform.enabled);

  const compromises = (): CompromiseId[] => {
    const on = enabled();
    // Ни одного включённого — подпись остаётся: так шлюз говорит, чем станет, а не молчит.
    // Действующие правила, как у конвейера: записанные инструменты платформы при «только
    // наших правилах» не действуют, и прослойка ведёт мостом (F-272).
    const bridged =
      on.length === 0 ||
      on.some((platform) => !nativeMessagesPath(effectivePlatform(platform), driverOf(platform)));
    return bridged
      ? GATEWAY_COMPROMISES
      : GATEWAY_COMPROMISES.filter((id) => id !== 'dialect-bridge');
  };

  const routes = (port: number): PlatformGatewayRoute[] =>
    port <= 0
      ? []
      : readPlatforms(store).map((platform) => ({
          platformId: platform.id,
          title: platform.title,
          address: `http://127.0.0.1:${port}/${platform.id}/v1`,
          paths: [...GATEWAY_ROUTES],
          ready: platform.enabled && Boolean(readToken(appDataDir, platform.id)),
        }));

  const waitingReason = (): string | undefined => {
    const state = contours.userGateway();
    if (!state) return serverText('gateway-core-unknown');
    if (state.state === 'listening') return undefined;
    return serverText('gateway-core-waiting', {
      port: state.port,
      reason: state.lastError ?? serverText('gateway-ports-busy-unknown'),
    });
  };

  return {
    contours,
    get running() {
      return contours.userGatewayPort() > 0;
    },
    status() {
      const live = contours.live();
      const events = live?.events ?? [];
      const port = contours.userGatewayPort();
      const ids = enabled().map((platform) => platform.id);
      const error = waitingReason();
      return {
        running: port > 0,
        address: port > 0 ? `http://127.0.0.1:${port}` : '',
        port,
        requestedPort: contours.userGateway()?.port ?? DEFAULT_PORT,
        ...(error ? { error } : {}),
        requests: live?.requests ?? 0,
        failures: live?.failures ?? 0,
        routes: routes(port),
        usage: live?.usage ?? [],
        events,
        // Сводка проверок — только по ВКЛЮЧЁННЫМ контурам: след выключенного читался бы как
        // след того, на который человек смотрит.
        violations: violationReport(events, { platformIds: ids }),
        toolShim: toolShimReport(events, { platformIds: ids }),
        summarized: live?.summarized ?? { total: 0, recent: [] },
        compromises: compromises(),
      };
    },
    async ensure() {
      // Сначала ядро применяет то, что уже записано: активация включает контур в state.json и
      // в том же запросе шлёт пробный запрос в шлюз, а хук `onSend` донёс бы включение только
      // после ответа — шлюз отвечал «Контур выключен в панели» (съёмка 03.11, s10 G7).
      await contours.apply();
      await contours.refresh();
      const reason = waitingReason();
      if (reason) throw new Error(reason);
    },
  };
}
