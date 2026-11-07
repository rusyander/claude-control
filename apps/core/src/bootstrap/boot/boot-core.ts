import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createAdapterRegistry } from '../../adapters/index.ts';
import type { ContourPolicy } from '../../policy/resolve/resolve.types.ts';
import { createSessionTokens } from '../../policy/session-tokens/session-tokens.ts';
import type {
  PublisherCommandPort,
  SetRoutePorts,
} from '../../conductor/commands/commands.types.ts';
import { createAskBridgeBook, createAskTask, replayAsk } from '../../conductor/ask/index.ts';
import { createTaskEnvBook } from '../../conductor/task-env/index.ts';
import { failHalfMadeAnswers, type SplitEnv } from '../../conductor/estimate/index.ts';
import { createTaskRegistry, type TaskRegistry } from '../../conductor/tasks.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { createClock, REAL_CLOCK, type CoreClock } from '../../platform/clock.ts';
import { ensureCoreHome } from '../../platform/core-home.ts';
import { LOOPBACK, listenOnAllocatedPort, type PortDecision } from '../../platform/ports.ts';
import { createLivenessProbe, identityOfPid } from '../../platform/process-identity.ts';
import { registerCore, unregisterCore } from '../../platform/procs-file.ts';
import { ensureTokenFile } from '../../platform/token-file.ts';
import { hopControl } from '../../routes/hops/hops.ts';
import type { RouteRegistry } from '../../routes/registry.ts';
import { actionReaders } from '../action-readers.ts';
import { buildCoreApi } from '../boot-api.ts';
import { createContoursPort } from '../contours-port.ts';
import { cliPathOf } from '../cli-paths.ts';
import { startConductor } from '../conductor-wiring/index.ts';
import type { ReviewLinkWiring } from '../review-link-wiring/index.ts';
import { createBootReconcile, RECONCILE_EVERY_MS } from '../boot-reconcile.ts';
import {
  buildLiveCoreRoutes,
  readRouteConfig,
  refreshRoutesNoted,
  type LiveCoreRoutes,
} from '../core-routes.ts';
import { panelWiring } from '../panel-wiring.ts';
import { shutdownRoutes } from '../route-shutdown.ts';
import { dlpSecretMask } from '../secret-mask.ts';
import { createSessionRoad, memoLoginPath, type SessionRoad } from '../session-road.ts';
import { createConfigPort, type CoreConfigWiring } from '../core-config/port.ts';
import { createSessionStatePort, launchSnapshot, libraryScenarioOf } from '../session-state.ts';
import { createUserLayerTap } from '../user-layer-wiring/tap.ts';
import { liveCopiesOf } from '../session-road/protected-step.ts';
import { baseAtStart, createCliVersionReader } from '../economy-wiring/base-start.ts';
import { bootEconomy } from '../economy-wiring/boot-economy.ts';
import { createContextWiring } from '../economy-wiring/context.ts';
import { createEconomyWiring } from '../economy-wiring/index.ts';
import { learnedPortOf } from '../economy-wiring/learned-port.ts';
import { createPollWiring } from '../forge-wiring/poll-wiring.ts';
import { createAgentsWiring } from '../agents-wiring/index.ts';
import { createAllocatorWiring } from '../allocator-wiring/index.ts';
import { createObserverWiring } from '../observer-wiring/index.ts';
import { processPin } from '../conductor-wiring/session-start.ts';
import { createRouteWindows } from '../route-windows.ts';
import { createSessionRuntime, type SessionRuntime } from '../session-runtime.ts';
import type { LearnedTable } from '../../economy/learned/index.ts';
import { createSessionKeyBook } from '../session-keys.ts';
import { buildVerifierWiring } from '../verifier-wiring/index.ts';
import type { BootedCore, BootOptions } from './boot.types.ts';
import { openCoreLog, routeJournalOf } from './core-log.ts';
import { startLocalFront, type LocalFront } from '../../routes/local/own/front.ts';
import { createLocalHold } from '../../routes/local/own/hold.ts';
import { createSlotCache } from '../../platform/slot-cache.ts';
import { takeHomeLock, type HomeLock } from './home-lock.ts';
import { reasonOf, releaseAll } from './release.ts';
import { startBackups, startClockJumps } from './timers.ts';
import { supervisorWiring } from '../supervisor-wiring.ts';
import { checkOpenFiles } from './open-files.ts';
import { openFilesLimit } from '../../platform/limits.ts';
import { startDlpProxyWiring, type DlpProxyWiring } from '../dlp-proxy-wiring.ts';
import { readPanelListenerSettings } from '../panel-profiles.ts';
import { forgeHostsOfPanel, forgeOfPanel } from '../panel-forge.ts';
import {
  panelGatewayPort,
  startUserGatewayWiring,
  type UserGatewayWiring,
} from '../user-gateway-wiring.ts';

/**
 * Загрузка ядра (00 §Processes, 07 фаза 2): дом → токен → своя личность (pid + старт от ОС) →
 * незаконченные задачи через один `resume()` → сверка начатых действий и сессий (по задаче:
 * одна сбойная задача отделяется, загрузка идёт — ревью F-49) → API на 127.0.0.1 вне 5170–5180
 * → строка в `procs.json` → резервная копия дня → тики часов. Сбой загрузки после первых
 * ресурсов откатывает их (аренды, маршруты, порт). Всё решённое — в `logs/core.jsonl`.
 */
export async function bootCore(options: BootOptions = {}): Promise<BootedCore> {
  const self = await (options.identity ?? identityOfPid)(process.pid);
  if (!('value' in self)) {
    // Без своей личности аренду не доказать: другое ядро сочтёт её мёртвой. Отказ, а не догадка —
    // и до первого побочного действия: ни дома, ни журнала, ни токена, ни строки в procs.json.
    const why = 'unknown' in self ? self.unknown : 'own pid not in the process table';
    throw new Error(`core identity unknown: ${why}`);
  }
  const layout = ensureCoreHome(options.home);
  const log = openCoreLog(layout);
  const note = log.note;
  // Явный путь CLI (`cliPaths`, F9): сессии и предпроверка дороги читают его при каждом запуске.
  const adapters = options.adapters ?? createAdapterRegistry({}, { cliPathOf: cliPathOf(layout) });
  // `bootId` — до маршрутов: он владеет местами ждущих своей модели (11 R:PR-04). Часы с базой
  // тиков создаются позже, перед самими тиками (ревью F-50); до них журнал штампует теми же
  // часами без базы — штамп от базы не зависит.
  const bootId = newId();
  const probe = createLivenessProbe();
  const build = options.build ?? process.env.AGENTDECK_CORE_BUILD ?? 'dev';
  // Одно ядро на дом — до маршрутов, профилей панели и хоста звеньев: второе ядро уходит, не
  // тронув ничего общего (журнал ядра пишет только строку отказа).
  let homeLock: HomeLock;
  try {
    homeLock = await takeHomeLock(
      layout.lock,
      layout.root,
      {
        leaseId: newId(),
        pid: process.pid,
        pidStart: self.value.start,
        bootId,
        build,
        acquiredAt: Date.now(),
      },
      (id) => probe.isAlive(id),
    );
  } catch (error) {
    note('boot.refused', { reason: reasonOf(error) });
    log.close();
    throw error;
  }
  const stamps = createClock(REAL_CLOCK, bootId);
  const routeJournal = routeJournalOf(note);
  // Профили панели и хост звеньев (W2b): маршруты ключа API и контуров, звено дороги сессии.
  const panel = panelWiring(layout, { panelAppData: options.panelAppData, bootId }, note);
  let routes: RouteRegistry;
  // Пересборка маршрутов панели (s10 G7): есть только у собранного здесь реестра, не у подставленного.
  let refreshPanelRoutes: LiveCoreRoutes['refreshPanel'] | undefined;
  try {
    if (options.routes) routes = options.routes;
    else {
      const live = buildLiveCoreRoutes(
        adapters,
        layout,
        options.routeConfig ?? readRouteConfig(layout),
        { bootId, journal: routeJournal },
        panel.sources,
      );
      routes = live.registry;
      refreshPanelRoutes = live.refreshPanel;
    }
  } catch (error) {
    // Настройка маршрутов не той формы — отказ до аренды задач, порта и строки в procs.json.
    note('boot.refused', { reason: reasonOf(error) });
    homeLock.release();
    log.close();
    throw error;
  }
  // Распределитель мест сеансов (этап 11): его проводка даёт книгу окон и порт `/v1/allocator`;
  // реестр задач собирается ниже — проводка читает его через ячейку.
  const registryCell: { current?: TaskRegistry } = {};
  const allocator = createAllocatorWiring({
    layout,
    note,
    registry: () => registryCell.current,
    routes: () => routes,
  });
  // Книга окон одна на ядро (G7): проводка экономики пишет в неё факты потока, health читает.
  const windows = allocator.windowBook();
  // Проводка контекста одна: кран сверяет первый ход с ожиданием, которое ставит исполнитель.
  const context = createContextWiring({ homeRoot: layout.root });
  // Дорога сессии собирается позже (ей нужен порт API); кран слоя спрашивает её опись через ячейку.
  let roadCell: SessionRoad | undefined;
  // Наблюдатель (этап 8): тикающие часы (`startClockJumps`) появляются в конце загрузки, до них
  // время — часы загрузки (R9: `stamps` не тикают, сон машины в них не вычтен).
  let tickingClock: CoreClock | undefined;
  const activeMono = (): number => (options.observer?.clock ?? tickingClock ?? stamps).activeMono();
  // Окно маршрута × модели — одна книга на ядро: рост контекста наблюдателя и правило 60 %.
  const routeWindows = createRouteWindows({
    routeOf: (id) => routes.get(id),
    now: activeMono,
    note,
  });
  // Рантайм сессий и экономика собираются позже — наблюдатель читает их через ячейки.
  const cells: { sessions?: SessionRuntime } = {};
  let learnedCell: (() => LearnedTable | null) | undefined;
  const observer = createObserverWiring({
    note,
    now: activeMono,
    options: options.observer,
    windowOf: (routeId, model) => routeWindows.windowOf(routeId, model),
    sessionOf: (task, binding) => {
      const permit = cells.sessions?.permitDeps(task, binding);
      return permit && { mapPermission: permit.mapPermission, cwd: permit.context.copyRoot };
    },
    toolP95: () => learnedCell?.()?.toolMsP95 ?? null,
    permitPending: (sessionId) => cells.sessions?.permitPending(sessionId) ?? false,
  });
  const sessions = createSessionRuntime({
    settleMs: options.permitSettleMs,
    note,
    economy: createEconomyWiring({ note, windows, context }),
    userLayer: createUserLayerTap({
      inventoryOf: (_task, binding) => roadCell?.layerInventory(binding.sessionId) ?? null,
    }),
    observer: observer.tap,
  });
  cells.sessions = sessions;
  const me = { build, pid: process.pid, pidStart: self.value.start, bootId };
  const startedAt = Date.now();
  const registry = createTaskRegistry(
    layout.tasks,
    {
      me,
      clock: stamps,
      mask: dlpSecretMask,
      isAlive: (id) => probe.isAlive(id),
      now: Date.now,
      onLeaseLost: (taskId) => note('lease.lost', { taskId }),
      // Отвергнутая писателем строка — сигнал `journal-rejected` наблюдателя (этап 8, F11).
      onRejected: (taskId, rejection) => observer.rejected(taskId, rejection),
    },
    // Каждая задача, ставшая живой (открыта на загрузке, создана, открыта заново), — под наблюдателем.
    { onLive: (task) => observer.attach(task) },
  );
  registryCell.current = registry;
  // История агентов (этап 11): свёртка журнала задач для `/v1/*agents*`; маска — та же, что у журнала.
  const agents = createAgentsWiring({
    layout,
    registry,
    mask: dlpSecretMask,
    note,
    // Сторож фона (P148): та же проба жизни, что у задач; тишина вывода — по активному времени.
    liveness: probe,
    now: activeMono,
    ...options.agents,
  });
  const lockHolder = { leaseId: newId(), ...me, acquiredAt: Date.now() };
  const procsDeps = {
    isAlive: (id: { pid: number; start: string }) => probe.isAlive(id),
    me: lockHolder,
  };
  // Доверенные звенья (P131): набор живёт с начала загрузки — API судит пира по нему.
  const supervisor = supervisorWiring({
    layout,
    bootId,
    registry,
    isAlive: (id) => probe.isAlive(id),
    note,
  });

  // Всё, что загрузка уже взяла: при сбое дальше — откат, чтобы аренды, удары, маршруты и порт
  // не пережили неудачную загрузку (ревью F-49).
  let app: FastifyInstance | undefined;
  let registered = false;
  let stopReconcile: (() => Promise<void>) | undefined;
  let stopConductor: (() => Promise<void>) | undefined;
  // Среда деления дирижёра для API: API собран раньше дирижёра (мосту сессии нужен его порт),
  // поэтому ячейка — заполняется после `startConductor`, очищается на его остановке; пустая —
  // оценка и запуск отказывают «не подключено».
  let splitEnv: SplitEnv | undefined;
  // Порт публикатора для `publish-now` / `clean-remote` — та же ячейка, тот же срок жизни.
  let publisher: PublisherCommandPort | undefined;
  // Проводка ревью MR по ссылке (этап 10, F8) — та же ячейка, тот же срок жизни.
  let reviewLink: ReviewLinkWiring | undefined;
  // Токены моста панели вопросов «ask» (этап 10, F2): только память, одна книга на загрузку.
  const askBridges = createAskBridgeBook();
  // Значения окружения задач (этап 10, F6): каталог песочницы, секреты стенда — только память.
  const taskEnv = createTaskEnvBook();
  // Порт настройки ядра (этап 7): один на загрузку, снимает подписку на дрейф при остановке.
  let configWiring: CoreConfigWiring | undefined;
  // Постоянный адрес своей модели (этап 10): порт уходит с ядром, удержание — нет.
  let localFront: LocalFront | undefined;
  // Шлюз человека (этап 10): настройку держит ядро, сам шлюз живёт на хосте звеньев.
  let userGateway: UserGatewayWiring | undefined;
  let dlpProxy: DlpProxyWiring | undefined;
  try {
    note('routes', { ids: routes.list().map((route) => route.id) });
    const token = ensureTokenFile(layout.token);
    const opened = await registry.openUnfinished();
    note('tasks.opened', { opened: opened.opened.length, refused: opened.refused });
    // Задача ответов, недоделанная крахом, держала бы MR вечно: кончается до сверки и опроса.
    const halfMade = failHalfMadeAnswers(registry, opened.opened);
    if (halfMade.length > 0) note('tasks.half-made-answers', { failed: halfMade });

    const reconcile = createBootReconcile({
      registry,
      readers:
        options.readers ??
        actionReaders({ forgeFor: (url) => forgeOfPanel(panel.appData)(url).port }),
      isAlive: (id) => probe.isAlive(id),
      note,
      now: Date.now,
    });
    await reconcile.atBoot(opened.opened);
    stopReconcile = reconcile.start(options.reconcileEveryMs ?? RECONCILE_EVERY_MS);

    // Токены сессий выводятся из ключа ядра (03): сессия, пережившая ядро, говорит с новым тем же
    // токеном. Запускатель сессий берёт `sessionTokens` из загрузки и чеканит токен шага.
    const sessionTokens = createSessionTokens(token.token);
    const health = { build, bootId, pid: process.pid, startedAt, home: layout.root };
    // Одна обвязка проверок на ядро: API (инструменты модели, захват), дорога сессии (реестр
    // стендов снимается в конце задачи) и дирижёр берут одну и ту же.
    // Экономика исполнителя — над той же книгой окон и проводкой контекста, что у крана потока.
    const loopPin = options.loop ? options.loop.pin : undefined;
    // Ключи маршрута, прочитанные дорогой (P61): дорога пишет, маска `known` читает (W2b).
    const sessionKeys = createSessionKeyBook(join(layout.root, 'session-state'));
    // Активный контур панели (уровень 1, только чтение её файла): его судят и `set-route`
    // (обязательный контур), и `tier` каждого шага. Читается на каждый суд (s10 G7): режим или
    // активный контур, переключённые человеком, доходят до следующей команды без перезапуска ядра.
    // Шлюз без маршрута в реестре — `down`. Журнал слышит смену политики, а не каждое чтение.
    let notedPolicy: string | undefined;
    const contourNow = (): ContourPolicy | undefined => {
      const policy = panel.contour((id) => routes.get(id) !== undefined);
      const key = JSON.stringify(policy ?? null);
      if (key !== notedPolicy) {
        if (notedPolicy !== undefined || policy) note('contour.policy', { ...(policy ?? {}) });
        notedPolicy = key;
      }
      return policy;
    };
    contourNow();
    // Суд выбранных человеком маршрутов (`set-route` и маршруты вопроса «ask»): один реестр, один контур.
    const routePortsNow = (): SetRoutePorts => {
      const contour = contourNow();
      return {
        routeOf: (id) => {
          const route = routes.get(id);
          return route ? { kind: route.kind } : undefined;
        },
        ...(contour ? { contour } : {}),
      };
    };
    const economy = bootEconomy({
      contour: contourNow,
      tasksDir: layout.tasks,
      windows,
      context,
      adapters,
      sessionTokens,
      pin: loopPin ?? (() => processPin()),
      keys: sessionKeys,
      windowOf: (routeId, model) => routeWindows.windowOf(routeId, model),
    });
    learnedCell = economy.learned;
    // Дописать оборванную запись настройки и подписаться на дрейф — до API и до первого читателя.
    configWiring = createConfigPort({ layout, note });
    const configPort = configWiring.port;
    // `agentdeck state`: ручка API и снимок запуска собираются над одной библиотекой сценариев.
    const stateDeps = { scenarioOf: libraryScenarioOf(layout.scenarios) };
    const verifier = buildVerifierWiring({
      registry,
      layout,
      note,
      windows,
      known: economy.known,
    });
    // Удержание своей модели панелью (этап 10, зона C): прошлое удержание возвращается до API —
    // слот карты занят его живым сервером раньше, чем задача ядра попросит свою модель.
    const localHold = createLocalHold({
      workRoot: join(layout.root, 'routes', 'local-hold'),
      journal: routeJournal,
      core: { bootId },
    });
    await localHold.restore().catch((error: unknown) => {
      note('local.hold', { state: 'restore-failed', reason: reasonOf(error) });
    });
    localFront = options.localFront
      ? startLocalFront({
          port: options.localFront.port,
          target: (stale) => localHold.target(stale),
          // Кеш слота по разговорам — то, что делал `prepare(session)` прежнего шлюза в панели.
          slots: createSlotCache({ note }),
          ...(options.localFront.retryMs ? { retryMs: options.localFront.retryMs } : {}),
          note,
        })
      : undefined;
    const front = localFront;
    if (options.userGateway) {
      const wanted = options.userGateway.port;
      const appData = panel.appData;
      userGateway = startUserGatewayWiring({
        port:
          wanted === 'panel'
            ? () => panelGatewayPort(appData ? readPanelListenerSettings(appData) : undefined)
            : () => wanted,
        hops: panel.hops,
        profiles: () => panel.profilesNow(),
        ...(options.localFront ? { localFront: options.localFront.port } : {}),
        ...(options.userGateway.intervalMs ? { intervalMs: options.userGateway.intervalMs } : {}),
        note,
      });
      // Первый такт — без ожидания: хост поднимается за секунды, загрузка ядра его не ждёт.
      void userGateway.tick();
    }
    if (options.dlpProxy && panel.appData) {
      dlpProxy = startDlpProxyWiring({
        hops: panel.hops,
        appData: panel.appData,
        ...(options.dlpProxy.intervalMs ? { intervalMs: options.dlpProxy.intervalMs } : {}),
        note,
      });
      void dlpProxy.tick();
    }
    const dlpPort = dlpProxy;
    const gatewayWiring = userGateway;
    const refreshRoutes = refreshPanelRoutes;
    const contoursPort = createContoursPort(panel.hops, {
      profiles: () => panel.profilesNow(),
      ...(options.localFront ? { localFront: options.localFront.port } : {}),
      // Правка контура в панели — такт шлюза сейчас (s10 G7), а не через 5 с.
      ...(gatewayWiring ? { applyUserGateway: () => gatewayWiring.apply() } : {}),
      // Контур, заведённый после загрузки, — маршрут реестра с этой же правки (s10 G7).
      ...(refreshRoutes
        ? { refreshRoutes: () => refreshRoutesNoted(refreshRoutes, panel.profilesNow(), note) }
        : {}),
    });
    const api = buildCoreApi({
      // Учёт контуров (C3b): карточка шлюза, расход и бюджет панели читаются у звена.
      contours: () => contoursPort,
      // Прокси защиты данных человека (C3c): состояние и такт по просьбе панели.
      dlpProxy: () => dlpPort,
      // Этап 11: дерево агентов, места сеансов, активность своей модели — порты своих проводок.
      agents: () => agents.port(),
      allocator: () => allocator.port(),
      // Этап 11 (P140): сброс ключа обучения — в кэш выученного, затем перечитать его.
      learned: () =>
        learnedPortOf({
          tasksDir: layout.tasks,
          note,
          refresh: () => void economy.history().catch(() => undefined),
        }),
      localActivity: () => ({
        control: async (request) => hopControl(await panel.hops.handle(), request),
      }),
      localHold: () => ({
        hold: localHold,
        front: () =>
          front ? { port: front.port, url: front.url, listening: front.listening() } : null,
      }),
      registry,
      layout,
      coreToken: token.token,
      sessionTokens,
      sessions,
      health,
      note,
      windows,
      verifier,
      split: () => splitEnv,
      known: economy.known,
      // Команды человека над маршрутами: `set-route` судит набор по реестру этой загрузки,
      // `clear-exhausted` идёт к тому же хосту звеньев, что и дорога сессии.
      routes: routePortsNow,
      hops: () => async (request) => hopControl(await panel.hops.handle(), request),
      publisher: () => publisher,
      // Ответ «повторить сверку» (точка 4) ставит действие в ближайший проход таймера сверки.
      reconcile: () => reconcile,
      // Вопрос панели: та же среда, что у оценки (набор маршрутов, библиотека), пока дирижёр жив.
      // Отказ суда пишется в журнал ядра и без дирижёра: попытка подделки видна всегда.
      ask: () => ({
        replay: (cmdId) => replayAsk(registry, cmdId),
        create: (body) => {
          const env = splitEnv;
          return env
            ? createAskTask(body, registry, env, askBridges, routePortsNow)
            : Promise.resolve({ status: 501 as const });
        },
        refused: (cmdId, code, reason) => note('ask.refused', { cmdId, code, reason }),
      }),
      // Ревью по ссылке: та же среда деления, что у оценки, пока дирижёр жив; нет — 501.
      reviewLink: () => {
        const wiring = reviewLink;
        const env = splitEnv;
        return wiring && env ? { open: (body) => wiring.open(body, env) } : undefined;
      },
      config: () => configPort,
      sessionState: createSessionStatePort(stateDeps),
      // Ранг модели правки человека — те же лестницы, что судит `tier` шага (один источник).
      ladders: economy.ladders,
      // Цена хода в виде задачи панели — чтение того же реестра маршрутов этой загрузки.
      routePrice: async (id, model) => {
        const route = routes.get(id);
        return route ? route.read.price(model) : { absent: true };
      },
      routeList: () => routes.list(),
      trustedHops: supervisor.hops,
      // Вид сеанса чата читает поток нормализатором того переходника, что запускал сеанс.
      adapters,
    });
    app = api;
    const decision: PortDecision = await listenOnAllocatedPort(async (port) => {
      await api.listen({ host: LOOPBACK, port });
    });
    const url = `http://${LOOPBACK}:${decision.port}`;
    note('port', { port: decision.port, rejected: decision.rejected });
    // Версия CLI — один читатель на ядро: дорога пишет её в журнал, замер базы кладёт в ключ.
    const cliVersion = createCliVersionReader();
    const road = createSessionRoad({
      url,
      windowOf: (routeId, model) => routeWindows.windowOf(routeId, model),
      layout,
      sessionTokens,
      routes,
      adapters,
      sessions,
      loginPath: memoLoginPath(options.loginPath, note),
      note,
      liveCopies: () => liveCopiesOf(registry),
      // Сервер MCP человека с хостом форжа панели — только чтение (`forge-mcp-read-only`).
      forgeHosts: () => forgeHostsOfPanel(panel.appData),
      stands: verifier.services.stands,
      // Хост звеньев один на дом ядра, поднимается первым сеансом через звено (W2b).
      hops: { handle: panel.hops.handle, forget: panel.hops.forget, factsOf: panel.hopFactsOf },
      keys: sessionKeys,
      askBridges,
      ...(options.panelBridgeScript ? { panelBridgeScript: options.panelBridgeScript } : {}),
      cliVersion,
      sessionState: launchSnapshot(stateDeps),
      ...(options.resourceReaders ? { readers: options.resourceReaders } : {}),
    });
    roadCell = road;
    // Замер базы на старте сеанса (G9): пробы в фоне снимаются и дожидаются вместе с дирижёром.
    const measureBase = baseAtStart({ context, note, version: cliVersion });
    const conductor = startConductor({
      registry,
      layout,
      verifier,
      road,
      note,
      adapters,
      routes,
      economy: economy.run,
      history: economy.history,
      measureBase,
      askBridges,
      taskEnv,
      // Форж проводок — из каталога, решённого здесь один раз: ядро в процессе теста с
      // `panelAppData` не читает настоящие настройки форжа человека.
      panelAppData: panel.appData,
      // Места сеансов машины (этап 11, P141): одна очередь мест на ядро, порт — исполнителю.
      allocator: allocator.conductor(),
      ...(options.loop === undefined ? {} : { loop: options.loop }),
    });
    splitEnv = conductor.split;
    publisher = conductor.publisher;
    reviewLink = conductor.reviewLink;
    // Опрос форжа после публикации (05:77): выключен, пока человек не внёс репозиторий в
    // `forgePoll` конфига ядра; новую задачу ответов открывает через того же дирижёра.
    const forgePoll = createPollWiring({
      registry,
      split: () => splitEnv,
      layout,
      note,
      forgeFor: (url) => forgeOfPanel(panel.appData)(url).port,
      ...options.forgePoll,
    });
    stopConductor = async () => {
      // Первым и с ожиданием: идущий круг опроса ещё может открыть задачу через дирижёра.
      await forgePoll.stop();
      splitEnv = undefined;
      publisher = undefined;
      reviewLink = undefined;
      try {
        await conductor.stop();
      } finally {
        await measureBase.stop();
      }
    };

    // Канал надзора — до строки procs.json: сторож находит его путь в ней же.
    const supervisorChannel = await supervisor.open();
    await registerCore(
      layout.procs,
      {
        build,
        pid: process.pid,
        pidStart: self.value.start,
        bootId,
        port: decision.port,
        url,
        startedAt,
        home: layout.root,
        portDecision: { rejected: decision.rejected },
        ...(supervisorChannel ? { supervisor: supervisorChannel } : {}),
      },
      procsDeps,
    );
    registered = true;
    // Исполнитель — после строки в procs.json: мост MCP сессии находит ядро по ней.
    conductor.start();
    forgePoll.start();

    const stopBackups = startBackups(registry, layout, note);
    const { clock, stop: stopClock } = startClockJumps(registry, bootId, note);
    tickingClock = clock;

    options.log?.(`agentdeck core ${build} on ${url} (home ${layout.root})`);
    // Предел открытых файлов (09 limits): низкий — предупреждение и строка журнала ядра.
    await checkOpenFiles(options.openFiles ?? (() => openFilesLimit()), note, options.log);
    let stopped = false;
    return {
      layout,
      port: decision.port,
      url,
      bootId,
      registry,
      app: api,
      clock,
      sessionTokens,
      routes,
      adapters,
      sessions,
      road,
      askBridges: { get: askBridges.get, size: askBridges.size },
      windows,
      economy: economy.run,
      measureBase,
      running: () => conductor.running(),
      async stop() {
        if (stopped) return;
        stopped = true;
        stopBackups();
        stopClock();
        // Каждый шаг остановки идёт, даже если предыдущий упал (ревью F-107): строка в procs.json
        // и журнал ядра закрываются всегда; сбой называется после всех шагов.
        const failures = await releaseAll(
          [
            () => stopConductor?.(),
            () => stopReconcile?.(),
            () => api.close(),
            () => localFront?.stop(),
            () => userGateway?.stop(),
            () => dlpProxy?.stop(),
            () => supervisor.close(),
            async () => {
              // Чистая остановка — серверы маршрутов уходят вместе с ядром; при крахе сюда не
              // доходит, и они остаются для следующего ядра (P10).
              const released = await shutdownRoutes(routes, note);
              note('routes.stopped', {
                released: released.verified.length,
                leaks: released.leaks.length,
              });
            },
            () => observer.stop(),
            () => agents.stop(),
            () => allocator.stop(),
            () => registry.closeAll(),
            () => configWiring?.dispose(),
            () => unregisterCore(layout.procs, bootId, procsDeps),
          ],
          note,
        );
        note('stop', failures.length ? { failures: failures.map(reasonOf) } : {});
        // Замок дома — последним: следующее ядро встаёт, когда это уже ничего не держит.
        homeLock.release();
        log.close();
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, 'core stop failed');
      },
    };
  } catch (error) {
    note('boot.failed', { reason: reasonOf(error) });
    await releaseAll(
      [
        () => stopConductor?.(),
        () => stopReconcile?.(),
        () => app?.close(),
        () => localFront?.stop(),
        () => userGateway?.stop(),
        () => dlpProxy?.stop(),
        () => supervisor.close(),
        () => shutdownRoutes(routes, note),
        () => observer.stop(),
        () => agents.stop(),
        () => allocator.stop(),
        () => registry.closeAll(),
        () => configWiring?.dispose(),
        () => (registered ? unregisterCore(layout.procs, bootId, procsDeps) : undefined),
      ],
      note,
    );
    homeLock.release();
    log.close();
    throw error;
  }
}
