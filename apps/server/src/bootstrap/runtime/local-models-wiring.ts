import type { PlatformGatewayEvent } from '@agentdeck/contracts';
import type { ServerContext } from '../../context.ts';
import { readEnvLookup } from '../../domains/env/env.ts';
import { CLAUDE_SWITCH_SETTING } from '../../domains/local-models/claude-switch.ts';
import { LOCAL_PLATFORM_ID } from '../../domains/local-models/connect.ts';
import { createCoreHold } from '../../domains/local-models/core-hold.ts';
import { LOCAL_FRONT_PORT, localFrontPortOf } from '@agentdeck/contracts/core/local-hold';
import { coreHomeOf } from '../../lib/hop-recorder.mjs';
import { runLocalFullLayer } from '../../domains/local-models/full-layer.ts';
import { createLocalMcpSource } from '../../domains/local-models/mcp-source.ts';
import { createRunSync } from '../../domains/local-models/run-sync.ts';
import { createLocalModels, type LocalModels } from '../../domains/local-models/service.ts';
import type { PlatformRoutingDeps } from '../../domains/platform/routing/routing.ts';
import { appRootDir } from '../../lib/app-root/app-root.ts';
import { createKeepAwake, type KeepAwake } from '../../lib/keep-awake/keep-awake.ts';
import { registerLocalModelsRoutes } from '../../routes/local-models-routes/local-models-routes.ts';
import { registerPowerRoutes } from '../../routes/power-routes.ts';
import type { RouteRegistrar } from '../../routes/register.ts';
import type { KitService } from '../../domains/kit/service.ts';

/** Как часто смотрим, идёт ли локальный прогон: запрет сна и отложенный перезапуск. */
const LOCAL_RUN_POLL_MS = 5_000;

/**
 * Проводка локальных моделей (этап 10, зона C): библиотека (скачивание, каталог, свои модели,
 * удаление) остаётся в панели, а сервер моделей — удержание в ядре (`core-hold.ts`): слот карты
 * общий с задачами ядра, постоянный порт 11435 слушает ядро.
 */
export interface LocalModelsWiring {
  keepAwake: KeepAwake;
  /** MCP локального прогона — его же читает профиль группы разделения. */
  mcpSource: ReturnType<typeof createLocalMcpSource>;
  localModels: LocalModels;
  /** Полная маршрутизация контура: основа шлюза + части Claude и локальных моделей. */
  platformRouting: PlatformRoutingDeps;
  /** Погасить загрузки, опрос прогона и запрет сна; сервер моделей живёт дальше. */
  stop(): void;
}

export interface LocalModelsWiringDeps {
  localRunActive: () => boolean;
  platformRoutingBase: PlatformRoutingDeps;
  /** События книги контуров ядра — по ним чат видит отказ сервера моделей (L6). */
  coreEvents: () => readonly PlatformGatewayEvent[] | undefined;
}

export function wireLocalModels(
  ctx: ServerContext,
  deps: LocalModelsWiringDeps,
): LocalModelsWiring {
  /**
   * Маршрут контура для прогонов Claude (Т3): реестр спрашивает по
   * происхождению прогона, домен отвечает окружением. Порт берётся у ЖИВОГО
   * слушателя — записанный в состоянии остался бы от прошлого запуска, и
   * прогон ушёл бы тому процессу, который занял порт после панели.
   */
  // Корень приложения, а не каталог настроек: гигабайты моделей человек видит
  // рядом с панелью и удаляет вместе с ней (решение владельца 05.10).
  // Пока идёт локальный прогон, система не засыпает (L4b); выключатель — в настройках раздела.
  const keepAwake = createKeepAwake({ log: (message, error) => console.warn(message, error) });
  // Локальный контур, заведённый до 15.10 с облегчённым набором, которого человек не
  // выбирал, — на полный набор, один раз (L6). Сбой переноса старт не роняет.
  try {
    runLocalFullLayer(ctx.store, ctx.location.paths.appData, (outcome) => {
      if (outcome === 'migrated')
        console.log('[local-models] local contour moved to the full layer');
    });
  } catch (error) {
    console.warn('[local-models] full-layer migration failed:', error);
  }
  const mcpSource = createLocalMcpSource({
    userConfig: () => ctx.location.paths.mcpConfig,
    userSettings: () => ctx.location.paths.settings,
    store: ctx.store,
    appData: () => ctx.location.paths.appData,
    envLookup: () => ({
      ...process.env,
      ...readEnvLookup(
        ctx.location.paths.settings,
        ctx.location.paths.secretsEnv,
        ctx.location.paths.settingsLocal,
      ),
    }),
    networkTimeoutMs: () => ctx.store.getSettings().mcpNetworkTimeoutMs,
  });
  const localModels = createLocalModels({
    appRoot: appRootDir(),
    // Свой сервер моделей панель не поднимает: «Запустить»/«Остановить» — удержание в ядре,
    // постоянный порт слушает ядро (этап 10, зона C).
    hold: createCoreHold(() => coreHomeOf(process.env)),
    // Тот же порт, что слушает ядро (`AGENTDECK_LOCAL_FRONT_PORT` стенда): проба здоровья и
    // переключатель Claude смотрят туда же. Адрес выключен (`0`) — порт продукта: проба честно
    // не дождётся ответа и назовёт порт.
    port: localFrontPortOf(process.env) ?? LOCAL_FRONT_PORT,
    runActive: deps.localRunActive,
    awakeHeld: () => keepAwake.status().held,
    claude: { settingsPath: () => ctx.location.paths.settings, backupDir: () => ctx.backupDir },
    // MCP-серверы локального прогона читаются теми же файлами и тем же клиентом, что раздел «MCP».
    mcp: mcpSource,
    coreEvents: deps.coreEvents,
  });
  // Раз в несколько секунд: запрет сна держится, пока идёт локальный прогон, а ждавший
  // перезапуск сервера выполняется, когда прогонов не осталось. Опрос, а не слушатели на
  // каждый путь завершения (конец, стоп, обрыв, усыновление): пути разные, итог один.
  const syncLocalRun = createRunSync({
    active: deps.localRunActive,
    keepAwakeOn: () => localModels.keepAwakeOn(),
    awake: keepAwake,
    restart: {
      pending: () => localModels.restartPending(),
      apply: () => localModels.applyPending(),
    },
    log: (message, error) => console.warn(message, error),
  });
  const localRunTimer = setInterval(syncLocalRun, LOCAL_RUN_POLL_MS);
  localRunTimer.unref();
  // Включённому «Claude на локальной модели» нужен живой сервер с первого сеанса.
  void localModels.resume().catch((error: unknown) => {
    console.warn('local models: server for the Claude switch did not start', error);
  });
  const platformRouting: PlatformRoutingDeps = {
    ...deps.platformRoutingBase,
    claudeSettingsRoute: () => {
      const model = localModels.claudeModel();
      return model
        ? { setting: CLAUDE_SWITCH_SETTING, platformId: LOCAL_PLATFORM_ID, ...model }
        : undefined;
    },
    localRunEnv: (platformId, route) =>
      platformId === LOCAL_PLATFORM_ID ? localModels.runEnv(route) : undefined,
    localMcpPicks: (platformId, project) =>
      platformId === LOCAL_PLATFORM_ID ? localModels.mcpInfo(project).picked : undefined,
  };
  return {
    keepAwake,
    mcpSource,
    localModels,
    platformRouting,
    stop: () => {
      // Загрузки обрываются (докачаются с места); удержание модели — в ядре, оно живёт дальше.
      localModels.shutdown();
      clearInterval(localRunTimer);
      keepAwake.stop();
    },
  };
}

export interface LocalModelsRouteDeps {
  localModels: LocalModels;
  kit: KitService;
  keepAwake: KeepAwake;
}

/** Маршруты зоны локальных моделей — таблица маршрутов вставляет их на прежнее место. */
export function localModelsRoutes(deps: LocalModelsRouteDeps): RouteRegistrar[] {
  return [
    // Локальные модели: работы с прогрессом переживают запрос, объект — из runtime.
    (instance, context) => registerLocalModelsRoutes(instance, context, deps.localModels, deps.kit),
    // Гибернация и сон машины с телефона; запрет на сон от локального прогона снимается перед сном.
    (instance) =>
      registerPowerRoutes(instance, {
        awake: {
          held: () => deps.keepAwake.status().held,
          release: () => deps.keepAwake.stop(),
        },
      }),
  ];
}
