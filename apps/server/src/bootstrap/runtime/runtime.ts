import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appRootDir } from '../../lib/app-root/app-root.ts';
import type { LocalModels } from '../../domains/local-models/service.ts';
import { chatRunProfile } from '../../domains/chat/group-profile/group-profile.ts';
import { cancelHalfRunPlans } from '../../domains/groups/legacy-runs/cancel-half-run.ts';
import type { RunOptions } from '../../domains/chat/run-options/run-options.ts';
import type { KeepAwake } from '../../lib/keep-awake/keep-awake.ts';
import { createGlobalLayer, type GlobalLayer } from '../../domains/global-layer/service.ts';
import type { ServerContext } from '../../context.ts';
import type { ChatEvent } from '../../domains/chat/chat-events.ts';
import { localizeText, serverText } from '../../lib/server-texts/server-texts.ts';
import type {
  ChatRunRegistry,
  RunFinished,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import {
  adoptableEntries,
  isPidAlive,
  pidLooksLikeCli,
  RunLedger,
} from '../../domains/chat/run-ledger/run-ledger.ts';
import type { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { HandoffChains, HandoffChainStore } from '../../domains/chat/ChatHandoff/ChatHandoff.ts';
import { TreePause } from '../../domains/chat/tree-pause/tree-pause.ts';
import {
  hasParentLink,
  lastAskedInput,
  PENDING_ASKS_FILE,
  wirePendingAsks,
  type PendingAsks,
} from '../../domains/chat/pending-asks/pending-asks.ts';
import { apiTokenPath } from '../../lib/api-token/api-token.ts';
import { listProviders } from '../../providers/registry.ts';
import { foreignProviderId } from '@agentdeck/contracts/platform-consumers';
import { KitService } from '../../domains/kit/service.ts';
import { localLayerRun } from '../../domains/local-layer/local-layer.ts';
import { kitComposeRefusal } from '../../domains/kit/codex.ts';
import { codexHome } from '../../providers/catalog/config-dirs.ts';
import { LOCAL_PLATFORM_ID } from '../../domains/local-models/connect.ts';
import { AutoContinue, continueNotice } from '../../domains/chat/auto-continue/auto-continue.ts';
import { localPaths, readState as readLocalState } from '../../domains/local-models/paths.ts';
import { ProjectRunnerRegistry } from '../../domains/project-runner/project-runner.ts';
import {
  E2eRunRegistry,
  MutationChecks,
  sweepMutationCopies,
  ProjectTestManualRegistry,
  ProjectTestRunRegistry,
  createE2eWatch,
  reapProjectTestOrphans,
  type E2eWatch,
} from '../../domains/project-tests/project-tests.ts';
import type { DlpProxy } from '../../domains/dlp/dlp.ts';
import type { CoreGatewayView } from '../../domains/platform/gateway-view/gateway-view.ts';
import type { PlatformWatch } from '../../domains/platform/watch/watch.ts';
import type {
  ContourLinker,
  ContourPush,
  ContourReader,
  CoreContours,
} from '../../domains/platform/contours/index.ts';
import {
  localClaudeRun,
  resolveRunRoute,
  runRouteOf,
  type PlatformRoutingDeps,
  type PlatformRunRoute,
} from '../../domains/platform/routing/routing.ts';
import type { createRunNotifier } from '../../domains/remote-notify.ts';
import type { TelegramAnswersCover } from '../../domains/notify/telegram.ts';
import { chatTitleOf } from './chat-title.ts';
import { activateAtlassianMcp } from '../../domains/integrations/mcp-server/mcp-server.ts';
import { readLastAssistantTurn } from '../../domains/chat/ChatHistory/ChatHistory.ts';
import { createHandoffPlanner } from '../../routes/chat/handoff-routes.ts';
import { projectsDir } from '../../routes/chat/paths.ts';
import { syncRelayHooks } from '../../routes/chat/outside-relay-routes/outside-relay-routes.ts';
import { deferredAsksOf } from '../../routes/chat/deferred-routes/deferred-store.ts';
import { continuationLink } from '../../lib/app-store/chat-links.ts';
import { createEventHub, type EventHub } from '../../lib/event-hub/event-hub.ts';
import { PANEL_ACTION_CONFIRM_TIMEOUT_MS } from '@agentdeck/contracts/panel-agent';
import { PanelPendingActions } from '../../domains/panel-agent/pending/pending.ts';
import { reapPanelAgentOrphans } from '../../domains/panel-agent/processes/processes.ts';
import { createCoreCaller } from '../../domains/core-ask/core-ask.ts';
import { createCoreChatPort } from '../../domains/chat/core-run/core-chat-port.ts';
import {
  coreTaskListOver,
  createCoreStepSessions,
} from '../../domains/chat/core-run/core-step-sessions.ts';
import { coreChatBookPath } from '../../domains/chat/core-run/core-chat-book.ts';
import {
  createCoreChatHistory,
  type CoreChatHistory,
} from '../../domains/chat/core-run/core-chat-history.ts';
import { coreHomeOf } from '../../lib/hop-recorder.mjs';
import {
  projectTestsBusy,
  reconcileProjectSuites,
  reconcileProjectTurnHooks,
  testsChatNote,
  wireTestsChatNote,
} from '../tests-chat-wiring/tests-chat-wiring.ts';
import {
  createForeignCarry,
  type ForeignCarryResolver,
} from '../../domains/chat/core-foreign/foreign-carry.ts';
import { carryOfTestsRoute } from '../../domains/chat/core-run/session-carry.ts';
import { ActivatingTestRunRegistry } from '../activating-test-runs/activating-test-runs.ts';
import { wireChat } from './chat-wiring.ts';
import { wireCoreSupervisor, type CoreSupervisorWiring } from './core-supervisor-wiring.ts';
import { wireGateway } from './gateway-wiring.ts';
import { wireLocalModels } from './local-models-wiring.ts';
import { wireNotify } from './notify-wiring.ts';

/**
 * Объекты, живущие дольше запроса. Создаются при сборке приложения — только
 * оттуда их можно погасить при выходе — и подаются маршрутам замыканием
 * (см. `route-table.ts`), а не заводятся модулем маршрутов самостоятельно:
 * реестр, до которого никто снаружи не дотянется, при выходе осиротит свои
 * процессы.
 */

export interface Runtime {
  /** Dev-серверы проектов: спавненные процессы и порты, которые они назвали. */
  projectRunner: ProjectRunnerRegistry;
  /** Прогоны чатов Claude. */
  chatRuns: ChatRunRegistry;
  /** Права и автоподтверждение чатов — один объект на сервер. */
  chatSession: ChatSession;
  /** Прогоны GUI-тестов проектов. */
  projectTestRuns: ProjectTestRunRegistry;
  /** Ручные прогоны: кейсы проходит человек, панель записывает. */
  projectTestManual: ProjectTestManualRegistry;
  /** Прогоны автотестов папки e2e самой панелью: раннер через оболочку, без агента. */
  e2eRuns: E2eRunRegistry;
  /** Проверки набора кейсов поломкой: прогон в копии по кнопке человека. */
  mutationChecks: MutationChecks;
  /** Наблюдение за папками e2e проектов: новый тест становится кейсом сам. */
  e2eWatch: E2eWatch;
  /** Уведомления на телефон о судьбе прогона. */
  notifyRun: ReturnType<typeof createRunNotifier>;
  /** Покрывают ли ответы из Telegram права и вопросы; опрос подставляет себя сюда. */
  telegramAnswersCover: TelegramAnswersCover;
  /** Имя чата по ключу прогона — для текстов Telegram. */
  chatTitle: (chatId: string) => string | undefined;
  /** Ход сессии вне панели кончился — «Закончил» в Telegram после долгой работы. */
  outsideTurnEnded: (sessionId: string) => void;
  /** Цепочки продолжений в чистой сессии. */
  handoffChains: HandoffChains;
  /** Пауза дерева разговоров; маршруты дерева и разделения берут её отсюда. */
  treePause: TreePause;
  /** Записанные вопросы деревьев; отмена плана разделения снимает вопросы групп. */
  pendingAsks: PendingAsks;
  /** История разговоров не-Claude CLI чата из видов сеансов ядра (этап 11, волна 3). */
  coreHistory: CoreChatHistory;
  /** Слой панели разговору чужого CLI через ядро (G6): строка о тестах, набор для CLI. */
  foreignCarry: ForeignCarryResolver;
  /** Прокси защиты данных; поднимается отдельно, если включён в настройках. */
  dlpProxy: DlpProxy;
  /** Шлюз контуров глазами панели: слушает шлюз человека у ядра, здесь его карточка (C3d). */
  platformGateway: CoreGatewayView;
  /**
   * Учёт контуров звена ядра (C3b): лента читает отсюда журнал сжатий, картинки и колоды
   * берут адрес звена для запросов в контур.
   */
  contours: ContourReader & ContourLinker;
  /** Правка контура — ядру до ответа на запрос (s10 G7; хук `onSend` в `index.ts`). */
  contourPush: ContourPush;
  /** Фоновая перепроверка активного контура (A-2): таймер и отказы по правам. */
  platformWatch: PlatformWatch;
  /** Подписчики `/api/events` и рассылка об изменениях файлов. */
  events: EventHub;
  /**
   * Карточки подтверждения агента панели: их держит открытый запрос переходника,
   * а решает клик в окне — другой запрос, поэтому объект переживает оба.
   */
  panelPending: PanelPendingActions;
  /** Адрес самой панели: его получает переходник MCP при регистрации. */
  selfBaseUrl: string;
  /** Локальные модели: железо, сервер моделей, загрузки с прогрессом. */
  localModels: LocalModels;
  /** Надзор за процессом ядра: состояние для карточки сбоя, перезапуск, автозапуск ОС. */
  coreSupervisor: CoreSupervisorWiring;
  /** Запрет на сон на время локального прогона: экран питания телефона спрашивает и снимает. */
  keepAwake: KeepAwake;
  /** Сверка панели с глобальным слоем `~/.claude` (В5): пары, вердикт, перенос. */
  globalLayer: GlobalLayer;
  /** Встроенный набор панели (В2): режимы по CLI, копии «моё», что получает прогон. */
  kit: KitService;
  /**
   * Маршрут прогона по потребителю (`foreign:<cli>`, `tests`, …) — тот же, что
   * спрашивают чат и тесты. Нужен лёгкому окну панели (помощники формы и
   * структуры): без него окно чужого CLI ушло бы мимо контура.
   */
  runRoute: (origin: string) => PlatformRunRoute;
  /** Порт шлюза человека у ядра; 0 — ядро его не держит. */
  gatewayPort: () => number;
  /** Куда уведён сам Claude настройкой settings.json — для шапки чата. */
  claudeSettingsRoute: PlatformRoutingDeps['claudeSettingsRoute'];
  /** Выбор MCP локального прогона проекта — для подписи шапки чата. */
  localMcpPicks: PlatformRoutingDeps['localMcpPicks'];
  /** Погасить всё, что спавнит процессы. Идемпотентно. */
  shutdown: () => void;
}

/** Подстановки рантайма для тестов: без них — настоящие части. */
export interface RuntimeSeams {
  /** Учёт контуров вместо клиента ядра (`memoryContours`): тест задаёт шлюз, расход, исчерпание. */
  contours?: CoreContours;
}

export function createRuntime(
  ctx: ServerContext,
  selfBaseUrl: string,
  seams: RuntimeSeams = {},
): Runtime {
  // Прежний рантайм групп ушёл (этап 10, F1): недоведённые запуски продолжать некому — до
  // любого чтения планов они получают `cancelledAt`, а ждущие D-n групп отзываются: ответить
  // на них уже некому. Повторный старт ничего не меняет.
  const cancelled = cancelHalfRunPlans(ctx.store, new Date().toISOString(), deferredAsksOf(ctx));
  if (cancelled.plans.length + cancelled.asks.length > 0)
    console.warn('legacy groups: half-run plans cancelled', cancelled);
  // Реестр dev-серверов проектов — иначе спавненные процессы осиротеют; порт
  // становится известен уже после ответа на запуск (его печатает сам
  // dev-сервер), поэтому запоминает его реестр — через узкий колбэк, а не зная
  // про состояние панели.
  const projectRunner = new ProjectRunnerRegistry({
    onPortDiscovered: ({ projectPath, dir, port }) => {
      const target = dir ? join(projectPath, dir) : projectPath;
      ctx.store.rememberRunnerPort(target, port, { projectPath, dir });
    },
  });
  // Реестр прогонов чата, права сессии и журналы прогонов (`chat-wiring.ts`).
  // Слой чужого CLI заводится ниже (`foreignCarry`); ход зовёт его уже после сборки (W3-17a).
  const { chatRuns, chatSession } = wireChat(ctx, {
    foreignCarry: (input) => foreignCarry(input),
  });
  // Прогоны тестов — третий такой объект: агент ходит по кейсам минутами, и
  // оборванный при выходе панели процесс остался бы висеть с полным доступом.
  //
  // Обёртка над реестром вместо правки самого реестра: включение MCP —
  // обстоятельство внешнего мира, а реестр знает только про свои прогоны. Так же
  // сюда подаются уведомления и оценка стоимости.
  const projectTestRuns = new ActivatingTestRunRegistry((projectPath) => {
    activateAtlassianMcp(
      {
        paths: ctx.location.paths,
        store: ctx.store,
        backupDir: ctx.backupDir,
      },
      ctx.store,
      projectPath,
    );
  });
  // Ручной прогон живёт в памяти (его открывает один человек в одном окне), но
  // каждый отмеченный результат уходит на диск сразу. При выходе панели
  // незакрытая сессия помечается брошенной — иначе в истории остался бы прогон,
  // который «идёт» уже после смерти процесса.
  const projectTestManual = new ProjectTestManualRegistry();
  // Автотесты папки: раннер запущен оболочкой и с панелью сам не умирает.
  const e2eRuns = new E2eRunRegistry();
  const mutationChecks = new MutationChecks();
  // Копии проверок поломкой, оборванных выходом или падением прежнего процесса.
  void sweepMutationCopies(ctx.location.paths.appData).catch((error: unknown) => {
    console.warn('mutation check: sweep of old copies failed', error);
  });
  // Уведомления: push, Telegram, вебхук и «Закончил» сессии вне панели (`notify-wiring.ts`).
  const { notifyRun, telegramAnswersCover, telegram, webhook, outsideTurnEnded, coreRelay } =
    wireNotify(ctx, { chatRuns, projectTestRuns });
  /**
   * Цепочки продолжений в чистой сессии: тумблер автомата и номер шага. Объект
   * переживает запрос — тумблер ставится в одном обращении, а срабатывает при
   * завершении прогона, возможно, уже без открытой вкладки. И перезапуск панели:
   * прогоны его переживают (журнал ниже), а цепочка без диска начинала бы счёт
   * заново — потолок в восемь продолжений обнулялся бы, а предохранитель
   * «чекпойнт не изменился» пропускал лишний круг.
   */
  const handoffChains = new HandoffChains(
    () => ctx.store.getSettings().handoffAutoDefault,
    new HandoffChainStore(ctx.location.paths.appData),
  );
  /**
   * Кто решает, продолжать ли работу самому. Реестр знает только, что прогон
   * кончился; предохранители (свежесть файла-опоры, потолок цепочки, успешное
   * завершение) живут в домене и подаются сюда тем же приёмом, что и уведомления.
   */
  /**
   * Пауза дерева разговоров: «Остановить всё» у родителя. Живёт дольше запроса
   * по той же причине, что и цепочки: стоящее дерево должно глушить автостарты
   * планировщика и разделения, а те срабатывают при завершении прогона, когда
   * вкладки может не быть.
   */
  // Вопросы и запросы прав разговоров дерева — на сервере, а не во вкладке (WP9c).
  const pendingAsks = wirePendingAsks(chatRuns, {
    file: join(ctx.location.paths.appData, PENDING_ASKS_FILE),
    isTreeChat: hasParentLink((key) => ctx.store.getChatLink(key)),
    readAsked: (chatId, sessionId) => lastAskedInput(projectsDir(ctx), sessionId ?? chatId),
  });
  const treePause = new TreePause({
    links: () => ctx.store.getChatLinks(),
    // Дерево — только прогоны реестра: ход чужого CLI идёт задачей ядра (этап 10, F2c).
    runs: chatRuns,
    asksOf: (keys) => pendingAsks.of(keys, (runId) => chatRuns.isRunning(runId)),
    store: {
      get: (root) => ctx.store.getTreePause(root),
      all: () => ctx.store.getTreePauses(),
      set: (record) => ctx.store.setTreePause(record),
      clear: (root) => ctx.store.clearTreePause(root),
    },
    autoApprove: {
      snapshot: (chatId) => chatSession.autoApproveFor(chatId),
      arm: (chatId, state) => chatSession.armAutoApprove(chatId, state),
    },
    bridge: (runId) => ({ runId, baseUrl: selfBaseUrl, tokenFile: apiTokenPath() }),
  });
  // Tests of the project (e2e folder, how a test becomes a case) on every chat start.
  const testsChatDeps = {
    appData: ctx.location.paths.appData,
    chatRuns,
    // Автотесты на закрытии тоже пишут в файлы групп — сверка ждёт и их.
    isBusy: projectTestsBusy(projectTestRuns, e2eRuns),
    log: (message: string, error: unknown) => console.warn(message, error),
  };
  const testsChat = wireTestsChatNote(testsChatDeps);
  // Проверка конца хода блока «Тесты» — хуком в каждом проекте реестра: так её видит
  // и VS Code, и терминал, а не только чат панели. После старта, чтобы не держать его.
  setImmediate(() =>
    reconcileProjectTurnHooks(
      ctx.location.paths.appData,
      ctx.store.getProjects().map((project) => project.path),
      (message, error) => console.warn(message, error),
    ),
  );
  reconcileProjectSuites(
    ctx.location.paths.appData,
    ctx.store.getProjects().map((project) => project.path),
    (message, error) => console.warn(message, error),
  );

  // Обычный чат на локальной модели после обрыва продолжает сам (L4b): сервер поднимает
  // присмотр, а ход, который CLI закончил ошибкой, — это.
  /** Прогон Claude идёт на локальной модели: маршрутом контура или переключателем «Claude Code на локальной модели». */
  const isLocalClaudeRun = (options: RunOptions, origin: string | undefined): boolean => {
    const url = options.platformEnv?.ANTHROPIC_BASE_URL ?? '';
    if (url) return url.includes(`/${LOCAL_PLATFORM_ID}`);
    // Claude, уведённый на локальную модель переключателем: адрес лежит в settings.json.
    return (origin ?? 'chat') === 'chat' && localModels.claudeRedirected();
  };
  /** Идёт ли хоть один прогон чата на локальной модели (ход чужого CLI — задача ядра). */
  const localRunActive = (): boolean =>
    chatRuns.anyRunning(
      (run) => run.meta.local === true || isLocalClaudeRun(run.options, run.meta.origin),
    );
  // Метка «локальный» ложится в журнал: усыновлённый после перезапуска прогон опций с адресом не несёт.
  chatRuns.setLocalClassifier((options, meta) => isLocalClaudeRun(options, meta.origin));
  const autoContinue = new AutoContinue({
    start: (chatId, options, meta) => chatRuns.start(chatId, options, meta),
    isLocal: (finished) =>
      finished.local === true || isLocalClaudeRun(finished.options, finished.origin),
    bridge: (runId) => ({ runId, baseUrl: selfBaseUrl, tokenFile: apiTokenPath() }),
    log: (message, error) => console.warn(message, error),
  });
  chatRuns.setStartListener((keys) => {
    autoContinue.started(keys);
    pendingAsks.started(keys);
  });
  const handoffPlanner = createHandoffPlanner({
    runs: chatRuns,
    chains: handoffChains,
    gate: treePause,
    session: chatSession,
    selfBaseUrl,
    contextLimit: () => ctx.store.getSettings().handoffContextLimit,
    // Продолжение наследует связь закрытого разговора: и родителя в дереве, и
    // подобранную под задачу модель. Иначе следующее сообщение человека —
    // первое, что придёт в новый чат без модели, — уехало бы на дефолте.
    carryLink: (from, to, prompt) => {
      const link = from.map((key) => ctx.store.getChatLink(key)).find(Boolean);
      if (link) ctx.store.setChatLink(to, continuationLink(link, prompt));
    },
  });
  chatRuns.setHandoffPlanner((finished) => {
    // Агент трогал папку e2e — её тесты в кейсы сразу, без просьбы человека.
    testsChat.finished(finished.options.cwd, finished.startedAt);
    return settleFinish(finished);
  });
  /** Конец хода: вопросы хаба, планировщик продолжения, продолжение локального чата после обрыва. */
  function settleFinish(finished: RunFinished): ChatEvent | undefined {
    pendingAsks.finished(finished);
    const planned = handoffPlanner(finished);
    const continued = autoContinue.finished(finished, Boolean(planned));
    if (planned || !continued) return planned;
    const notice = continueNotice(continued);
    return {
      kind: 'notice',
      code: notice.code,
      text: serverText(notice.textCode, notice.params),
      textCode: notice.textCode,
      textParams: notice.params,
    };
  }
  // Шлюз контуров, прокси защиты данных и фоновая проба контура (`gateway-wiring.ts`).
  const {
    platformGateway,
    contours,
    contourPush,
    budgetRelay,
    platformRoutingBase,
    dlpProxy,
    platformWatch,
  } = wireGateway(
    ctx,
    { telegram, webhook },
    process.env,
    seams.contours ? { contours: seams.contours } : {},
  );
  // Локальные модели, запрет сна, MCP локального прогона и полная маршрутизация контура
  // (`local-models-wiring.ts`).
  const localModelsWiring = wireLocalModels(ctx, {
    localRunActive,
    platformRoutingBase,
    coreEvents: () => contours.live()?.events,
  });
  const { keepAwake, localModels, platformRouting } = localModelsWiring;
  // Список задач без описаний (5.2): поиск и доска трекера — заголовками, и в группе,
  // и в обычном чате, где разделение может быть предложено.
  const boardHook = `node "${fileURLToPath(new URL('../../../../../tools/board-fields-hook.mjs', import.meta.url))}"`;
  // Обычный чат — лёгкий профиль: доска трекера заголовками. Прежде профиль шёл
  // под тумблером инициативы разделения (включён из коробки); тумблер снят
  // (этап 10, G14), поведение по умолчанию осталось.
  chatRuns.setGroupProfileResolver(() => chatRunProfile({ boardHook }));
  // Локальный слой проекта (режим карточки «Локальный слой» на «Проектах») — на каждом старте;
  // сборка упала — прогон идёт на командном слое, как без слоя (s10 G14 p6: перенос в ядро).
  chatRuns.setLocalLayerResolver((cwd) => {
    try {
      return localLayerRun(cwd);
    } catch {
      return undefined;
    }
  });
  // Сессии из терминала и VS Code видны телефону только через хуки панели:
  // включённой пересылке они нужны с первого сеанса, без ручной установки.
  syncRelayHooks(ctx);
  // Набор панели (В2) решается на КАЖДОМ старте, как и маршрут: режим, сменённый
  // на странице, действует со следующего сообщения. Едет и мимо контура —
  // облачный Claude получает его тем же флагом плагина.
  const kit = new KitService({
    appDataDir: ctx.location.paths.appData,
    claudeDir: () => ctx.location.paths.root,
    backupDir: ctx.backupDir,
    providers: () => listProviders().map(({ id, name }) => ({ id, name })),
    legacyModes: () => {
      const legacy = readLocalState(localPaths(appRootDir())).kit;
      return { claude: legacy.claude, qwen: legacy.qwen };
    },
    codexHome,
  });
  const runRoute = (origin: string, asked = '', runTag = ''): PlatformRunRoute => {
    const decision = resolveRunRoute(platformRouting, origin, asked, runTag);
    const routeOf = runRouteOf(decision);
    if (routeOf.refusal) return routeOf;
    // Claude уведён на локальную модель: выбор шапки («opus», «claude-opus-5-5»)
    // уехал бы флагом `--model` в Ollama, а такой модели там нет.
    const local = localClaudeRun(platformRouting, origin, decision);
    const route: PlatformRunRoute = local
      ? {
          ...routeOf,
          // Окно сервера и ограничения — и прогону, уведённому переключателем:
          // у него адреса контура нет, а окружение прогона всё равно доходит.
          env: { ...routeOf.env, ...local.env },
          model: {
            model: local.model,
            asked,
            source: 'local',
            replaced: Boolean(asked) && asked !== local.model,
          },
        }
      : routeOf;
    let extras: ReturnType<KitService['runExtras']>;
    try {
      extras = kit.runExtras({
        provider: foreignProviderId(origin) ?? 'claude',
        local: decision.routed && decision.platformId === LOCAL_PLATFORM_ID,
        hasSources: route.layers?.args.includes('--setting-sources') ?? false,
      });
    } catch (error) {
      // Набор не собрался (диск, права) — прогон без него ушёл бы на глобальный
      // слой вопреки выбранному режиму. Отказ текстом, а не падение маршрута.
      console.warn('[kit] compose failed:', error);
      const language = ctx.store.getSettings().language === 'en' ? 'en' : 'ru';
      return { ...route, refusal: localizeText(kitComposeRefusal(error), language) };
    }
    // Облегчённый набор локального прогона унёс все MCP-серверы (`--strict-mcp-config`):
    // взятые человеком в этом проекте едут своим `--mcp-config` (L4).
    const leanLocal =
      decision.routed &&
      decision.platformId === LOCAL_PLATFORM_ID &&
      route.layers?.args.includes('--strict-mcp-config') === true;
    const withMcp: PlatformRunRoute = leanLocal
      ? { ...route, localMcp: (cwd) => localModels.mcpRun(cwd) }
      : route;
    return extras.args.length || Object.keys(extras.env).length || extras.append
      ? { ...withMcp, kit: extras }
      : withMcp;
  };
  chatRuns.setPlatformRouting(runRoute);
  // Агент тестов на Claude — наши слои и набор маршрута `tests`, как прежде (G13).
  projectTestRuns.setLayerCarry(() => carryOfTestsRoute(runRoute('tests')));
  projectTestRuns.setLanguage(() => (ctx.store.getSettings().language === 'en' ? 'en' : 'ru'));
  const events = createEventHub();
  // Список D-n изменился — значок «Ждёт решения», хаб групп и телефон
  // перечитывают его сразу, а не на следующем опросе.
  deferredAsksOf(ctx).onChanged(() => events.broadcast(['chat-deferred', 'chat-tree'], ''));
  // Папки e2e проектов реестра — под тем же тумблером, что и конфиги. Сверка
  // ждёт, пока проект держит прогон агента или идут автотесты. Оба реестра
  // находят проект в любом написании пути: корни здесь — как в реестре проектов.
  const e2eWatch = createE2eWatch({
    roots: () =>
      ctx.store.getSettings().watchFiles
        ? ctx.store.getProjects().map((project) => project.path)
        : [],
    isBusy: projectTestsBusy(projectTestRuns, e2eRuns),
    appData: ctx.location.paths.appData,
    broadcast: (domains, path) => events.broadcast(domains, path),
    log: (message, error) => console.warn(message, error),
  });
  const panelPending = new PanelPendingActions(PANEL_ACTION_CONFIRM_TIMEOUT_MS);

  /**
   * Журнал идущих прогонов на диске и усыновление живых после перезапуска.
   *
   * `node --watch` на Windows убивает сервер без обработчиков (`shutdown` ниже
   * не срабатывает), и процессы CLI живут дальше сиротами. Раньше их запросы
   * прав встречали пустой реестр — «Разговор не найден» на каждый вызов. Теперь
   * реестр пишет каждый прогон в `<appData>/runs.json`, а здесь, когда ВСЕ
   * крючки уже стоят (уведомления, планировщик), подхватывает те, чей процесс
   * жив: место в реестре, карточка прав, «Остановить» — без потока вывода.
   * Тумблеры автоподтверждения возвращаются из снимка в журнале: без них
   * усыновлённый прогон спрашивал бы о каждом вызове. Мёртвое вычищается.
   */
  const runLedger = new RunLedger(ctx.location.paths.appData);
  chatRuns.setLedger(runLedger, (key) => chatSession.snapshotForLedger(key));
  // Ответ усыновлённого прогона: потока у него нет, но текст лежит в транскрипте
  // Claude Code. Каталог считается на каждое чтение — он меняется на лету
  // (`ctx.relocate`), и запомненный путь читал бы прежнюю папку до перезапуска.
  chatRuns.setClosingTurnReader((chatId, sessionId) =>
    readLastAssistantTurn(projectsDir(ctx), sessionId ?? chatId),
  );
  const { adopt, drop } = adoptableEntries(runLedger.read(), {
    isAlive: isPidAlive,
    looksLikeCli: pidLooksLikeCli,
  });
  for (const entry of drop) runLedger.remove(entry.key);
  // Ход агента панели усыновлять некуда — его ответ читал закрытый поток. Живой
  // процесс агента от прошлого запуска панели снимается, иначе он поднимал бы
  // карточки для разговора, которого уже никто не видит.
  reapPanelAgentOrphans(ctx.location.paths.appData);
  // То же с CLI агентского прогона тестов: реестр в памяти, а сирота висел бы до
  // суток на мёртвом приёмнике прав, пока история пишет «остановился».
  reapProjectTestOrphans(ctx.location.paths.appData);
  for (const entry of adopt) {
    if (entry.autoApprove) chatSession.armAutoApprove(entry.key, entry.autoApprove);
    if (!chatRuns.adopt(entry)) runLedger.remove(entry.key);
  }

  // Спавненные dev-серверы проектов, CLI чатов и прогоны тестов живут в памяти
  // процесса. Гасим их при выходе, чтобы дочерние процессы не осиротели и не
  // держали занятыми порты.
  // Пути читаются на каждый вызов: каталог конфигурации меняется на лету.
  const globalLayer = createGlobalLayer({
    read: () => ({
      configRoot: ctx.location.paths.root,
      appData: ctx.location.paths.appData,
      backupDir: ctx.store.backupDir,
    }),
    onChange: () => events.broadcast(['globalLayer'], ''),
  });

  // Надзор за процессом ядра — шов зоны core-supervisor (`core-supervisor-wiring.ts`).
  const coreSupervisor = wireCoreSupervisor({ appData: ctx.location.paths.appData });
  // Слой панели разговору чужого CLI через ядро (G6) — и продолжению, и старту из веба (G13).
  const foreignCarry = createForeignCarry({
    testsNote: (cwd) => testsChatNote(testsChatDeps, cwd),
    kitExtras: (input) => kit.runExtras(input),
  });
  const shutdown = (): void => {
    // Чаты Claude — НЕ гасим: CLI за посредником переживает перезапуск панели
    // вместе с фоновыми командами, и новый сервер подключается к нему по журналу
    // (решение W3-4a). Гаснет только то, что без сервера не живёт; остановить
    // всех — действие человека, а не побочный эффект Ctrl+C или сторожа.
    chatRuns.detachAll();
    projectRunner.stopAll();
    projectTestRuns.stopAll();
    projectTestManual.stopAll(new Date().toISOString());
    e2eRuns.stopAll();
    mutationChecks.stopAll();
    e2eWatch.close();
    // Учёт расхода ведёт звено ядра (C3b): здесь гаснут опрос и пересылка порогов.
    budgetRelay.stop();
    void contours.stop();
    // Фоновая проба тоже гаснет: таймер с `unref` выход не задерживает, но
    // проба, начатая в секунду закрытия, дописала бы `state.json` уже после
    // того, как его сохранил кто-то другой.
    platformWatch.stop();
    // Ждущие карточки агента — ответить отменой: иначе запрос переходника висит
    // до таймаута уже мёртвого процесса.
    panelPending.cancelAll();
    // Локальные модели: загрузки, опрос прогона, запрет сна (`local-models-wiring.ts`).
    localModelsWiring.stop();
    coreSupervisor.stop();
    // Пересылка вопросов ядра: таймер и потоки снимаются, курсор дописывается синхронно — выход
    // по сигналу идёт сразу за `shutdown`, асинхронный хвост `stop` он не ждёт.
    void coreRelay?.stop();
  };

  // Одни ручки ядра на разговоры, что заводит сервер, и на историю разговоров чужого CLI.
  const coreCaller = createCoreCaller(() => coreHomeOf());
  const coreChatPort = createCoreChatPort(coreCaller);
  // Сеансы шагов задач ядра — не разговоры человека: списки чатов их прячут.
  const coreStepSessions = createCoreStepSessions({
    tasks: coreTaskListOver(coreCaller.call),
    view: (taskId) => coreChatPort.view(taskId),
  });

  return {
    projectRunner,
    chatRuns,
    chatSession,
    projectTestRuns,
    projectTestManual,
    e2eRuns,
    mutationChecks,
    e2eWatch,
    notifyRun,
    telegramAnswersCover,
    chatTitle: (chatId) => chatTitleOf(ctx, chatRuns, chatId),
    outsideTurnEnded,
    handoffChains,
    treePause,
    pendingAsks,
    coreHistory: createCoreChatHistory(
      coreChatPort,
      () => coreChatBookPath(ctx.location.paths.appData),
      coreStepSessions,
    ),
    foreignCarry,
    dlpProxy,
    platformGateway,
    contours,
    contourPush,
    platformWatch,
    events,
    panelPending,
    selfBaseUrl,
    localModels,
    coreSupervisor,
    keepAwake,
    globalLayer,
    kit,
    runRoute: (origin) => runRoute(origin),
    gatewayPort: platformRouting.gatewayPort,
    claudeSettingsRoute: platformRouting.claudeSettingsRoute,
    localMcpPicks: platformRouting.localMcpPicks,
    shutdown,
  };
}

/** Гасить процессы и на обычном выходе, и по сигналу — иначе Ctrl+C оставляет сирот. */
export function installShutdownHandlers(runtime: Runtime): void {
  process.on('exit', runtime.shutdown);
  process.on('SIGINT', () => {
    runtime.shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    runtime.shutdown();
    process.exit(0);
  });
}
