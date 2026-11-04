import type { ServerContext } from '../../context.ts';
import { createCoreDlpProxy, type DlpProxy } from '../../domains/dlp/dlp.ts';
import { join } from 'node:path';
import {
  BUDGET_RELAY_FILE,
  createBudgetRelay,
  createContourPush,
  createCoreContours,
  type BudgetRelay,
  type ContourPush,
  type CoreContours,
  type CoreContoursOptions,
} from '../../domains/platform/contours/index.ts';
import {
  adoptUserGatewayPort,
  createCoreGatewayView,
  type CoreGatewayView,
} from '../../domains/platform/gateway-view/gateway-view.ts';
import type { PlatformRoutingDeps } from '../../domains/platform/routing/routing.ts';
import { createRightsFeed } from '../../domains/platform/watch/rights-feed.ts';
import { PlatformWatch } from '../../domains/platform/watch/watch.ts';
import { panelHomeDir } from '../../lib/brand.mjs';
import { coreHomeOf } from '../../lib/hop-recorder.mjs';
import { registerDlpRoutes } from '../../routes/dlp-routes/dlp-routes.ts';
import { registerPlatformRoutes } from '../../routes/platform-routes/platform-routes.ts';
import type { RouteRegistrar } from '../../routes/register.ts';
import type { NotifyWiring } from './notify-wiring.ts';

/**
 * Проводка шлюза контуров и прокси защиты данных. Слушателей у панели нет (этап 10, C3c/C3d):
 * адрес CLI держит шлюз человека на хосте звеньев ядра (5179 по умолчанию), прокси защиты данных
 * — тот же хост. Панель видит шлюз через учёт контуров ядра (`CoreGatewayView`), публикует его
 * порт в своё состояние — профили CLI читают его оттуда — и ведёт прогоны CLI через него.
 */
export interface GatewayWiring {
  platformGateway: CoreGatewayView;
  /** Учёт контуров звена ядра (C3b): карточка шлюза, расход, бюджет — одна цифра на машину. */
  contours: CoreContours;
  /**
   * Правка контура — ядру сразу (s10 G7): после изменяющего запроса панель сверяет отпечаток
   * фактов контура и, если он сменился, ждёт, пока ядро применит его к шлюзу человека.
   */
  contourPush: ContourPush;
  /** Пороги бюджета из учёта звена — в Telegram и вебхук. */
  budgetRelay: BudgetRelay;
  /**
   * Основа маршрутизации контура: хранилище, каталог данных, порт шлюза. Полный набор
   * (`local-models-wiring.ts`) добавляет к ней лишь части Claude и локальных моделей — для
   * маршрута `foreign:<cli>` они ничего не решают.
   */
  platformRoutingBase: PlatformRoutingDeps;
  dlpProxy: DlpProxy;
  platformWatch: PlatformWatch;
}

export interface GatewaySeams {
  /**
   * Учёт контуров вместо клиента ядра — тесты собирают рантайм без ядра (`memoryContours`). Опрос
   * такого учёта рантайм не заводит: состояние задаёт тест.
   */
  contours?: CoreContours;
  /**
   * Сборщик учёта контуров (по умолчанию `createCoreContours`): тест видит, с какими слушателями
   * проводка собрала учёт, — выпавший `onEvents` оставил бы сторожа без отказов, пахнущих правами.
   */
  createContours?: (options: CoreContoursOptions) => CoreContours;
}

export function wireGateway(
  ctx: ServerContext,
  notify: Pick<NotifyWiring, 'telegram' | 'webhook'>,
  env: NodeJS.ProcessEnv = process.env,
  seams: GatewaySeams = {},
): GatewayWiring {
  // Шлюз контуров держит ядро (шлюз человека). Его порт приходит с опросом учёта контуров;
  // сменился — он уезжает в состояние панели, и управляемые профили пересобираются: адрес CLI
  // вписан в них. Прогоны CLI через контур спрашивают тот же порт — 0, пока ядро шлюз не
  // подняло (маршрут тогда отказывает словами `gateway_down`).
  const log = (line: string): void => void process.stderr.write(`${line}\n`);
  /**
   * Фоновая перепроверка активного контура (A-2).
   *
   * Заводится здесь, потому что живёт дольше запроса и гаснет вместе с панелью.
   * На пути запроса её нет ни в одном месте: ходит она своим таймером и по отказу, пахнущему
   * правами, — его панель узнаёт из опроса учёта контуров ядра (`createRightsFeed`), поэтому
   * сторож заводится раньше учёта.
   */
  const platformWatch = new PlatformWatch({
    store: ctx.store,
    appDataDir: ctx.location.paths.appData,
    onError: (error) =>
      process.stderr.write(
        `фоновая проба контура не удалась (${error instanceof Error ? error.message : String(error)})
`,
      ),
  });
  platformWatch.start();
  const contours =
    seams.contours ??
    (seams.createContours ?? createCoreContours)({
      home: () => coreHomeOf(env),
      log,
      onUserGatewayPort: (port) => adoptUserGatewayPort(ctx.store, port),
      onEvents: createRightsFeed({ note: (id) => platformWatch.noteRightsRefusal(id) }),
    });
  const platformGateway = createCoreGatewayView({
    store: ctx.store,
    appDataDir: ctx.location.paths.appData,
    contours,
  });
  const platformRoutingBase: PlatformRoutingDeps = {
    store: ctx.store,
    appDataDir: ctx.location.paths.appData,
    gatewayPort: () => contours.userGatewayPort(),
    contourSpend: () => contours.records(),
  };
  // Прокси защиты данных держит хост звеньев ядра (C3c); панель спрашивает его состояние и
  // просит применить тумблер сразу после записи.
  const dlpProxy = createCoreDlpProxy({
    home: () => coreHomeOf(env),
    settingsPort: () => ctx.store.getSettings().dlp.port,
  });
  /**
   * Порог бюджета контура — тем же слоем, что и концы прогонов (A-5).
   *
   * До этой строки порог считался и лежал в ответе, а читали его только карточка
   * контура и плитка «Обзор»: человек, работающий в чате, узнавал о лимите из
   * отказа 402. Push сюда НЕ входит намеренно — его тело открывает разговор, а у
   * бюджета разговора нет: он свойство контура, и тратят его все прогоны разом.
   */
  const budgetRelay = createBudgetRelay({
    contours,
    statePath: join(panelHomeDir(), BUDGET_RELAY_FILE),
    deliver: (notice) => {
      const outward = {
        kind: notice.level === 'over' ? ('budgetOver' as const) : ('budgetNear' as const),
        platformTitle: notice.platformTitle,
        share: notice.share,
      };
      notify.telegram(outward);
      notify.webhook(outward);
    },
    log,
  });
  // Тесты собирают рантайм без ядра: опрос там только шумел бы отказами связи, а подставной
  // учёт тест ведёт сам.
  if (!env.VITEST && !seams.contours) {
    contours.start();
    budgetRelay.start();
  }
  const contourPush = createContourPush({
    settings: () => ctx.store.getSettings(),
    apply: () => contours.apply(),
  });
  return {
    platformGateway,
    contours,
    contourPush,
    budgetRelay,
    platformRoutingBase,
    dlpProxy,
    platformWatch,
  };
}

export interface GatewayRouteDeps {
  dlpProxy: DlpProxy;
  platformGateway: CoreGatewayView;
  selfBaseUrl: string;
  claudeSettingsRoute: PlatformRoutingDeps['claudeSettingsRoute'];
  localMcpPicks: PlatformRoutingDeps['localMcpPicks'];
}

/** Маршруты зоны шлюза — таблица маршрутов вставляет их на прежнее место. */
export function gatewayRoutes(deps: GatewayRouteDeps): RouteRegistrar[] {
  return [
    (instance, context) => registerDlpRoutes(instance, context, deps.dlpProxy),
    // Контуры: список, настройка, ключ и проба по кнопке. Сам поход в контур
    // случается по нажатию, а не по расписанию. Адрес панели нужен по той же
    // причине, что и интеграциям: переходник MCP ходит не в контур, а сюда, и в
    // его записи лежит только этот адрес.
    (instance, context) =>
      registerPlatformRoutes(
        instance,
        context,
        deps.platformGateway,
        deps.selfBaseUrl,
        deps.claudeSettingsRoute,
        deps.localMcpPicks,
      ),
  ];
}
