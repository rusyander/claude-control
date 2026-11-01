import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createAdapterRegistry } from '../../adapters/index.ts';
import { createSessionTokens } from '../../policy/session-tokens/session-tokens.ts';
import type { PublisherCommandPort } from '../../conductor/commands/commands.types.ts';
import { failHalfMadeAnswers, type SplitEnv } from '../../conductor/estimate/index.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { WindowBook } from '../../economy/window/index.ts';
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
import { cliPathOf } from '../cli-paths.ts';
import { startConductor } from '../conductor-wiring/index.ts';
import { createBootReconcile, RECONCILE_EVERY_MS } from '../boot-reconcile.ts';
import { buildCoreRoutes, readRouteConfig } from '../core-routes.ts';
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
import { createPollWiring } from '../forge-wiring/poll-wiring.ts';
import { createObserverWiring } from '../observer-wiring/index.ts';
import { processPin } from '../conductor-wiring/session-start.ts';
import { createRouteWindows } from '../route-windows.ts';
import { createSessionRuntime, type SessionRuntime } from '../session-runtime.ts';
import type { LearnedTable } from '../../economy/learned/index.ts';
import { createSessionKeyBook } from '../session-keys.ts';
import { buildVerifierWiring } from '../verifier-wiring/index.ts';
import type { BootedCore, BootOptions } from './boot.types.ts';
import { openCoreLog, routeJournalOf } from './core-log.ts';
import { reasonOf, releaseAll } from './release.ts';
import { startBackups, startClockJumps } from './timers.ts';
import { supervisorWiring } from '../supervisor-wiring.ts';
import { checkOpenFiles } from './open-files.ts';
import { openFilesLimit } from '../../platform/limits.ts';

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
  const stamps = createClock(REAL_CLOCK, bootId);
  const routeJournal = routeJournalOf(note);
  // Профили панели и хост звеньев (W2b): маршруты ключа API и контуров, звено дороги сессии.
  const panel = panelWiring(layout, { panelAppData: options.panelAppData, bootId }, note);
  let routes: RouteRegistry;
  try {
    routes =
      options.routes ??
      buildCoreRoutes(
        adapters,
        layout,
        options.routeConfig ?? readRouteConfig(layout),
        { bootId, journal: routeJournal },
        panel.sources,
      );
  } catch (error) {
    // Настройка маршрутов не той формы — отказ до аренды задач, порта и строки в procs.json.
    note('boot.refused', { reason: reasonOf(error) });
    log.close();
    throw error;
  }
  // Книга окон одна на ядро (G7): проводка экономики пишет в неё факты потока, health читает.
  const windows = new WindowBook();
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
  const probe = createLivenessProbe();
  const build = options.build ?? process.env.AGENTDECK_CORE_BUILD ?? 'dev';
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
  // Порт настройки ядра (этап 7): один на загрузку, снимает подписку на дрейф при остановке.
  let configWiring: CoreConfigWiring | undefined;
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
      readers: options.readers ?? actionReaders(),
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
    // Активный контур панели (уровень 1, только чтение её файла): один на загрузку — его судят
    // и `set-route` (обязательный контур), и `tier` каждого шага. Шлюз без маршрута — `down`.
    const contour = panel.contour((id) => routes.get(id) !== undefined);
    if (contour) note('contour.policy', { ...contour });
    const economy = bootEconomy({
      ...(contour ? { contour } : {}),
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
    const api = buildCoreApi({
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
      routes: () => ({
        routeOf: (id) => {
          const route = routes.get(id);
          return route ? { kind: route.kind } : undefined;
        },
        ...(contour ? { contour } : {}),
      }),
      hops: () => async (request) => hopControl(await panel.hops.handle(), request),
      publisher: () => publisher,
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
      layout,
      sessionTokens,
      routes,
      adapters,
      sessions,
      loginPath: memoLoginPath(options.loginPath, note),
      note,
      liveCopies: () => liveCopiesOf(registry),
      stands: verifier.services.stands,
      // Хост звеньев один на дом ядра, поднимается первым сеансом через звено (W2b).
      hops: { handle: panel.hops.handle, forget: panel.hops.forget, factsOf: panel.hopFactsOf },
      keys: sessionKeys,
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
      ...(options.loop === undefined ? {} : { loop: options.loop }),
    });
    splitEnv = conductor.split;
    publisher = conductor.publisher;
    // Опрос форжа после публикации (05:77): выключен, пока человек не внёс репозиторий в
    // `forgePoll` конфига ядра; новую задачу ответов открывает через того же дирижёра.
    const forgePoll = createPollWiring({
      registry,
      split: () => splitEnv,
      layout,
      note,
      ...options.forgePoll,
    });
    stopConductor = async () => {
      // Первым и с ожиданием: идущий круг опроса ещё может открыть задачу через дирижёра.
      await forgePoll.stop();
      splitEnv = undefined;
      publisher = undefined;
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
            () => registry.closeAll(),
            () => configWiring?.dispose(),
            () => unregisterCore(layout.procs, bootId, procsDeps),
          ],
          note,
        );
        note('stop', failures.length ? { failures: failures.map(reasonOf) } : {});
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
        () => supervisor.close(),
        () => shutdownRoutes(routes, note),
        () => observer.stop(),
        () => registry.closeAll(),
        () => configWiring?.dispose(),
        () => (registered ? unregisterCore(layout.procs, bootId, procsDeps) : undefined),
      ],
      note,
    );
    log.close();
    throw error;
  }
}
