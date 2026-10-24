import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appRootDir } from '../../domains/watcher/report.ts';
import { heavyQueueDir } from '../../domains/group-progress/heavy-wait.ts';
import { createLocalModels, type LocalModels } from '../../domains/local-models/service.ts';
import { runLocalFullLayer } from '../../domains/local-models/full-layer.ts';
import { createLocalMcpSource } from '../../domains/local-models/mcp-source.ts';
import {
  bashCeilingsAt,
  chatRunProfile,
  foreignGroupMcp,
  groupCompactWindow,
  groupRunProfile,
  statusRunProfile,
  type ProfileMcpEntry,
  type SkillScopeInput,
} from '../../domains/chat/group-profile/group-profile.ts';
import { shellSnapshotSync, snapshotNames } from '../../domains/chat/shell-aliases.ts';
import { groupMarkEnv, groupProcessMark } from '../../domains/chat/group-process-owner.ts';
import { stageOf, stagesAhead } from '../../domains/chat/ChatCascadeStages/ChatCascadeStages.ts';
import {
  runCompactWindow,
  settingsCompactWindow,
} from '../../domains/chat/group-continuation/group-continuation.ts';
import {
  releaseSessionLeases,
  writeHeavyQueueConfig,
} from '../../domains/chat/heavy-queue-leases/heavy-queue-leases.ts';
import { StatusChats, briefWithStatus } from '../../domains/chat/status-chats/status-chats.ts';
import { readSkills } from '../../domains/skills/read.ts';
import {
  childRunEnv,
  heavySlots,
  type RunOptions,
} from '../../domains/chat/ChatRunner/ChatRunner.ts';
import { createRunSync } from '../../domains/local-models/run-sync.ts';
import { createKeepAwake, type KeepAwake } from '../../lib/keep-awake/keep-awake.ts';
import { machineId } from '../../lib/machine-identity/machine-identity.ts';
import { readEnvLookup } from '../../domains/env/env.ts';
import { readJsonFile } from '../../lib/safe-io/safe-io.ts';
import { createGlobalLayer, type GlobalLayer } from '../../domains/global-layer/service.ts';
import type { ProjectTestRun } from '@agentdeck/contracts';
import { liveNaIds, type SieveReportRow, type SieveStage } from '@agentdeck/contracts/sieves';
import type { SplitGroupRechecked, SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import type { ChatLink, SplitPlanGroupRecord } from '../../lib/app-store/app-store.types.ts';
import type { ServerContext } from '../../context.ts';
import type { ChatEvent } from '../../domains/chat/chat-events.ts';
import { localizeText, serverText } from '../../lib/server-texts/server-texts.ts';
import {
  ChatRunRegistry,
  type RunFinished,
  type RunNotice,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { appendLoweredRun } from '../../domains/chat/lowered-journal/lowered-journal.ts';
import { appendLimitRun } from '../../domains/chat/limit-journal/limit-journal.ts';
import { UNUSED_HEAVY_TOOLS } from '../../domains/chat/initiative/initiative.ts';
import { localLayerRun } from '../../domains/local-layer/local-layer.ts';
import { appendRunInput, moveRunInputs } from '../../domains/chat/run-input/run-input.ts';
import {
  adoptableEntries,
  isPidAlive,
  pidLooksLikeCli,
  RunLedger,
} from '../../domains/chat/run-ledger/run-ledger.ts';
import { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { HandoffChains, HandoffChainStore } from '../../domains/chat/ChatHandoff/ChatHandoff.ts';
import { rootOf, TreePause } from '../../domains/chat/tree-pause/tree-pause.ts';
import type { BackgroundWatcher } from '../../domains/watcher/watcher.ts';
import { createBackgroundWatcher } from '../watcher/watcher.ts';
import {
  hasParentLink,
  lastAskedInput,
  PENDING_ASKS_FILE,
  wirePendingAsks,
  type PendingAsks,
} from '../../domains/chat/pending-asks/pending-asks.ts';
import { createTreeRuns } from '../../domains/chat/tree-runs/tree-runs.ts';
import { createParentNotice } from '../../domains/chat/parent-notice/parent-notice.ts';
import { wireChatAutonomy } from '../chat-autonomy-wiring.ts';
import { apiTokenPath } from '../../lib/api-token/api-token.ts';
import { wireGroupActivation } from '../group-activation-wiring/group-activation-wiring.ts';
import { wireForeignShellJudge } from '../foreign-shell-judge-wiring/foreign-shell-judge-wiring.ts';
import { wireColdContinuation } from '../cold-continuation-wiring/cold-continuation-wiring.ts';
import { wireKeepWarm } from '../keep-warm-wiring/keep-warm-wiring.ts';
import { createKeepWarmLedgerReader, warmedAtOf } from '../../domains/chat/keep-warm/keep-warm.ts';
import {
  appendMessage,
  chatTranscriptPath,
  createForeignStagePlanner,
  foreignChatPrefix,
  readChat,
  readChatCascade,
  ProviderChatService,
} from '../../domains/provider-chat/provider-chat.ts';
import { panelSupervisorHooks } from '../../domains/portability/supervisor/panel-hooks.ts';
import {
  DEFAULT_PROVIDER_ID,
  getProvider,
  isKnownProviderId,
  listProviders,
} from '../../providers/registry.ts';
import { foreignProviderId } from '@agentdeck/contracts/platform-consumers';
import { foreignDeliverContourRoute } from './foreign-deliver-route.ts';
import { KitService } from '../../domains/kit/service.ts';
import { CODEX_MCP_OFF_ENV, kitComposeRefusal } from '../../domains/kit/codex.ts';
import { economyRunEnv } from '../../domains/provider-chat/economy-run/economy-run.ts';
import { ownLocalEndpoint } from '../../domains/provider-chat/own-endpoint/own-endpoint.ts';
import { readPlatforms } from '../../domains/platform/store/store.ts';
import {
  writeQwenMcpExcluded,
  writeQwenQuietRun,
} from '../../domains/provider-chat/system-note/system-note.ts';
import {
  readProviderMcpServers,
  resolveProviderMcpTargetFor,
} from '../../domains/provider-mcp/provider-mcp.ts';
import { codexHome } from '../../providers/catalog/config-dirs.ts';
import { LOCAL_PLATFORM_ID } from '../../domains/local-models/connect.ts';
import { AutoContinue, continueNotice } from '../../domains/chat/auto-continue/auto-continue.ts';
import { CLAUDE_SWITCH_SETTING } from '../../domains/local-models/claude-switch.ts';
import { localPaths, readState as readLocalState } from '../../domains/local-models/paths.ts';
import {
  listRunnerTargets,
  ProjectRunnerRegistry,
} from '../../domains/project-runner/project-runner.ts';
import { normalizePath } from '../../domains/project-runner/targets.ts';
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
import { DlpProxy } from '../../domains/dlp/dlp.ts';
import { PlatformGateway } from '../../domains/platform/gateway/listener/listener.ts';
import { gatewayPricing } from '../../domains/platform/spend/spend.ts';
import { GatewayAutoStart } from '../../domains/platform/gateway/auto-start/auto-start.ts';
import { PlatformWatch } from '../../domains/platform/watch/watch.ts';
import { summarizedInRun } from '../../domains/platform/gateway/summarized-ledger/summarized-ledger.ts';
import { ToolGateRegistry } from '../../domains/portability/wire/tool-gate.ts';
import {
  localClaudeRun,
  resolveRunRoute,
  runRouteOf,
  type PlatformRoutingDeps,
  type PlatformRunRoute,
} from '../../domains/platform/routing/routing.ts';
import { createRunNotifier } from '../../domains/remote-notify.ts';
import {
  createTelegramNotifier,
  type GroupSignalNotice,
  type TelegramNotice,
} from '../../domains/notify/telegram.ts';
import { wireGroupWatch } from '../group-watch-wiring/group-watch-wiring.ts';
import { createWebhookNotifier } from '../../domains/notify/webhook.ts';
import { activateAtlassianMcp } from '../../domains/integrations/mcp-server/mcp-server.ts';
import {
  hasWorkSince,
  missingDelivery,
  mrDescriptionGap,
  readBranchFiles,
  readTargetMoved,
  readWorktreeHead,
  readDeliveryFacts,
  readMergeTarget,
  readReviewDelta,
  resolveProjectDelivery,
} from '../../domains/project-git/project-git.ts';
import { readLastAssistantTurn } from '../../domains/chat/ChatHistory/ChatHistory.ts';
import { groupChatIds, groupTokenLedger } from '../../domains/chat/token-ledger/group-ledger.ts';
import {
  STALL_POLL_MS,
  createSplitStallWatch,
  transcriptActivity,
} from '../../domains/chat/split-stall/split-stall.ts';
import { writeStallLog } from '../../domains/chat/split-stall/stall-diagnostic.ts';
import { createHandoffPlanner } from '../../routes/chat/handoff-routes.ts';
import { projectsDir } from '../../routes/chat/paths.ts';
import { syncRelayHooks } from '../../routes/chat/outside-relay-routes/outside-relay-routes.ts';
import {
  atlassianTaskTracker,
  atlassianTicketSource,
  atlassianTicketTracker,
} from '../../domains/chat/split-ticket-tracker.ts';
import { closeReviewGroup } from '../../domains/chat/review-close/review-close.ts';
import {
  prepareReviewStand,
  removeReviewStand,
  sweepStaleReviewStands,
} from '../../domains/chat/review-stand/review-stand.ts';
import { execDocker } from '../../domains/compose/docker.ts';
import { copyRootOf, SplitConveyor } from '../../domains/chat/split-conveyor/split-conveyor.ts';
import { MrWatch, reviewThreadsGap } from '../../domains/chat/mr-watch/mr-watch.ts';
import { MrStateRefresh } from '../../domains/chat/mr-state-refresh/mr-state-refresh.ts';
import { recheckDeliveredMr } from '../../domains/chat/split-recheck/split-recheck.ts';
import {
  createRecheckSession,
  readRecheckScope,
} from '../../domains/chat/split-recheck/recheck-session.ts';
import { createDeliverStageSession } from '../../domains/chat/split-deliver-stage/deliver-stage.ts';
import { SieveStore } from '../../domains/chat/sieve-store/sieve-store.ts';
import { sieveDeliveryGaps, sievePrompt } from '../../domains/chat/sieve-gate/sieve-gate.ts';
import { testsDeliveryGaps } from '../../domains/chat/tests-gate/tests-gate.ts';
import { readMergeRequestReview } from '../../domains/integrations/mr-review/mr-review.ts';
import { readMergeRequestStates } from '../../domains/integrations/mr-state/mr-state.ts';
import { childrenBrief } from '../../domains/chat/children-brief/children-brief.ts';
import { branchGateContext } from '../../domains/chat/ChatBranchGate/ChatBranchGate.ts';
import { ChildTells } from '../../domains/chat/child-tell/child-tell.ts';
import { scheduleDeferredReDrive, wireDeferredAsks } from '../deferred-wiring/deferred-wiring.ts';
import { rejudgeDepsFor, rejudgeGroupAsk } from '../deferred-wiring/rejudge.ts';
import { deferredAsksOf } from '../../routes/chat/deferred-routes/deferred-store.ts';
import {
  RunRetry,
  retriesLink,
  retryForeignRun,
  retryOutcome,
} from '../../domains/chat/run-retry/run-retry.ts';
import {
  pausedGroupOf,
  pauseOnForeignStop,
  pauseOnHumanStop,
  sweepGroupCopies,
  treePausedGroupOf,
} from '../../routes/chat/split-control-routes.ts';
import {
  continueOnBackgroundLost,
  interruptOnBackgroundLost,
} from '../../domains/chat/background-lost.ts';
import { SplitOverlap } from '../../domains/chat/split-overlap/split-overlap.ts';
import { SplitReview } from '../../domains/chat/split-review/split-review.ts';
import { createSplitLauncher, launchFromRecord } from '../../routes/chat/split-launch.ts';
import {
  commentMergeRequestByUrl,
  parseMergeRequestUrl,
  readMergeRequestByUrl,
  retryMergeRequestJob,
} from '../../domains/integrations/forge.ts';
import { readIntegrations, readToken } from '../../domains/integrations/store/store.ts';
import { forgeTokenForUrl } from '../../domains/integrations/forge-pick.ts';
import {
  carriedLink,
  conversationKeys,
  unbornResumeTarget,
} from '../../lib/app-store/chat-links.ts';
import { createEventHub, type EventHub } from '../../lib/event-hub/event-hub.ts';
import { PANEL_ACTION_CONFIRM_TIMEOUT_MS } from '@agentdeck/contracts/panel-agent';
import { foreignChatKey, parseForeignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import { PanelPendingActions } from '../../domains/panel-agent/pending/pending.ts';
import {
  PanelAgentProcesses,
  reapPanelAgentOrphans,
} from '../../domains/panel-agent/processes/processes.ts';
import {
  OPENCODE_SERVE_PROCESS_LEDGER,
  opencodeServe,
} from '../../domains/opencode-serve/opencode-serve.ts';
import {
  chatKnobsLine,
  foreignChildExtra,
  runPathSteps,
} from '../../domains/chat/group-run-lines/group-run-lines.ts';
import { storeTreeReader } from '../../domains/chat/chat-autonomy/chat-autonomy.ts';
import {
  effectiveGroupsForRun,
  triageGroupCatalog,
} from '../../domains/chat/group-auto-pick/group-auto-pick.ts';
import { readChoice } from '../../domains/groups/choice/choice.ts';
import {
  projectTestsBusy,
  reconcileProjectSuites,
  reconcileProjectTurnHooks,
  wireTestsChatNote,
} from '../tests-chat-wiring/tests-chat-wiring.ts';
import { ActivatingTestRunRegistry } from '../activating-test-runs/activating-test-runs.ts';
import { createReviewStarter } from '../../routes/chat/review-starter.ts';
import { coldResumeBrief, lostConversationBrief } from '../../domains/chat/split-continue.ts';
import { withStageTask } from '../../domains/chat/cold-continuation/cold-continuation.ts';
import { createForeignColdPlan } from '../../domains/chat/cold-continuation/foreign-cold-plan.ts';
import { activateLedger } from '../../domains/verify-ledger/verify-ledger.ts';
import type { LedgerInstall } from '../../domains/verify-ledger/verify-ledger.types.ts';

/**
 * Объекты, живущие дольше запроса. Создаются при сборке приложения — только
 * оттуда их можно погасить при выходе — и подаются маршрутам замыканием
 * (см. `route-table.ts`), а не заводятся модулем маршрутов самостоятельно:
 * реестр, до которого никто снаружи не дотянется, при выходе осиротит свои
 * процессы.
 */

/** CLI блока «Тесты»: им группа записывает прогон в блок своей копии. */
const TESTS_CLI = fileURLToPath(new URL('../../../../../tools/tests-cli.mjs', import.meta.url));

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
  /** Цепочки продолжений в чистой сессии. */
  handoffChains: HandoffChains;
  /** Пауза дерева разговоров; маршруты дерева и разделения берут её отсюда. */
  treePause: TreePause;
  /** Записанные вопросы деревьев; отмена плана разделения снимает вопросы групп. */
  pendingAsks: PendingAsks;
  /** Чаты чужих CLI. */
  providerChats: ProviderChatService;
  /** Конвейер уровней разделения (Т1): разбор → план → работа, ожидания между группами. */
  splitConveyor: SplitConveyor;
  /** Лёгкие чаты вопросов о ходе групп (5.1): какой чат о каком разделении. */
  statusChats: StatusChats;
  splitOverlap: SplitOverlap;
  /** Ревью MR по ссылке (Т7): решение человека и его исполнение. */
  splitReview: SplitReview;
  /** «Перепроверить MR» доставленной группы: чтение MR форджем и слово группе. */
  recheckMr: (parentChatId: string, index: number) => Promise<SplitGroupRechecked>;
  /** План разделения для пульта; чтение будит проверку «влит ли MR» (`mr-state-refresh.ts`). */
  splitView: (chatIds: string[]) => SplitPlanView | undefined;
  /** Прокси защиты данных; поднимается отдельно, если включён в настройках. */
  dlpProxy: DlpProxy;
  /** Шлюз контуров: тот же порядок — создаётся всегда, поднимается по настройке. */
  platformGateway: PlatformGateway;
  /**
   * Подъём своего шлюза, когда тумблер уже включён, а слушателя нет (A-1).
   * Защёлка и потолок попыток живут здесь, а не у каждого, кому шлюз понадобился.
   */
  platformGatewayAutoStart: GatewayAutoStart;
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
  /** Фоновый наблюдатель: тумблер, кольцо сбоев, разбор моделью, отчёт. */
  watcher: BackgroundWatcher;
  /** Локальные модели: железо, сервер моделей, загрузки с прогрессом. */
  localModels: LocalModels;
  /** Запрет на сон на время локального прогона: экран питания телефона спрашивает и снимает. */
  keepAwake: KeepAwake;
  /** Сверка панели с глобальным слоем `~/.claude` (В5): пары, вердикт, перенос. */
  globalLayer: GlobalLayer;
  /** Встроенный набор панели (В2): режимы по CLI, копии «моё», что получает прогон. */
  kit: KitService;
  /** Журнал проверок: установленный preload (или почему его нет) — для сводки. */
  verifyLedger: LedgerInstall;
  /**
   * Маршрут прогона по потребителю (`foreign:<cli>`, `tests`, …) — тот же, что
   * спрашивают чат и тесты. Нужен лёгкому окну панели (помощники формы и
   * структуры): без него окно чужого CLI ушло бы мимо контура.
   */
  runRoute: (origin: string) => PlatformRunRoute;
  /** Порт живого шлюза контуров; 0 — не поднят. */
  gatewayPort: () => number;
  /** Куда уведён сам Claude настройкой settings.json — для шапки чата. */
  claudeSettingsRoute: PlatformRoutingDeps['claudeSettingsRoute'];
  /** Выбор MCP локального прогона проекта — для подписи шапки чата. */
  localMcpPicks: PlatformRoutingDeps['localMcpPicks'];
  /** Окружение этого переключателя — лёгкому окну, которое settings.json не читает. */
  claudeSwitchEnv: () => Record<string, string>;
  /** Погасить всё, что спавнит процессы. Идемпотентно. */
  shutdown: () => void;
}

/** Как часто смотрим, идёт ли локальный прогон: запрет сна и отложенный перезапуск. */
const LOCAL_RUN_POLL_MS = 5_000;

// Маршрут дешёвой доставки чужой группы живёт рядом, отдельным модулем; путь
// импорта `runtime.ts` у него прежний.
export { foreignDeliverContourRoute };

/**
 * Свой срок остывания кэша чужого CLI для живой проверки
 * (`AGENTDECK_FOREIGN_COLD_AFTER_MS`); нет — срок провайдера. Один на решение
 * «начать новую сессию» и сигнал сторожа R2.
 */
function foreignColdAfterMsEnv(): number | undefined {
  const raw = Number(process.env.AGENTDECK_FOREIGN_COLD_AFTER_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

export function createRuntime(ctx: ServerContext, selfBaseUrl: string): Runtime {
  // Журнал проверок (стадия 0 — тень): preload уходит в окружение самой панели
  // и оттуда — каждому её запуску.
  const verifyLedger = activateLedger(
    ctx.location.paths.appData,
    fileURLToPath(new URL('../../../../../tools/verify-ledger', import.meta.url)),
  );
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
  const chatRuns = new ChatRunRegistry();
  /**
   * Права и автоподтверждение чатов — один объект на сервер, а не на маршрут:
   * продолжение в чистой сессии заводит прогон мимо маршрута отправки, и
   * тумблеры закрытого разговора должны достаться новому. Тумблеры лежат и на
   * диске: родитель без прогона после перезапуска отдаёт их детям разделения.
   */
  const chatSession = new ChatSession(chatRuns, ctx.location.paths.appData);
  // Лёгкие чаты вопросов о ходе групп (5.1) переживают и смену ключа, и перезапуск.
  const statusChats = new StatusChats(join(ctx.location.paths.appData, 'status-chats.json'));
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
  /**
   * Уведомления на телефон. Реестр прогонов знает, ЧТО случилось, но не знает ни
   * про устройства, ни про настройку — поэтому отправитель собирается здесь и
   * подаётся реестру тем же приёмом, что и оценка стоимости шага.
   */
  const notifyRun = createRunNotifier({
    isEnabled: () => ctx.store.getSettings().remoteAccess.notify,
    devices: () => ctx.store.getPushDevices(),
    forget: (token) => ctx.store.removePushDevice(token),
    machineId: () => machineId(),
  });
  /**
   * Второй адресат тех же событий — Telegram.
   *
   * Push от Expo приходит в ПРИЛОЖЕНИЕ панели, и его видит только тот, у кого
   * оно установлено и спарено. Telegram получает и владелец без приложения, и
   * общий чат команды. Наружу уходит ровно заголовок — вид события и имя папки
   * проекта, — как и в push: содержимому разговора незачем покидать машину.
   */
  const telegram = createTelegramNotifier({
    settings: () => ctx.store.getSettings().integrations.telegram,
    token: () => readToken(ctx.location.paths.appData, 'telegram'),
  });
  /**
   * Третий адресат — вебхук: тот же заголовок, но своим адресом. Он закрывает
   * всё, чего нет у первых двух: Slack, Mattermost, дежурного бота, внутреннюю
   * шину. Подписка у него собственная, поэтому молчащий Telegram не означает
   * молчащий вебхук.
   */
  const webhook = createWebhookNotifier({
    settings: () => ctx.store.getSettings().integrations.webhook,
    secret: () => readToken(ctx.location.paths.appData, 'webhook'),
  });
  const notifyBoth = (notice: RunNotice): void => {
    notifyRun(notice);
    telegram(notice);
    webhook(notice);
  };
  chatRuns.setNotifier(notifyBoth);
  /**
   * Прогон тестов уведомляет тем же отправителем: он идёт десятки минут, и
   * сидеть перед панелью всё это время незачем.
   *
   * Для Telegram у него есть СВОЙ повод — «тесты провалены». Реестр о нём не
   * знает и знать не должен: он сообщает «прогон кончился», а провалы лежат в
   * итоге прогона, который он же и посчитал. Пересобирается это здесь, потому
   * что подписка на события — вопрос настройки, а не работы реестра.
   */
  projectTestRuns.setNotifier((notice) => {
    notifyRun(notice);
    const outward = testNotice(notice, projectTestRuns.get(notice.projectPath ?? ''));
    telegram(outward);
    webhook(outward);
  });
  /**
   * Дерево чатов переживает смену ключа. Разделение заводит чат под временным
   * `new-<ts>-<n>`, а настоящий `sessionId` Claude Code выдаёт уже в прогоне —
   * и в списке чат появляется под ним. Без переноса связи ветвь дерева обрывалась
   * бы ровно в момент, когда чат становится настоящим.
   */
  chatRuns.setSessionListener((chatId, sessionId, from) => {
    ctx.store.linkChatSession(chatId, sessionId, from);
    statusChats.alias(chatId, sessionId);
    // Вход первого хода записан под временным ключом — едет за настоящим (U8).
    try {
      moveRunInputs(ctx.location.paths.appData, chatId, sessionId);
    } catch {
      // Сверка входа не главнее связи разговора.
    }
  });
  // Ребёнок разделения — у кого есть связь с родителем (Д16, Д18).
  chatRuns.setChildResolver((keys) =>
    keys.some((key) => Boolean(ctx.store.getChatLink(key)?.parentChatId)),
  );
  // Остывшую сессию группы не продолжать ни на одном пути (F-05 ревью П1).
  wireColdContinuation(chatRuns, {
    store: ctx.store,
    projectsDir: () => projectsDir(ctx),
    // Согретая пингом сессия — тёплая, хоть файл её и не менялся (`keep-warm`).
    warmedAt: (sessionId) => warmedAtOf(ctx.location.paths.appData, sessionId),
  });
  // Родитель разделения видит своих детей в начале каждого хода (Д6), лёгкий
  // чат вопросов о ходе — группы своего разделения (5.1). Конвейер заводится
  // ниже — к первому старту прогона он уже есть.
  chatRuns.setChildrenBriefResolver(
    briefWithStatus((keys) => splitConveyor.view(keys), statusChats),
  );
  // Ворота первой правки родителя знают о детях и о ветке MR (Д15).
  chatRuns.setBranchGateContextResolver((keys) =>
    branchGateContext(splitConveyor.view(keys), (chatId) => ctx.store.getChatLink(chatId)?.review),
  );
  chatRuns.setFirstEditListener((keys, at) => ctx.store.markChatFirstEdit(keys, at));
  // Локальный слой проекта (`.agent/local-layer/`): сломанный слой не мешает
  // чату — прогон идёт на командном слое, как без него.
  // Тяжёлые неиспользуемые схемы (Artifact, Workflow, ScheduleWakeup) — флагом каждому прогону Claude.
  chatRuns.setDeniedToolsResolver(() =>
    ctx.store.getSettings().chatLeanTools ? UNUSED_HEAVY_TOOLS : [],
  );
  chatRuns.setLocalLayerResolver((cwd) => {
    try {
      return localLayerRun(cwd);
    } catch {
      return undefined;
    }
  });
  /**
   * Журнал понижённых прогонов: чем вели и видела ли панель проверки. Путь до
   * каталога данных знает bootstrap, а не реестр, — тем же приёмом, что и
   * уведомления.
   */
  chatRuns.setLoweredJournal((record) => appendLoweredRun(ctx.location.paths.appData, record));
  chatRuns.setLimitJournal((record) => appendLimitRun(ctx.location.paths.appData, record));
  // «Что получил агент» (U8): под настоящим ключом, если он уже известен.
  chatRuns.setInputJournal((keys, record) =>
    appendRunInput(ctx.location.paths.appData, keys.at(-1) ?? '', record),
  );
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
  // Ревью по ссылке (Т7) собирается ниже — ему нужны и пауза дерева (прогон
  // правок откладывается ею), и запуск прогонов. Ссылка вперёд именно поэтому:
  // узел дерева спрашивает карточку у домена, а домен к тому моменту уже есть.
  const splitReviewRef: { current?: SplitReview } = {};
  // Заводится ДО дерева: его прогоны входят в дерево переходником
  // (`createTreeRuns`), а не отдельным деревом.
  const providerChats = new ProviderChatService();
  // Чат чужого CLI сообщает о конце хода тем же отправителем, что и Claude.
  providerChats.setNotifier(notifyBoth);
  // Прогоны дерева у любого провайдера: реализация выбирается по КЛЮЧУ связи —
  // именованный (`codex:c1a2…`) ведёт к чужому чату, обычный к реестру. Тем же
  // переходником повторяет упавшие ходы надзор (Д10).
  const treeRuns = createTreeRuns({
    registry: chatRuns,
    chats: providerChats,
    appDataDir: () => ctx.location.paths.appData,
    provider: (id) =>
      id !== DEFAULT_PROVIDER_ID && isKnownProviderId(id) ? getProvider(id) : undefined,
    models: (provider) => ctx.models.current(provider.modelVendors ?? []).models,
    // Дописка продолженного прогона собирается заново по шапке разговора: она
    // нигде не хранится, а без неё продолжённая после паузы работа поехала бы
    // без инициатив панели и без планки сдачи (Т5).
    systemPrefix: (providerId, chatId) =>
      foreignChatPrefix(
        readChatCascade(ctx.location.paths.appData, providerId, chatId),
        ctx.store.getSettings(),
        foreignChildExtra(
          ctx.store,
          ctx.location.paths.appData,
          foreignChatKey(providerId, chatId),
        ),
      ) || undefined,
  });
  // Вопросы и запросы прав разговоров дерева — на сервере, а не во вкладке (WP9c).
  const pendingAsks = wirePendingAsks(chatRuns, {
    file: join(ctx.location.paths.appData, PENDING_ASKS_FILE),
    isTreeChat: hasParentLink((key) => ctx.store.getChatLink(key)),
    readAsked: (chatId, sessionId) => lastAskedInput(projectsDir(ctx), sessionId ?? chatId),
  });
  // Сторож групп (фаза 2, W): правила по живому потоку звеньев вместо агента-наблюдателя.
  const groupWatcher = wireGroupWatch(chatRuns, {
    settings: () => ctx.store.getSettings().groupWatch,
    link: (chatId) => ctx.store.getChatLink(chatId),
    plan: (parentChatId) => ctx.store.getSplitPlan(parentChatId),
    plans: () => ctx.store.getSplitPlans(),
    // Свой срез хранилища (F-42): запись конвейера, собранная до `await`, сигналов не сотрёт.
    signals: {
      get: (parentChatId, groupIndex) => ctx.store.getGroupWatchSignals(parentChatId, groupIndex),
      set: (parentChatId, groupIndex, record) =>
        ctx.store.putGroupWatchSignals(parentChatId, groupIndex, record),
      all: () => ctx.store.getAllGroupWatchSignals(),
      save: () => ctx.store.saveGroupWatchSignals(),
    },
    asksOf: (keys) => pendingAsks.of(keys, (runId) => chatRuns.isRunning(runId)),
    // Группа ждёт решения по D-n — стоит законно, R22 о ней молчит.
    deferredWaiting: (parentChatId, groupIndex) =>
      deferredAsksOf(ctx).waiting({ kind: 'group', parentChatId, groupIndex }).length > 0,
    projectsDir: () => projectsDir(ctx),
    heavyQueueDir: heavyQueueDir(ctx.location.paths.appData),
    notify: (signal, target) => {
      // Одиночный чат: плана нет, проект — каталог его прогона.
      const projectPath =
        target.scope === 'chat'
          ? target.cwd
          : ctx.store.getSplitPlan(target.parentChatId)?.projectPath;
      // Подписка — событие `groupSignal` в списках Telegram и вебхука, как у остальных событий.
      const notice: GroupSignalNotice = {
        kind: 'groupSignal',
        rule: signal.rule,
        severity: signal.severity,
        numbers: signal.numbers,
        ...(target.stage ? { stage: target.stage } : {}),
        ...(projectPath ? { projectPath } : {}),
      };
      telegram(notice);
      webhook(notice);
    },
    canonical: (chatId) => ctx.store.canonicalChatKey(chatId),
    appDataDir: ctx.location.paths.appData,
    // R2 у чужого CLI — тем же сроком остывания, что решение «начать новую сессию».
    foreignColdAfterMs: foreignColdAfterMsEnv,
    // `events` заводится ниже по сборке; сторож зовёт это только после старта, когда он уже есть.
    changed: (parentChatId) => events.broadcast(['chat-tree'], parentChatId),
    // Одиночные чаты (A1): свой срез, своя рассылка строке чата и шапке.
    chatSignals: {
      get: (chatId) => ctx.store.getChatWatchSignals(chatId),
      set: (chatId, record) => ctx.store.putChatWatchSignals(chatId, record),
      all: () => ctx.store.getAllChatWatchSignals(),
    },
    chatChanged: (chatId) => events.broadcast(['chat-signals'], chatId),
    // Вопрос о ходе групп — служебный чат панели, не разговор человека.
    internal: (keys) => statusChats.parentOf(keys) !== undefined,
    links: () => ctx.store.getChatLinks(),
    // `treePause` заводится ниже; до него тик не доходит (первый — через минуту).
    treePaused: (chatId) => treePause.isPaused(chatId),
    // Время паузы — из записи дерева (F-54): действия между нажатием и первым тиком — тоже R20.
    treePausedAt: (chatId) => {
      const at = ctx.store.getTreePause(rootOf(ctx.store.getChatLinks(), chatId))?.at;
      return at ? Date.parse(at) : undefined;
    },
    log: (message, error) => console.warn(message, error),
  });
  // Пинг тёплого кэша ждущих групп (X2, 22.10): тем же путём сборки, что их ход.
  const keepWarm = wireKeepWarm(chatRuns, {
    economy: () => ctx.store.getSettings().groupEconomy,
    coldContextTokens: () => ctx.store.getSettings().groupWatch.coldContextTokens,
    plans: () => ctx.store.getSplitPlans(),
    asksOf: (keys) => pendingAsks.of(keys, (runId) => chatRuns.isRunning(runId)),
    canonical: (chatId) => ctx.store.canonicalChatKey(chatId),
    projectsDir: () => projectsDir(ctx),
    heavyQueueDir: heavyQueueDir(ctx.location.paths.appData),
    appDataDir: ctx.location.paths.appData,
    watcher: groupWatcher,
    changed: (parentChatId) => events.broadcast(['chat-tree'], parentChatId),
    bridge: (runId) => ({ runId, baseUrl: selfBaseUrl, tokenFile: apiTokenPath() }),
    log: (message, error) => console.warn(message, error ?? ''),
  });
  keepWarm.start();
  const keepWarmLedger = createKeepWarmLedgerReader(ctx.location.paths.appData);
  const treePause = new TreePause({
    links: () => ctx.store.getChatLinks(),
    runs: treeRuns,
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
    reviewView: (link) => splitReviewRef.current?.view(link),
    // «Остановить всё» — как пауза каждой группы (23.10): ждущий процесс группы
    // с фоном гасится, процессы её копии добираются по пути.
    idle: {
      snapshot: (chatId) =>
        parseForeignChatKey(chatId) ? undefined : chatRuns.idleWithBackground(chatId),
      close: (chatId) => chatRuns.closeLive(chatId),
    },
    afterPause: (keys) => {
      void sweepGroupCopies(ctx.store, keys).then((killed) => {
        if (killed.length > 0) console.warn('tree pause: copy processes swept', killed);
      });
    },
    bridge: (runId) => ({ runId, baseUrl: selfBaseUrl, tokenFile: apiTokenPath() }),
  });
  /**
   * Конвейер уровней разделения (Т1). Память — в хранилище (`splitPlans`),
   * запуск групп — тем же лаунчером, что у маршрута `POST /api/chat/split`:
   * копии и прогоны заводятся одинаково, откуда бы ни пришёл сигнал — из
   * запроса человека, из конца разбора или из конца цепочки соседней группы.
   */
  const launchDeps = {
    runs: chatRuns,
    // Текст задач группы в её копию (9.5) — тем же доступом к Jira, что перевод задач.
    tickets: atlassianTicketSource(
      () => ctx.store,
      () => ctx.location.paths.appData,
    ),
    providerChats,
    session: chatSession,
    gate: treePause,
    // Стенд и одноразовая база группам ревью (T5, T7): docker и реестр запущенных целей здесь.
    stands: {
      reviewEnvironment: (projectDir: string, copy: string, groupKey: string) =>
        prepareReviewStand(
          { originDir: projectDir, copyDir: copy, groupKey },
          {
            docker: execDocker,
            runner: (dir: string) => ({
              running: projectRunner
                .list()
                .filter(
                  (view) =>
                    view.status === 'running' &&
                    normalizePath(view.projectPath) === normalizePath(dir),
                )
                .map((view) => ({ name: view.name, ...(view.url ? { url: view.url } : {}) })),
              startable: listRunnerTargets(dir).targets.map((target) => target.name),
            }),
          },
        ),
      releaseReviewStand: async (container: { name: string }, copy: string) => {
        await removeReviewStand(execDocker, container.name, copy);
      },
    },
    log: {
      warn: (detail: { err: unknown }, message: string) => console.warn(message, detail.err),
    },
  };
  /**
   * Сверка веток разделения после работы (Т6). Живёт рядом с конвейером и на той
   * же записи: разбор уровня 1 обещал границы, а здесь панель спрашивает у git,
   * что вышло на самом деле. Ничего не сливает и не правит — только читает.
   */
  // Слова панели родителю разделения: у Claude — событие прогона, у чужого CLI —
  // реплика его хранилища. Развилка одна на всех, кому есть что сказать (Т4).
  const sayToParent = createParentNotice({
    emitRun: (chatId, event) => chatRuns.emitExternal(chatId, event),
    appendForeign: (providerId, chatId, text) =>
      Boolean(
        appendMessage(ctx.location.paths.appData, providerId, chatId, {
          role: 'notice',
          content: text,
        }),
      ),
  });
  // Автономность чата и заметки главному чату (`chat-autonomy-wiring.ts`).
  // Рассылка — позже в сборке, поэтому через замыкание: зовут её только прогоны.
  const chatAutonomy = wireChatAutonomy({
    store: ctx.store,
    chatRuns,
    say: (chatId, event) => sayToParent(chatId, event),
    broadcast: (domains, path) => events.broadcast(domains, path),
    // Ход, который панель продолжает сама (ожидание группы «по плану»), — мост к себе.
    bridge: (runId) => ({ runId, baseUrl: selfBaseUrl, tokenFile: apiTokenPath() }),
    // F-44: продолжение на стоящем дереве — в очередь паузы; отказ реестра в старте —
    // конец хода обычным путём (`settleFinish` заведён ниже, зовут его только прогоны).
    gate: treePause,
    refused: (finished) => {
      const event = settleFinish(finished);
      if (event) chatRuns.emitExternal(finished.chatId, event);
    },
  });
  // Выбранная группа чата — на каждом старте обоих провайдеров (`group-activation-wiring.ts`).
  wireGroupActivation({
    store: ctx.store,
    paths: ctx.location.paths,
    backupDir: ctx.backupDir,
    chatRuns,
    providerChats,
    log: (message, error) => console.warn(message, error),
  });
  // Tests of the project (e2e folder, how a test becomes a case) on every chat start.
  const testsChat = wireTestsChatNote({
    appData: ctx.location.paths.appData,
    chatRuns,
    providerChats,
    // Автотесты на закрытии тоже пишут в файлы групп — сверка ждёт и их.
    isBusy: projectTestsBusy(projectTestRuns, e2eRuns),
    log: (message, error) => console.warn(message, error),
  });
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

  const splitOverlap = new SplitOverlap({
    git: {
      // Ветка основной копии в свежем виде удалённого, если локальная отстала
      // (находка 52): иначе всё, что приехало в main, считалось правками групп.
      mergeBase: (mainDir) => readMergeTarget(mainDir),
      changedFiles: (input) => readBranchFiles(input),
      movedFiles: (input) => readTargetMoved(input),
      headOf: (dir) => readWorktreeHead(dir),
    },
    store: {
      get: (parent) => ctx.store.getSplitPlan(parent),
      set: (record) => ctx.store.setSplitPlan(record),
      all: () => ctx.store.getSplitPlans(),
    },
    // Заметка идёт в ленту РОДИТЕЛЯ: разделение — его решение, и сводка групп
    // тоже его. Прогона у родителя нет — `false`, и факт подождёт (см. домен).
    emit: (parentChatId, event) => sayToParent(parentChatId, event),
    log: (message, error) => console.warn(message, error),
  });
  // Пока группы работают — пересчёт по расписанию (находка 61c), а не только по
  // концу цепочки: соседи сходятся в одном файле задолго до своего конца.
  splitOverlap.watchDrift();
  /**
   * Ревью запроса на слияние по ссылке (Т7). Домен решает, что делать с
   * замечаниями, а всё, что умеет ПИСАТЬ, подаётся сюда снаружи: комментарий в
   * MR — интеграцией форджа, правки — обычным прогоном в копии группы. Ни то,
   * ни другое не случается само: и то и другое — клик человека.
   */
  // Ключ — того форджа, на который указывает ссылка: GitLab и GitHub
  // подключаются по отдельности (`forge-pick.ts`).
  const forgeToken = (url: string) => forgeTokenForUrl(ctx.store, ctx.location.paths.appData, url);
  const splitReview = new SplitReview({
    store: {
      all: () => ctx.store.getChatLinks(),
      set: (chatId, link) => ctx.store.setChatLink(chatId, link),
      remove: (chatId) => ctx.store.clearChatLink(chatId),
    },
    post: async (url, body) => {
      const token = forgeToken(url);
      if (!token) throw new Error('фордж этой ссылки не подключён в настройках панели');
      await commentMergeRequestByUrl(url, token, body);
    },
    // Причину спрашиваем на каждый показ карточки: интеграцию включают и
    // выключают, а кнопка, которая заведомо откажет, хуже отсутствующей.
    postBlocked: (url) => {
      const ref = parseMergeRequestUrl(url);
      if (!ref) return 'ссылка не похожа на запрос на слияние';
      const title = ref.kind === 'gitlab' ? 'GitLab' : 'GitHub';
      if (!readIntegrations(ctx.store)[ref.kind].enabled) {
        return `интеграция ${title} выключена в настройках панели`;
      }
      return forgeToken(url) ? undefined : `токен ${title} не сохранён в настройках панели`;
    },
    start: createReviewStarter(ctx, launchDeps),
    // Публикует сессия ревью — тредами по правилам проекта; сводный комментарий
    // выше остаётся запасным путём только для тестов и выключенного флага.
    publishInSession: true,
    // Заметка — в ленту родителя: карточку решения человек ищет в хабе. У
    // чужого родителя прогона в реестре нет, и та же заметка ложится репликой
    // его хранилища — развилка одна на всех (Т4).
    emit: (parentChatId, event) => sayToParent(parentChatId, event),
    // «Ничего не делать» / «только отписать» — последнее слово по группе (Д3).
    closeGroup: (link) =>
      splitConveyor.onChainEnded(link, { status: 'done', result: { kind: 'reviewed' } }),
    log: (message, error) => console.warn(message, error),
  });
  splitReviewRef.current = splitReview;

  const ticketTracker = atlassianTicketTracker(
    () => ctx.store,
    () => ctx.location.paths.appData,
  );
  const taskTracker = atlassianTaskTracker(
    () => ctx.store,
    () => ctx.location.paths.appData,
  );
  // Выученные сита и счёт блокеров (решение владельца 28.09) — в каталоге
  // данных панели; каталог может смениться переездом, поэтому по вызову.
  const sieveStore = (): SieveStore => new SieveStore(ctx.location.paths.appData);
  // Абзац сит для задания звена — один на Claude и чужой CLI: по путям копии,
  // выученным ситам проекта группы и уже сданным строкам.
  const stageSieves = (
    cwd: string,
    link: ChatLink,
    stage: SieveStage,
    done: readonly SieveReportRow[],
  ): Promise<string> => {
    const plan = link.parentChatId ? ctx.store.getSplitPlan(link.parentChatId) : undefined;
    const projectPath = plan?.projectPath;
    // Группа, отведённая от ветки предшественника, — сита по её своим коммитам.
    const forkedFrom = plan?.groups.find((group) => group.index === link.groupIndex)?.base;
    return sievePrompt({
      cwd,
      stage,
      done,
      store: sieveStore(),
      ...(projectPath ? { projectPath } : {}),
      ...(forkedFrom ? { forkedFrom } : {}),
    });
  };
  // Слово панели группе — продолжением её сессии. Вводная едет на случай, когда
  // файла сессии нет и ход пойдёт новым разговором (вопрос ревью Q2).
  const tellGroup = (
    group: SplitPlanGroupRecord,
    chatId: string,
    cwd: string,
    prompt: string,
    // Слово дошло до разговора (а не легло в очередь в памяти) — отложенным
    // вопросам D-n это нужно, чтобы помечать продолжение по факту (D-L02).
    onSent?: () => void,
    // Текст в миг доставки: слово об исходах D-n складывается тогда (RF-DL-01).
    render?: () => string | undefined,
  ): 'sent' | 'queued' | 'refused' => {
    const link = ctx.store.getChatLink(chatId);
    const parent = link?.parentChatId;
    const tasks = parent
      ? (ctx.store.getSplitPlan(parent)?.proposal.groups[group.index]?.tasks ?? [])
      : [];
    const brief = coldResumeBrief(group, tasks);
    // Задание стадии — из связи (R1 ревью P0.4): запуск решает «новым разговором»
    // раньше реестра, и без него новая сессия знала бы только номера задач — даже
    // не то, что она ревью или доставка.
    const stageTask = link?.stagePrompt ?? link?.task;
    return childTells.send({
      chatId,
      cwd,
      prompt,
      title: group.title,
      fresh: lostConversationBrief(group, tasks),
      // Остывший разговор с большим окном запуск продолжит новым (рычаг экономии).
      cold: stageTask ? withStageTask(brief, stageTask) : brief,
      ...(group.base ? { base: group.base } : {}),
      ...(onSent ? { onSent } : {}),
      ...(render ? { render } : {}),
    });
  };
  // Непорождённое звено правок или доставки (F-07 ревью П1) стартует заново
  // СВОИМ заданием из связи, под своим ключом и со своим профилем. Продолжение
  // прошлой сессии работы общим словом теряло замечания и задание доставки,
  // цепочка кончалась, а напоминание доставки шло в сессию с запретом пуша.
  // Задания в связи нет (звено заведено до него) — к человеку, а не наугад.
  const stageStarter = createReviewStarter(ctx, launchDeps);
  const restartUnbornStage = (
    group: SplitPlanGroupRecord,
    chatId: string,
    link: ChatLink,
  ): 'sent' | 'queued' | 'refused' => {
    if (!link.stagePrompt || !group.path) return 'refused';
    const links = ctx.store.getChatLinks();
    // Тумблеры (автоподтверждение) — от сессии, писавшей код, как при заведении звена.
    const writer = unbornResumeTarget(links, chatId);
    const outcome = stageStarter({
      chatId,
      prompt: link.stagePrompt,
      cwd: group.path,
      ...(link.model ? { model: link.model } : {}),
      ...(link.effort ? { effort: link.effort } : {}),
      stage: link.stage === 'fix' ? 'fix' : 'push',
      fromAliases: writer ? conversationKeys(links, writer.chatId) : [],
      title: group.title,
    });
    return outcome.started ? 'sent' : 'refused';
  };
  // Оборванная группа (WP1c) продолжается своей же сессией. Чат стадии так и
  // не родился (пауза до первого хода) — правки и доставка стартуют заново
  // своим заданием (`restartUnbornStage`), прочие — продолжается прошлая сессия
  // группы, писавшая код (`unbornResumeTarget`); нет и её — ждёт человека, а не
  // очередь, которую никто не разберёт.
  const resumeGroup = (
    group: SplitPlanGroupRecord,
    prompt: string,
    onSent?: () => void,
    render?: () => string | undefined,
  ): 'sent' | 'queued' | 'refused' => {
    if (!group.chatId || !group.path) return 'refused';
    const links = ctx.store.getChatLinks();
    const keys = conversationKeys(links, group.chatId);
    if ([group.chatId, ...keys].some((key) => !key.startsWith('new-'))) {
      return tellGroup(group, group.chatId, group.path, prompt, onSent, render);
    }
    const unborn = links[group.chatId];
    if (unborn?.stage === 'fix' || unborn?.stage === 'deliver') {
      return restartUnbornStage(group, group.chatId, unborn);
    }
    const target = unbornResumeTarget(links, group.chatId);
    if (!target) return 'refused';
    if (target.clearReviewed) {
      for (const key of conversationKeys(links, target.chatId)) {
        const link = ctx.store.getChatLink(key);
        if (link?.reviewedAt) {
          const { reviewedAt: _reviewed, ...rest } = link;
          ctx.store.setChatLink(key, rest);
        }
      }
    }
    return tellGroup(group, target.chatId, group.path, prompt, onSent, render);
  };
  // Отложенные вопросы D-n: решение человека продолжает группу тем же путём
  // (`resumeGroup`), одиночный чат — тем же разговором; разрешённое до
  // перезапуска панели продолжается обходом при старте.
  // Ждущие записи групп, которые правило теперь решает само (D-1), — решаются при старте.
  const rejudgeDeps = rejudgeDepsFor(ctx);
  const deferredWiring = wireDeferredAsks({
    ctx,
    runs: chatRuns,
    resumeGroup,
    rejudge: (record) => rejudgeGroupAsk(record, rejudgeDeps),
  });
  scheduleDeferredReDrive(deferredWiring);
  const splitConveyor = new SplitConveyor({
    backgroundTasks: (chatId) => chatRuns.backgroundTasksOf(chatId),
    store: {
      get: (parent) => ctx.store.getSplitPlan(parent),
      set: (record) => ctx.store.setSplitPlan(record),
      findByTriage: (chatIds) => ctx.store.findSplitPlanByTriage(chatIds),
      all: () => ctx.store.getSplitPlans(),
      watchSignals: (parent, index) => ctx.store.getGroupWatchSignals(parent, index),
      keepWarm: keepWarmLedger,
    },
    ticketTracker: (projectPath) => ticketTracker.projectOf(projectPath),
    tasksConnected: () => taskTracker.connected(),
    // Выбор группы родителя `auto` — разбор выбирает группу каждой группе
    // разделения из этого каталога (с учётом выбора пары в проекте).
    groupCatalog: (record) =>
      triageGroupCatalog({
        reader: storeTreeReader(ctx.store),
        groups: ctx.store.getGroups(),
        pairChoice: readChoice(ctx.location.paths.appData, record.projectPath),
        parentChatId: record.parentChatId,
        projectPath: record.projectPath,
      }),
    watchOverlap: (parentChatId) => {
      void splitOverlap.check(parentChatId).catch((error) => {
        console.warn('split overlap: check after chain end failed', error);
      });
      // Тот же конец цепочки ставит наблюдение за MR доставленной группы (WP1j).
      // `mrWatch` объявлен ниже: к первому концу цепочки он уже есть.
      mrWatch.sync(parentChatId);
    },
    // Счёт токенов закрытой группы (E4): транскрипты её звеньев.
    tokenLedger: groupTokenLedger({
      links: () => ctx.store.getChatLinks(),
      projectsDir: () => projectsDir(ctx),
      // Расход групп Codex и Qwen Code — из переписки CLI (дом Qwen «Наши» — в данных панели).
      appDataDir: ctx.location.paths.appData,
    }),
    // Закрытие группы ревью (T13, T6/T11): `git status` копии, временные копии и
    // одноразовая база. Копии групп всех разделений — не временные.
    closeReview: (record, group, options) =>
      closeReviewGroup(
        {
          mainDir: copyRootOf(record),
          ...(group.path && !group.cleaned ? { copy: group.path } : {}),
          ...(group.startedAt ? { startedAt: group.startedAt } : {}),
          knownCopies: Object.values(ctx.store.getSplitPlans())
            .flatMap((plan) => plan.groups.map((item) => item.path ?? ''))
            .filter(Boolean),
          mirror: ctx.store.getWorktreeMirror(record.projectPath),
          dirt: options.dirt,
          ...(group.stand ? { stand: group.stand } : {}),
        },
        {
          docker: execDocker,
          log: (message, error) => console.warn(`[review-close] ${message}`, error),
        },
      ),
    launch: (record, groups, context, claimBranch, startable) =>
      launchFromRecord(ctx, launchDeps, record, groups, context, claimBranch, startable),
    startTriage: (record, prompt, claim) =>
      createSplitLauncher(ctx, launchDeps, {
        projectPath: copyRootOf(record),
        settingsPath: record.projectPath,
        parentChatId: record.parentChatId,
        ...(record.request.model ? { model: record.request.model } : {}),
        ...(record.request.effort ? { effort: record.request.effort } : {}),
      }).startTriage(prompt, claim),
    parallel: (record) => resolveProjectDelivery(ctx.store, record.projectPath).view.parallel,
    hasWork: (cwd, since) => hasWorkSince(cwd, since),
    // Доставка группы по фактам git (WP1b): «готово» — только когда ветка на
    // удалённом и MR с той же головой; иначе напоминание группе её же сессией.
    delivery: {
      facts: async (group, mr, projectPath, claimed) => {
        if (!group.path) return { missing: [serverText('delivery-gap-no-copy')] };
        const facts = await readDeliveryFacts({
          cwd: group.path,
          branch: group.branch,
          ...(mr ? { mr } : {}),
          mirror: ctx.store.getWorktreeMirror(projectPath),
          claimed,
          ...(group.base ? { forkedFrom: group.base } : {}),
          // MR выбирается по ветке группы, а не по одной голове (ревью 29.09):
          // ветку-источник знает только фордж, без него — «неизвестно».
          branchOfMr: async (url) => {
            const token = forgeToken(url);
            if (!token) return undefined;
            return (await readMergeRequestByUrl(url, token))?.branch;
          },
        });
        const missing = missingDelivery(facts, facts.branch ?? group.branch);
        // Сита перед MR (решение владельца 28.09): механика git панели и судья
        // отчёта группы. Сеть уже не ответила — сита ждут следующей проверки.
        const sieves = facts.unreachable
          ? undefined
          : await sieveDeliveryGaps({
              cwd: group.path,
              ...(group.startedAt ? { startedAt: group.startedAt } : {}),
              ...(group.base ? { forkedFrom: group.base } : {}),
              rows: group.sieveRows ?? [],
            }).catch((error: unknown) => {
              console.warn('split delivery: sieves unreadable', error);
              return undefined;
            });
        if (sieves?.unchecked) {
          console.warn(
            `split delivery: sieves unchecked for ${group.branch}: ${sieves.unchecked.join('; ')}`,
          );
        }
        // Вердикт группы — из кейсов и записанных прогонов блока «Тесты» в её
        // копии, а не из её слов (решение владельца 29.09). Блока в копии нет —
        // проверять нечем, группу это не держит.
        const tests = await testsDeliveryGaps({
          cwd: group.path,
          ...(group.startedAt ? { startedAt: group.startedAt } : {}),
          command: `node "${TESTS_CLI}" run --project .`,
        }).catch((error: unknown) => {
          console.warn('split delivery: tests block unreadable', error);
          return undefined;
        });
        // Заметки доставки (23.10): «не проверено» и красное не из-за ветки —
        // не пробелы, но описание MR обязано их назвать.
        const notes = [...(sieves?.notes ?? []), ...(tests?.notes ?? [])];
        // Описание MR и ветки ревьюера — одним чтением форджа, только у
        // найденного по голове MR.
        const mrToken = facts.mr ? forgeToken(facts.mr) : undefined;
        const review =
          facts.mr && mrToken
            ? await readMergeRequestReview(facts.mr, mrToken).catch(() => undefined)
            : undefined;
        const description = facts.mr
          ? await mrDescriptionGap(facts.mr, async () => review, liveNaIds(group.sieveRows ?? []), [
              ...(sieves?.noted ?? []),
              ...(tests?.noted ?? []),
            ])
          : {};
        // Ветки ревьюера держат доставку (24.10): наблюдатель MR смотрит только
        // группы в `done`, и группа в доставке сутки не видела трёх блокеров.
        const threads = review && facts.mr ? reviewThreadsGap(review, facts.mr) : undefined;
        return {
          missing: [
            ...missing,
            ...(description.missing ? [description.missing] : []),
            ...(threads ? [threads.line] : []),
            ...(sieves?.missing ?? []),
            ...(tests?.missing ?? []),
          ],
          ...(notes.length > 0 ? { notes } : {}),
          ...(facts.head ? { head: facts.head } : {}),
          ...(tests?.verdict ? { tests: tests.verdict } : {}),
          ...(sieves?.classes.length ? { sieveClasses: sieves.classes } : {}),
          ...(facts.mr ? { mr: facts.mr } : {}),
          ...(facts.branch ? { branch: facts.branch } : {}),
          ...(facts.unreachable ? { unreachable: facts.unreachable } : {}),
          ...(description.unchecked ? { descriptionUnchecked: true } : {}),
          ...(threads ? { reviewThreads: threads.threads } : {}),
        };
      },
      // `childTells` объявлен ниже: к моменту первой проверки он уже есть.
      nudge: (group, prompt): 'sent' | 'queued' | 'refused' =>
        group.chatId && group.path ? tellGroup(group, group.chatId, group.path, prompt) : 'refused',
      // Стадия разговора группы: ревью и план MR не откроют — им новая доставка.
      stage: (group) => {
        const link = group.chatId ? ctx.store.getChatLink(group.chatId) : undefined;
        return link ? stageOf(link) : undefined;
      },
      // Новый разговор доставки / разбор на сильной модели (решение владельца 23.10).
      freshStage: createDeliverStageSession({
        links: () => ctx.store.getChatLinks(),
        setLink: (chatId, link) => ctx.store.setChatLink(chatId, link),
        removeLink: (chatId) => ctx.store.clearChatLink(chatId),
        // Ход чужого CLI идёт у его сервиса, а не у прогонов Claude (§2.3).
        running: (chatId) => {
          const foreign = parseForeignChatKey(chatId);
          return foreign ? providerChats.isChatRunning(foreign.chatId) : chatRuns.isRunning(chatId);
        },
        start: stageStarter,
        // Связь переехала на настоящий ключ чужого разговора уже после старта.
        resumed: (chatId, link) => splitConveyor.onChainResumed(link, chatId),
        ceiling: () => {
          const settings = ctx.store.getSettings();
          return {
            ...(settings.chatModel ? { model: settings.chatModel } : {}),
            ...(settings.chatEffort ? { effort: settings.chatEffort } : {}),
          };
        },
        log: (message, error) => console.warn(message, error),
      }),
    },
    resume: resumeGroup,
    // «Перепроверить MR» — новым разговором с вводной (R2/R5, 19.10.2026).
    recheck: createRecheckSession({
      links: () => ctx.store.getChatLinks(),
      setLink: (chatId, link) => ctx.store.setChatLink(chatId, link),
      removeLink: (chatId) => ctx.store.clearChatLink(chatId),
      running: (chatId) => chatRuns.isRunning(chatId),
      start: createReviewStarter(ctx, launchDeps),
      resume: resumeGroup,
      log: (message, error) => console.warn(message, error),
    }),
    // Ожидание сброса лимита (журнал 89): срок в записи, таймер только будит.
    schedule: (run, ms) => setTimeout(run, ms).unref(),
    notify: (parentChatId, event) => void sayToParent(parentChatId, event),
    sieves: {
      learn: (input) => sieveStore().learn(input),
      caught: (classes) => sieveStore().caught(classes),
    },
    log: (message, error) => console.warn(message, error),
  });
  // Команды оболочки чужих CLI — тем же судом, что брокер Claude (P-01..P-05).
  wireForeignShellJudge({
    ctx,
    store: ctx.store,
    providerChats,
    deliverAhead: (link) => splitConveyor.deliverAhead(link),
  });
  // MR доставленной группы после «готово» (WP1j): ветки ревьюеров и исход
  // конвейера — по расписанию, только чтением; нашлось — группа продолжается.
  // Интеграция выключена или токена нет — читать нечем, наблюдатель молчит.
  const readMr = async (url: string) => {
    const token = forgeToken(url);
    if (!token) return undefined;
    return readMergeRequestReview(url, token);
  };
  // Влит ли MR — пока хаб открыт: только состояние, запрос на проект, не чаще
  // раза в 5 минут на план (владелец 06.10.2026).
  const mrStateRefresh = new MrStateRefresh({
    store: {
      get: (parent) => ctx.store.getSplitPlan(parent),
      set: (record) => ctx.store.setSplitPlan(record),
    },
    read: async (urls) => {
      if (!urls.some((url) => forgeToken(url))) return undefined;
      return readMergeRequestStates(urls, forgeToken);
    },
    log: (message, error) => console.warn(message, error),
  });
  const mrWatch = new MrWatch({
    store: {
      get: (parent) => ctx.store.getSplitPlan(parent),
      set: (record) => ctx.store.setSplitPlan(record),
      all: () => ctx.store.getSplitPlans(),
    },
    read: readMr,
    resume: (parentChatId, index, prompt) =>
      splitConveyor.resumeDelivered(parentChatId, index, prompt),
    retryJob: async (url, jobId) => {
      const token = forgeToken(url);
      return token ? retryMergeRequestJob(url, token, jobId) : false;
    },
    schedule: (run, ms) => setTimeout(run, ms).unref(),
    notify: (parentChatId, event) => void sayToParent(parentChatId, event),
    log: (message, error) => console.warn(message, error),
  });
  // Новый прогон в чате группы — группа снова «работает» (Д3): человек ответил
  // на вопрос, продолжил ребёнка или панель повторила упавший ход.
  // Надзор повторов (Д10): упавший ход ребёнка разделения продолжается сам —
  // через паузу или в момент сброса лимита. Стоящее дерево повтор не будит:
  // старт ложится в очередь паузы и уйдёт по «Продолжить всё».
  // Группа на паузе (журнал 81a) повтором не продолжается: её остановил
  // человек, и продолжит тоже он. Тот же вопрос задаёт слово родителя (R13).
  const pausedGroup = pausedGroupOf(ctx.store, splitConveyor);
  const runRetry = new RunRetry({
    start: (chatId, options, meta) =>
      pausedGroup(chatId) ||
      treePause.defer('stage', chatId, options, meta) ||
      treeRuns.start(chatId, options, meta),
    // Лимит группы разделения ждёт конвейер по записи — переживает перезапуск.
    persistsLimit: (keys) =>
      keys.some((key) => {
        const link = ctx.store.getChatLink(key);
        return Boolean(link && retriesLink(link) && splitConveyor.tracksGroup(link));
      }),
    // Повтор подхваченного после перезапуска прогона — мост к этой панели (как F-45).
    bridge: (runId) => ({ runId, baseUrl: selfBaseUrl, tokenFile: apiTokenPath() }),
    log: (message, error) => console.warn(message, error),
  });
  // Обычный чат на локальной модели после обрыва продолжает сам (L4b): сервер поднимает
  // присмотр, а ход, который CLI закончил ошибкой, — это.
  /** Прогон Claude идёт на локальной модели: маршрутом контура или переключателем «Claude Code на локальной модели». */
  const isLocalClaudeRun = (options: RunOptions, origin: string | undefined): boolean => {
    const url = options.platformEnv?.ANTHROPIC_BASE_URL ?? '';
    if (url) return url.includes(`/${LOCAL_PLATFORM_ID}`);
    // Claude, уведённый на локальную модель переключателем: адрес лежит в settings.json.
    return (origin ?? 'chat') === 'chat' && localModels.claudeRedirected();
  };
  /** Идёт ли хоть один прогон на локальной модели — Claude или чужой CLI. */
  const localRunActive = (): boolean =>
    chatRuns.anyRunning(
      (run) => run.meta.local === true || isLocalClaudeRun(run.options, run.meta.origin),
    ) || providerChats.localRunning();
  // Метка «локальный» ложится в журнал: усыновлённый после перезапуска прогон опций с адресом не несёт.
  chatRuns.setLocalClassifier((options, meta) => isLocalClaudeRun(options, meta.origin));
  const autoContinue = new AutoContinue({
    start: (chatId, options, meta) => chatRuns.start(chatId, options, meta),
    isLocal: (finished) =>
      finished.local === true || isLocalClaudeRun(finished.options, finished.origin),
    bridge: (runId) => ({ runId, baseUrl: selfBaseUrl, tokenFile: apiTokenPath() }),
    log: (message, error) => console.warn(message, error),
  });
  // «Стоп» человека в чате группы — пауза группы (журнал 89c).
  chatRuns.setHumanStopListener(pauseOnHumanStop(ctx.store, splitConveyor));
  // Конец фоновой задачи не будит группу на паузе (N1a): реестр гасит процесс.
  // И группу в стоящем дереве («Остановить всё»): то же решение человека.
  const treePausedGroup = treePausedGroupOf(ctx.store, treePause);
  chatRuns.setWakeGuard((keys) => keys.some((key) => pausedGroup(key) || treePausedGroup(key)));
  // Процесс группы умер, держа фон, — обрыв с продолжением, а не провал (W3-4c).
  const interruptGroup = interruptOnBackgroundLost(ctx.store, splitConveyor);
  const continueLocal = continueOnBackgroundLost(ctx.store, chatRuns, autoContinue);
  chatRuns.setBackgroundLostListener((keys) => {
    interruptGroup(keys);
    continueLocal(keys);
  });
  // И у чужого CLI: его «Стоп» — та же пауза группы (открытый вопрос WP9e).
  providerChats.setHumanStopListener(pauseOnForeignStop(ctx.store, splitConveyor));
  const isRetriedChild = (keys: readonly string[]): boolean =>
    keys.some((key) => retriesLink(ctx.store.getChatLink(key)));
  chatRuns.setStartListener((keys) => {
    runRetry.started(keys);
    autoContinue.started(keys);
    pendingAsks.started(keys);
    chatAutonomy.started(keys);
    for (const key of keys) {
      const link = ctx.store.getChatLink(key);
      if (link && link.stage !== 'triage') {
        splitConveyor.onChainResumed(link, key);
        return;
      }
    }
  });
  // «Что получил агент» у чужого CLI (U8) — тем же хранилищем, что у Claude.
  providerChats.setInputJournal((key, record) =>
    appendRunInput(ctx.location.paths.appData, key, record),
  );
  // Окно сжатия групп (2.1) — рычаг страницы настроек, переменная панели сильнее
  // (замер A/B). По вызову: рычаг правится без перезапуска панели.
  const groupWindow = (): number | undefined =>
    groupCompactWindow(
      process.env.AGENTDECK_GROUP_COMPACT_WINDOW,
      ctx.store.getSettings().groupEconomy?.compactWindow,
    );
  // Ребёнок в чужом CLI получает то же окружение, что ребёнок Claude (6.1):
  // тот же признак — связь с родителем (`setChildResolver` выше). Группа — ещё и
  // лёгкий набор MCP (1.2): серверы конфига этого CLI, снятые тем же правилом;
  // снимает их выключатель CLI (`setMcpOff` ниже), у кого он есть.
  providerChats.setChildRun((providerId, chatId) => {
    const link = ctx.store.getChatLink(foreignChatKey(providerId, chatId));
    if (!link?.parentChatId) return undefined;
    // Метка группы в окружении, как у групп Claude (`groupRunProfile`): суд
    // погашения узнаёт по ней сирот группы чужого CLI (D-1, P-06).
    const env = {
      ...childRunEnv(process.env),
      ...groupMarkEnv({ parentChatId: link.parentChatId, groupIndex: link.groupIndex }),
    };
    // Рычаги экономии закрепляются здесь — на старте прогона, как у Claude, а не
    // при заведении звена: дополнение (`foreignChildExtra`) только смотрит, и
    // отложенное звено берёт рычаги своего первого хода (ревью A8).
    const current = ctx.store.getSettings().groupEconomy;
    const economy = current
      ? ctx.store.linkEconomy([foreignChatKey(providerId, chatId)], current)
      : undefined;
    const input = splitConveyor.profileInput(link);
    if (!input) return { env };
    // Рычаги экономии — у каждой группы, с выключателем серверов или без: канал
    // своего CLI (`setEconomyRun` ниже) решает, что из них доходит до прогона.
    // Окно сжатия — на ходу, остальное — закреплённое на первом старте разговора,
    // как у групп Claude (`groupRunProfile`).
    const compactWindow = groupWindow();
    const levers = {
      ...(economy ? { economy } : {}),
      ...(compactWindow ? { compactWindow } : {}),
    };
    // Группа и без выключателя серверов у CLI — группа: строка о тестах ей без вопросов.
    if (!mcpOffChannel(providerId)) return { env, group: true, ...levers };
    const mcp = foreignGroupMcp({ entries: providerMcpEntries(providerId), ...input });
    return mcp.note
      ? { env, group: true, ...levers, mcp: { off: mcp.off, note: mcp.note } }
      : { env, group: true, ...levers };
  });
  // Канал рычагов экономии — из каталога провайдера (`groupEconomy.channel`):
  // порог сжатия Codex, слой настроек Qwen Code… Канала нет — прогон как был.
  providerChats.setEconomyRun((providerId, run, env) =>
    economyRunEnv(getProvider(providerId).groupEconomy?.channel, {
      ...run,
      env,
      appData: ctx.location.paths.appData,
    }),
  );
  // Пауза группы Codex / Qwen Code (`freshOnColdResume`): остывшую сессию CLI не
  // продолжать, а начать новую с вводной панели — то же правило, что у Claude.
  // `AGENTDECK_FOREIGN_COLD_AFTER_MS` — свой срок остывания для живой проверки.
  providerChats.setColdPlan(
    createForeignColdPlan({
      store: ctx.store,
      appDataDir: ctx.location.paths.appData,
      coldAfterMs: foreignColdAfterMsEnv,
    }),
  );
  // Сторож групп и у чужого CLI: старт и конец хода звена — без потока, как прогон,
  // подхваченный после перезапуска (`detached`). Сессия CLI ещё неизвестна (первый
  // ход) — её место занимает ключ разговора: без id сторож счёл бы молчание
  // хода зависанием, а с ним, не найдя транскрипта, честно ничего не видит.
  providerChats.setWatchListener((feed) => {
    if (!feed.group) return;
    const key = foreignChatKey(feed.providerId, feed.chatId);
    const sessionId = feed.sessionId ?? key;
    // Провайдер — сторожу: переписку CLI (Codex, Qwen Code) он читает своим разбором.
    groupWatcher.onFeed(
      key,
      feed.kind === 'start'
        ? {
            kind: 'start',
            sessionId,
            cwd: feed.cwd,
            detached: true,
            provider: feed.providerId,
            ...(feed.local ? { local: true } : {}),
          }
        : { kind: 'finish', sessionId },
    );
  });
  /** Выключатель серверов: Codex — ключом запуска, Qwen Code — слоем настроек. */
  function mcpOffChannel(providerId: string): 'codex' | 'qwen' | undefined {
    if (providerId === 'codex') return 'codex';
    return getProvider(providerId).groupLayer === 'qwen-system-settings' ? 'qwen' : undefined;
  }
  providerChats.setMcpOff((providerId, names, env) => {
    const channel = mcpOffChannel(providerId);
    if (channel === 'codex') return { [CODEX_MCP_OFF_ENV]: JSON.stringify(names) };
    return channel === 'qwen'
      ? writeQwenMcpExcluded({ appData: ctx.location.paths.appData, names, env })
      : undefined;
  });
  // Очередь тяжёлых шагов (3.2): один полный гейт за раз на всю машину, каталог —
  // в данных панели, общий для всех групп — Claude и Qwen Code. У Codex хуки
  // требуют ручного доверия (`/hooks`), без человека они не сработают.
  const heavyQueue = {
    hook: `node "${fileURLToPath(new URL('../../../../../tools/heavy-queue-hook.mjs', import.meta.url))}"`,
    dir: heavyQueueDir(ctx.location.paths.appData),
  };
  // Число мест — файлом очереди: его видят и группы, запущенные до этого старта.
  writeHeavyQueueConfig(heavyQueue.dir, heavySlots(process.env));
  // Фоновые вызовы модели, которые панели не нужны (6.3), — тем же слоем настроек Qwen;
  // им же у группы едет очередь тяжёлых шагов.
  providerChats.setQuietRun((providerId, group, env) =>
    mcpOffChannel(providerId) === 'qwen'
      ? writeQwenQuietRun({ appData: ctx.location.paths.appData, group, env, heavyQueue })
      : undefined,
  );
  /** Серверы MCP из конфига CLI; нечитаемый конфиг — ни одного (снимать нечего). */
  function providerMcpEntries(providerId: string): ProfileMcpEntry[] {
    try {
      const target = resolveProviderMcpTargetFor(
        getProvider(providerId),
        ctx.store.getSettings().claudeDirOverride,
      );
      return (target ? readProviderMcpServers(target) : []).map((server) => ({
        id: server.name,
        config: { url: server.url, command: server.command, args: server.args },
      }));
    } catch {
      return [];
    }
  }
  // Родитель в чужом CLI знает о детях так же, как в Claude (Д6).
  providerChats.setChildrenBrief((providerId, chatId) =>
    childrenBrief(splitConveyor.view([foreignChatKey(providerId, chatId)])),
  );
  providerChats.setStartListener((providerId, chatId) => {
    runRetry.started([foreignChatKey(providerId, chatId)]);
    const key = foreignChatKey(providerId, chatId);
    const link = ctx.store.getChatLink(key);
    if (link && link.stage !== 'triage') splitConveyor.onChainResumed(link, key);
  });
  // Слово родителя ребёнку (Д7): блок `agentdeck:tell` в ответе родителя
  // доставляется продолжением сессии группы, занятой — после её хода.
  const childTells = new ChildTells({
    split: (keys) => splitConveyor.view(keys),
    aliasesOf: (chatId) => {
      const keys = conversationKeys(ctx.store.getChatLinks(), chatId);
      return keys.length > 0 ? keys : [chatId];
    },
    settingsOf: (chatId) => {
      const link = ctx.store.getChatLink(chatId);
      return {
        ...(link?.model ? { model: link.model } : {}),
        ...(link?.effort ? { effort: link.effort } : {}),
      };
    },
    start: createReviewStarter(ctx, launchDeps),
    // Группу на паузе слово родителя не будит — ждёт хода, заведённого человеком.
    held: pausedGroup,
    notify: (keys, event) => {
      keys.some((key) => sayToParent(key, event));
    },
    log: (message, error) => console.warn(message, error),
  });
  // Конец любого хода: ребёнку могло ждать слово родителя, а родитель мог его сказать.
  const tellsOnFinish = (keys: readonly string[], ok: boolean, text: string): void => {
    try {
      childTells.childFinished(keys);
      if (ok) childTells.parentFinished(keys, text);
    } catch (error) {
      console.warn('child tell failed', error);
    }
  };
  // Потолок живых процессов превышен, а вытеснить некого (Д17): не молчим.
  chatRuns.livePool.onOverflow = (size, max) =>
    console.warn(
      `live sessions: ${size} over the limit ${max}, all busy or holding background work`,
    );
  const handoffPlanner = createHandoffPlanner({
    runs: chatRuns,
    chains: handoffChains,
    gate: treePause,
    session: chatSession,
    selfBaseUrl,
    contextLimit: () => ctx.store.getSettings().handoffContextLimit,
    // Окно сжатия закрывшегося прогона (E1): окружение прогона с `platformEnv`
    // (локальная модель, профиль группы), рычаг окна групп, `autoCompactWindow`.
    compactWindow: (finished) =>
      runCompactWindow(
        finished.options,
        groupWindow(),
        settingsCompactWindow(finished.options.configDir ?? ctx.location.paths.root),
      ),
    // Продолжение наследует связь закрытого разговора: и родителя в дереве, и
    // подобранную под задачу модель. Иначе следующее сообщение человека —
    // первое, что придёт в новый чат без модели, — уехало бы на дефолте.
    carryLink: (from, to) => {
      const link = from.map((key) => ctx.store.getChatLink(key)).find(Boolean);
      if (link) ctx.store.setChatLink(to, carriedLink(link));
    },
    /**
     * Конвейер «работа → ревью → фикс»: чем оплачивается понижение модели.
     * Всё, что ему нужно снаружи, — связи чатов, настройки и один вопрос к
     * git. Решение о звене принимает домен (`ChatCascadeStages`), запускает
     * планировщик, а собирается это здесь, как и остальные долгоживущие связки.
     */
    cascade: {
      linkOf: (aliases) => aliases.map((key) => ctx.store.getChatLink(key)).find(Boolean),
      saveLink: (chatId, link) => ctx.store.setChatLink(chatId, link),
      // Отметка ставится по ОБОИМ ключам чата: под временным он живёт в памяти
      // вкладок, под настоящим — в списке, и проверить работу дважды нельзя ни
      // из того, ни из другого.
      markReviewed: (aliases, at) => {
        for (const key of aliases) {
          const link = ctx.store.getChatLink(key);
          if (link) ctx.store.setChatLink(key, { ...link, reviewedAt: at });
        }
      },
      // Та же отметка для плана (Т1): вторая работа той же группы не заводится.
      markPlanned: (aliases, at) => {
        for (const key of aliases) {
          const link = ctx.store.getChatLink(key);
          if (link) ctx.store.setChatLink(key, { ...link, plannedAt: at });
        }
      },
      hasWork: (cwd, since) => hasWorkSince(cwd, since),
      reviewDelta: (cwd, since) => readReviewDelta(cwd, since),
      settings: () => ctx.store.getSettings(),
      // Сита перед MR в задании звена: по путям копии и выученным ситам проекта.
      sieves: stageSieves,
    },
    split: {
      onTriageFinished: (finished, aliases) => splitConveyor.onTriageFinished(finished, aliases),
      onChainEnded: (link, ok) => splitConveyor.onChainEnded(link, ok),
      onChainInterrupted: (link) => splitConveyor.onChainInterrupted(link),
      identityOf: (link) => splitConveyor.identityOf(link),
      delivers: (link) => splitConveyor.delivers(link),
      sonnetDeliverOf: (link) => splitConveyor.sonnetDeliverOf(link),
      deferredOf: (link) =>
        link.parentChatId && typeof link.groupIndex === 'number'
          ? deferredAsksOf(ctx)
              .waiting({
                kind: 'group',
                parentChatId: link.parentChatId,
                groupIndex: link.groupIndex,
              })
              .map((record) => record.id)
          : [],
    },
    // Ревью по ссылке (Т7): замечания из ответа — в связь, карточка — человеку.
    review: { onReviewFinished: (input) => splitReview.finished(input) },
    // Свои шаги «Пути» группы, выбранной в чате (своя или от родителя), —
    // сверенной с парой проекта прогона (`runGroupChoice`).
    pathSteps: {
      stepsAt: (aliases, stage, cwd) =>
        runPathSteps(ctx.store, ctx.location.paths.appData, aliases, stage, cwd),
    },
    // «Числа» группы звена — только изменённые человеком (`group-knobs.ts`).
    groupKnobs: (keys, cwd) => chatKnobsLine(ctx.store, ctx.location.paths.appData, keys, cwd),
  });
  chatRuns.setHandoffPlanner((finished) => {
    // Агент трогал папку e2e — её тесты в кейсы сразу, без просьбы человека.
    testsChat.finished(finished.options.cwd, finished.startedAt);
    // Убитый посреди тяжёлого шага CLI аренду очереди не отдаст — отдаём за него.
    if (finished.sessionId) releaseSessionLeases(heavyQueue.dir, finished.sessionId);
    const keys = finished.sessionId ? [finished.chatId, finished.sessionId] : [finished.chatId];
    tellsOnFinish(keys, finished.ok, finished.text);
    deferredWiring.finished(keys);
    chatAutonomy.finished(keys, finished.text);
    // Группа «по плану» кончила ход ожиданием ответа текстом — панель уже
    // продолжила ту же сессию: ни «ждёт вас», ни звена конвейера на этом конце.
    if (chatAutonomy.resumeWaiting(finished)) {
      pendingAsks.forget(keys);
      return undefined;
    }
    return settleFinish(finished);
  });
  /**
   * Конец хода обычным путём: вопросы хаба, повтор надзора, конвейер, продолжение.
   * Отдельно — потому что его же проводит отказ реестра в старте продолжения
   * группы «по плану» (F-44): иначе такой конец не дошёл бы ни до конвейера, ни до хаба.
   */
  function settleFinish(finished: RunFinished): ChatEvent | undefined {
    const keys = finished.sessionId ? [finished.chatId, finished.sessionId] : [finished.chatId];
    pendingAsks.finished(finished);
    // Обрыв — не упавший ход: его продолжает конвейер с восстановлением
    // состояния, и повтор надзора поверх завёл бы второй прогон той же группы.
    const decision =
      !finished.interrupted && isRetriedChild(keys) ? runRetry.finished(finished) : undefined;
    const retry = retryOutcome(decision);
    const planned = handoffPlanner(retry ? { ...finished, retry } : finished);
    // Дети разделения идут своим надзором; обычному чату на локальной модели — продолжение.
    const continued = isRetriedChild(keys)
      ? undefined
      : autoContinue.finished(finished, Boolean(planned));
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
  /**
   * Тот же конвейер «работа → ревью → правки», но у чужих CLI. Живёт не на
   * реестре прогонов (их разговоры идут мимо него вовсе), а на завершении ответа
   * и стадии в шапке разговора; решение принимает домен, снаружи ему нужны
   * провайдер, каталог моделей, настройки и один вопрос к git.
   */
  // Шлюз контуров: тоже слушатель на петле, тоже переживает запрос. Ключ он
  // читает сам, в момент запроса, — поэтому создаётся без настроек и знает
  // только состояние панели. Создан до планировщика стадий: маршрут дешёвой
  // доставки спрашивает его порт, и порядок вызовов тут ничего не решает.
  const platformGateway = new PlatformGateway();
  // Основа маршрутизации контура: хранилище, каталог данных, порт шлюза. Полный
  // набор (`platformRouting` ниже) добавляет к ней лишь части Claude и
  // локальных моделей — для маршрута `foreign:<cli>` они ничего не решают.
  const platformRoutingBase: PlatformRoutingDeps = {
    store: ctx.store,
    appDataDir: ctx.location.paths.appData,
    gatewayPort: () => (platformGateway.status().running ? platformGateway.status().port : 0),
  };
  const foreignStagePlanner = createForeignStagePlanner({
    chats: providerChats,
    // Claude сюда не попадает никогда: у него свой чат и свой конвейер.
    // Незнакомый id — не звено: `getProvider` откатился бы на Claude, а тот
    // отказался бы запускаться, оставив в переписке ошибку на пустом месте.
    provider: (id) =>
      id !== DEFAULT_PROVIDER_ID && isKnownProviderId(id) ? getProvider(id) : undefined,
    models: (provider) => ctx.models.current(provider.modelVendors ?? []).models,
    settings: () => ctx.store.getSettings(),
    // Строки группы звена — те же, что у ребёнка Claude (`childStageExtra`).
    childExtra: (key) => foreignChildExtra(ctx.store, ctx.location.paths.appData, key),
    // Свои шаги «Пути» группы звена — тем же чтением, что у Claude.
    pathSteps: (aliases, stage, cwd) =>
      runPathSteps(ctx.store, ctx.location.paths.appData, aliases, stage, cwd),
    hasWork: (cwd, since) => hasWorkSince(cwd, since),
    // Связи звеньев: та же группа и тот же родитель, новая стадия — без них
    // дерево чужого разделения видит одну работу.
    linkOf: (key) => ctx.store.getChatLink(key),
    saveLink: (key, link) => ctx.store.setChatLink(key, link),
    // Стоящее дерево звеньев не запускает: чат заведён, старт в очереди (Т5).
    gate: treePause,
    // Уровни (Т3): разбор у чужого CLI кончился — итог применяет тот же
    // конвейер, что и у Claude, а строка о нём уходит в ленту разбора.
    onTriage: ({ chatKey, ok, text }) => {
      const event = splitConveyor.onTriageFinished({ ok, text }, [chatKey]);
      return event?.kind === 'notice' ? event.text : undefined;
    },
    onChainEnded: (link, ok) => splitConveyor.onChainEnded(link, ok),
    // Доставка группы у чужого CLI — тем же звеном, что у Claude (W3-3).
    delivers: (link) => splitConveyor.delivers(link),
    // Доставка на самой дешёвой модели лестницы (рычаг `sonnetDeliver`) — тем же
    // выбором группы, что у Claude (`sonnetDeliverOf` его проводки выше).
    sonnetDeliverOf: (link) => splitConveyor.sonnetDeliverOf(link),
    // Маршрут CLI через контур — для дешёвой доставки: на контуре младшая ступень
    // берётся, только если её имя есть в карте моделей. Без этой зависимости
    // дешёвая доставка выключена (закрыто по умолчанию). Основа маршрутизации
    // объявлена выше — замыкание не зависит от того, когда его позовут.
    contourRoute: (providerId) => foreignDeliverContourRoute(platformRoutingBase, providerId),
    // Сита перед MR — тем же абзацем, что у звеньев Claude.
    sieves: stageSieves,
    // Ревью MR по ссылке (Т6): тот же домен, что у Claude, — замечания
    // читаются один раз и ложатся в связь, а решение ждёт человека.
    onReviewFinished: (input) => splitReview.finished(input),
    // Продолжение в чистой сессии (Т7): память цепочек ОДНА на оба
    // провайдера — тумблер, номер шага и отпечаток файла-опоры общие, иначе
    // «те же пределы» у чужого CLI оказались бы другими.
    chains: handoffChains,
  });
  providerChats.setFinishedListener((finished) => {
    testsChat.finished(
      readChat(ctx.location.paths.appData, finished.providerId, finished.chatId)?.workdir,
      finished.startedAt,
    );
    const key = foreignChatKey(finished.providerId, finished.chatId);
    tellsOnFinish([key], finished.ok, finished.text);
    chatAutonomy.finished([key], finished.text);
    // Надзор повторов и у чужого CLI (Д10). Сессии у него нет: продолжение —
    // реплика в тот же разговор, история уезжает вместе с ней.
    const retry = retryForeignRun(
      runRetry,
      {
        key,
        cwd: readChat(ctx.location.paths.appData, finished.providerId, finished.chatId)?.workdir,
        ok: finished.ok,
        ...(finished.error ? { error: finished.error } : {}),
        ...(finished.stopped ? { stopped: true } : {}),
        retried: isRetriedChild([key]),
      },
      (chatKey, options, meta) =>
        pausedGroup(chatKey) ||
        treePause.defer('stage', chatKey, options, meta) ||
        treeRuns.start(chatKey, options, meta),
      (message, error) => console.warn(message, error),
    );
    void foreignStagePlanner(retry ? { ...finished, retry } : finished);
  });
  // Прокси защиты данных: тоже слушатель, тоже переживает запрос. Создаётся
  // всегда, поднимается — только если человек включил его в настройках.
  const dlpProxy = new DlpProxy();
  /**
   * Порог бюджета контура — тем же слоем, что и концы прогонов (A-5).
   *
   * До этой строки порог считался и лежал в ответе, а читали его только карточка
   * контура и плитка «Обзор»: человек, работающий в чате, узнавал о лимите из
   * отказа 402. Push сюда НЕ входит намеренно — его тело открывает разговор, а у
   * бюджета разговора нет: он свойство контура, и тратят его все прогоны разом.
   */
  platformGateway.setBudgetNotifier((notice) => {
    const outward = {
      kind: notice.level === 'over' ? ('budgetOver' as const) : ('budgetNear' as const),
      platformTitle: notice.platformTitle,
      share: notice.share,
    };
    telegram(outward);
    webhook(outward);
  });
  /**
   * Подъём своего шлюза, когда его тумблер ВКЛЮЧЁН, а слушателя нет (A-1).
   *
   * Тумблер здесь не трогается ни разу: включить настройку за человека — дело
   * активации контура по его нажатию, а не расчёта плана картинки. Защёлка и
   * потолок попыток — внутри: расчёт зовут на каждое открытие меню чата.
   */
  const platformGatewayAutoStart = new GatewayAutoStart({
    enabled: () => ctx.store.getSettings().platformGateway.enabled,
    running: () => platformGateway.status().running,
    start: () =>
      platformGateway.start({
        store: ctx.store,
        appDataDir: ctx.location.paths.appData,
        port: ctx.store.getSettings().platformGateway.port,
        pricing: gatewayPricing(ctx.store, ctx.pricing),
      }),
  });
  /**
   * Фоновая перепроверка активного контура (A-2).
   *
   * Заводится здесь, потому что живёт дольше запроса и гаснет вместе с панелью.
   * На пути запроса её нет ни в одном месте: шлюз только СООБЩАЕТ ей об отказе
   * по правам и сразу возвращается, а ходит она своим таймером.
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
  platformGateway.setRightsRefusalNotifier((platformId) =>
    platformWatch.noteRightsRefusal(platformId),
  );
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
  // Лёгкий профиль запуска группы разделения (1.2): серверы из тех же файлов, что у
  // раздела «MCP», и только нужные группе — трекер, код, макеты по делу.
  // Навыки (1.3): описание — навыкам групп панели этого прогона и обязательным,
  // остальным личным — только имя; плагины — из `enabledPlugins` настроек.
  const skillScope = (keys: readonly string[], cwd: string): SkillScopeInput => ({
    user: readSkills(ctx.location.paths.skills, ctx.store)
      .filter((skill) => skill.isEnabled)
      .map((skill) => skill.name),
    group: effectiveGroupsForRun(
      { store: ctx.store, paths: ctx.location.paths },
      keys,
      cwd,
      'claude',
    ).flatMap((group) =>
      group.members.filter((member) => member.kind === 'skill').map((member) => member.id),
    ),
    plugins: Object.entries(
      readJsonFile<{ enabledPlugins?: Record<string, unknown> }>(ctx.location.paths.settings, {})
        .enabledPlugins ?? {},
    )
      .filter(([, on]) => on === true)
      .map(([plugin]) => plugin),
  });
  // Свёртка ответов записи в трекер (2.3): скрипт панели абсолютным путём — группа
  // зовёт его из своей копии.
  const trackerHook = `node "${fileURLToPath(new URL('../../../../../tools/tracker-brief-hook.mjs', import.meta.url))}"`;
  // Список задач без описаний (5.2): поиск и доска трекера — заголовками, и в группе,
  // и в обычном чате, где разделение может быть предложено.
  const boardHook = `node "${fileURLToPath(new URL('../../../../../tools/board-fields-hook.mjs', import.meta.url))}"`;
  chatRuns.setGroupProfileResolver((keys, cwd) => {
    // Лёгкий чат вопросов о ходе групп (5.1): ни MCP, ни навыков, ни правок. Навыки
    // не прочитались — перечень пуст, а запрет правок и оболочки остаётся: сбой
    // чтения прежде бросал отсюда и отказывал в каждом старте (ревью B1-F14).
    if (statusChats.parentOf(keys)) {
      let scope: SkillScopeInput = { user: [], group: [], plugins: [] };
      try {
        scope = skillScope(keys, cwd);
      } catch (error) {
        console.warn('status chat: skills unreadable, run without the skill list', error);
      }
      return statusRunProfile(scope);
    }
    const link = keys.map((key) => ctx.store.getChatLink(key)).find(Boolean);
    const input = link ? splitConveyor.profileInput(link) : undefined;
    if (!input) {
      return ctx.store.getSettings().taskSplitInitiative
        ? chatRunProfile({ boardHook })
        : undefined;
    }
    // Серверы — из проекта человека с ЕГО одобрением, не из копии: копия группы — новый
    // путь, а ветка в ней (разбор чужого MR) может нести свой `.mcp.json` с любой
    // командой, которую `--mcp-config` запустил бы без спроса. Не прочиталось —
    // группа идёт полным запуском, как до профиля, а не не идёт вовсе.
    // Окно сжатия читается на каждом запуске (переменная окружения, кэш не
    // трогает); рычаги экономии — на старте разговора: правка на странице
    // настроек доходит до следующего НОВОГО разговора группы без перезапуска
    // панели. Продолжение берёт закреплённые на первом старте: строка в
    // системном промпте и отвязка от редактора меняют начало запроса, и смена
    // посреди тёплой сессии переписала бы весь её кэш.
    const compactWindow = groupWindow();
    const current = ctx.store.getSettings().groupEconomy;
    const economy = current ? ctx.store.linkEconomy(keys, current) : undefined;
    try {
      return groupRunProfile({
        entries: mcpSource.list(input.projectPath, { approvedOnly: true }),
        tasksText: input.tasksText,
        extra: input.extra,
        skills: skillScope(keys, cwd),
        // Звено (L1.2, L1.3): план и ревью — MCP наружу только на чтение; ревью,
        // правки и доставка — описания только своих навыков. За звеном ревью или
        // доставка (L3) — их работа звену запрещена.
        ...(link
          ? { stage: stageOf(link), ahead: stagesAhead(link, splitConveyor.deliverAhead(link)) }
          : {}),
        trackerHook,
        boardHook,
        heavyQueue,
        bashCeilings: bashCeilingsAt(ctx.location.paths.settings, cwd),
        // Псевдонимы и функции снимка — правилами `ask`: их вызов судит брокер (24.10, a/d).
        shellNames: snapshotNames(shellSnapshotSync()),
        // Метка группы в окружении: суд погашения узнаёт по ней её сирот (D-1).
        ...(link && typeof link.groupIndex === 'number'
          ? { processMark: groupProcessMark(link.parentChatId, link.groupIndex) }
          : {}),
        ...(compactWindow ? { compactWindow } : {}),
        ...(economy ? { economy } : {}),
      });
    } catch (error) {
      console.warn('split group: run profile unreadable, run without it', error);
      return undefined;
    }
  });
  const localModels = createLocalModels({
    appRoot: appRootDir(),
    runActive: localRunActive,
    awakeHeld: () => keepAwake.status().held,
    claude: { settingsPath: () => ctx.location.paths.settings, backupDir: () => ctx.backupDir },
    // MCP-серверы локального прогона читаются теми же файлами и тем же клиентом, что раздел «MCP».
    mcp: mcpSource,
  });
  // Сессии из терминала и VS Code видны телефону только через хуки панели:
  // включённой пересылке они нужны с первого сеанса, без ручной установки.
  syncRelayHooks(ctx);
  // Раз в несколько секунд: запрет сна держится, пока идёт локальный прогон, а ждавший
  // перезапуск сервера выполняется, когда прогонов не осталось. Опрос, а не слушатели на
  // каждый путь завершения (конец, стоп, обрыв, усыновление): пути разные, итог один.
  const syncLocalRun = createRunSync({
    active: localRunActive,
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
  // Сторож повисших групп (строка 8 плана скорости гейтов): молчание дольше любого
  // законного вызова — обрыв с продолжением, а не часы «работает» до глаз человека.
  const stallWatch = createSplitStallWatch({
    plans: () => Object.values(ctx.store.getSplitPlans()),
    chatIdsOf: (record, group) => {
      const links = ctx.store.getChatLinks();
      const ids = groupChatIds(links, record, group);
      return [...new Set(ids.flatMap((id) => [id, ...conversationKeys(links, id)]))];
    },
    lastActivity: (ids) => transcriptActivity(projectsDir(ctx), ids),
    processAlive: (ids) => ids.some((id) => chatRuns.isProcessAlive(id)),
    waitingOnHuman: (ids) =>
      chatSession.pendingPermissions().some((pending) => ids.includes(pending.runId)),
    stop: (chatId) => chatRuns.stop(chatId),
    interrupt: (parentChatId, index) => splitConveyor.interruptStalled(parentChatId, index),
    // Что держало вызов — до снятия: снятие стирает улики (журнал 19.10, 4 ч и 7,7 ч ожидания).
    diagnose: ({ key, group, chatIds, silentMs }) =>
      writeStallLog(join(ctx.location.paths.appData, 'split-stall'), {
        key,
        group: group.title,
        chatIds,
        silentMs,
        copyPath: group.path,
        roots: [...new Set(chatIds.flatMap((id) => chatRuns.processRootsOf(id)))],
      }),
    notify: (parentChatId, group, silentMs, resumed, logPath) => {
      const params = {
        group: group.title,
        minutes: String(Math.round(silentMs / 60_000)),
        resumed: resumed ? '1' : '0',
      };
      const textCode = logPath ? 'split-group-stalled-log-notice' : 'split-group-stalled-notice';
      const textParams = logPath ? { ...params, log: logPath } : params;
      sayToParent(parentChatId, {
        kind: 'notice',
        code: 'groupStalled',
        text: serverText(textCode, textParams),
        textCode,
        textParams,
      });
    },
    log: (message, error) => console.warn(message, error ?? ''),
  });
  const stallTimer = setInterval(() => {
    stallWatch().catch((error: unknown) => console.warn('split stall: pass failed', error));
  }, STALL_POLL_MS);
  stallTimer.unref();
  // Включённому «Claude на локальной модели» нужен живой сервер с первого сеанса.
  void localModels.resume().catch((error: unknown) => {
    console.warn('local models: server for the Claude switch did not start', error);
  });
  const platformRouting: PlatformRoutingDeps = {
    ...platformRoutingBase,
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
  // Шлюз спрашивает окно локальной модели на каждый запрос: отказ «prompt is too
  // long» и срок первого байта считаются от настоящего окна сервера, а не от константы.
  platformGateway.setLocalUpstream((platformId, model) =>
    platformId === LOCAL_PLATFORM_ID ? localModels.upstream(model) : undefined,
  );
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
  projectTestRuns.setPlatformRouting(() => runRoute('tests'));
  projectTestRuns.setLanguage(() => (ctx.store.getSettings().language === 'en' ? 'en' : 'ru'));
  // Чат чужого CLI спрашивает за себя: потребитель `foreign:<cli>` собирается по
  // провайдеру разговора. Без этой строки галочка «Qwen Code» в мастере была бы
  // нарисованной — контур сохранил бы её, а прогон ушёл бы в облако вендора.
  providerChats.setPlatformRouting(runRoute);
  // Qwen Code / Codex на своём локальном сервере моделей (мимо контура) — тоже локальный
  // ход: без кэша провайдера, R2 молчит, пауза группы разговор не обрывает. Шлюз
  // панели (петлевой, но облачный) отличается по контурам и порту шлюза.
  providerChats.setOwnLocal((providerId, env, run) =>
    ownLocalEndpoint({
      providerId,
      env,
      ...run,
      platformIds: readPlatforms(ctx.store).map((platform) => platform.id),
      gatewayPort: platformRouting.gatewayPort(),
    }),
  );
  // Вызовы инструментов через контур видит только шлюз: чужой CLI их никуда не
  // пишет, а подсказка «модель могла не справиться» без счёта была бы гаданием.
  providerChats.setContourToolCalls((since) => platformGateway.toolCallsSince(since));
  // Сжатие истории контуром — по метке прогона в адресе шлюза, из журнала сжатий
  // на диске: у чужого CLI нет транскрипта, куда шлюз мог бы это вписать.
  providerChats.setContourSummarized((runTag) =>
    summarizedInRun(ctx.location.paths.appData, runTag),
  );
  // Надзиратель чужого прогона (П6.2): собственный механизм панели, написанный
  // хуком Claude, — калитка запросов — отыгрывается у ЛЮБОГО провайдера.
  // Спрашивается на каждом сообщении: выключенная калитка обязана перестать
  // действовать со следующего запроса.
  //
  // Хуков, перенесённых в файлы самой цели, здесь нет и быть не может: их
  // отыгрывает цель, и владельца события решает `hookEventOwner`.
  providerChats.setSupervisor((run) => {
    const hooks = [
      ...panelSupervisorHooks({
        settings: ctx.store.getSettings(),
        groups: ctx.store.getGroups(),
        hooksDir: ctx.location.paths.hooks,
        skillsDir: ctx.location.paths.skills,
      }),
      // Хуки групп прогона (Codex): в файлах CLI их нет, играет надзиратель.
      ...(run.layerHooks ?? []).map((hook) => ({ ...hook, owner: 'layer' as const })),
    ];
    if (hooks.length === 0) return undefined;

    // Транскрипт собирает хранилище разговоров — раскладкой `provider-chats/<id>`
    // владеет оно, и второй копии пути в проекте быть не должно. Пути нет
    // (идентификатор непригоден) — надзирателя не заводим вовсе: скрипт, которому
    // обещан `transcript_path`, получил бы пустую строку.
    const transcriptPath = chatTranscriptPath(run.appDataDir, run.providerId, run.chatId);
    if (!transcriptPath) return undefined;

    return {
      run: {
        providerId: run.providerId,
        sessionId: run.chatId,
        cwd: run.workdir ?? process.cwd(),
        transcriptPath,
      },
      hooks,
      ...(run.starting ? { sessionStart: 'startup' as const } : {}),
    };
  });
  // Хуки вызовов инструментов на проводе (П4.1): шлюз спрашивает по метке
  // прогона, реестр отвечает воротами того прогона. Реестр держится ЗДЕСЬ, а не
  // в слушателе, — он переживает перезапуск шлюза, а прогоны в этот момент идут.
  // Прогон, не открывший ворота, придерживать вызовы не заставляет: пустой
  // реестр означает прежнее поведение прослойки, а не ожидание решения, которое
  // никто не примет.
  //
  // Ворота по-прежнему не открывает никто, и теперь это видно точнее: набор
  // панели (выше) состоит из записей события `UserPromptSubmit`, а событий
  // инструментов в нём нет ни одной. Появятся — открывать ворота будет та же
  // врезка, другого места для этого не нужно.
  const toolGates = new ToolGateRegistry();
  platformGateway.setToolGate((runTag) => toolGates.gateOf(runTag));
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
  // И сервер OpenCode: обработчик выхода гасит его только при обычном выходе.
  reapPanelAgentOrphans(ctx.location.paths.appData, {}, OPENCODE_SERVE_PROCESS_LEDGER);
  opencodeServe.setLedger(
    new PanelAgentProcesses(
      () => ctx.location.paths.appData,
      undefined,
      OPENCODE_SERVE_PROCESS_LEDGER,
    ),
  );
  // Фоновый наблюдатель: сирота разбора прошлого запуска снимается, включённый
  // тумблер продолжает с того, что не успел разобрать.
  // Порт шлюза — живого слушателя: разбор через контур идёт тем же маршрутом,
  // что агент панели, и при погашенном шлюзе отказывает, а не уходит в облако.
  // Разбор самим чужим CLI идёт маршрутом его чата (`runRoute`).
  const watcher = createBackgroundWatcher(
    ctx,
    platformRouting.gatewayPort,
    () => localModels.claudeEnv(),
    (origin) => runRoute(origin),
  );
  watcher.resume();
  for (const entry of adopt) {
    if (entry.autoApprove) chatSession.armAutoApprove(entry.key, entry.autoApprove);
    if (!chatRuns.adopt(entry)) runLedger.remove(entry.key);
  }

  // Разбор разделения (Т1), не переживший перезапуск, — ровно здесь, ПОСЛЕ
  // усыновления: до него живой прогон разбора выглядел бы мёртвым, и запись
  // закрылась бы под идущим разбором. Живой продолжается как ни в чём не
  // бывало; мёртвый размораживает своё разделение — группы встают на вопрос
  // человеку в хабе родителя, и ни одна копия не заводится сама.
  for (const { parentChatId, event } of splitConveyor.recoverInterruptedTriage((chatId) =>
    chatRuns.isRunning(chatId),
  )) {
    sayToParent(parentChatId, event);
  }
  // Проверки доставки, оборванные прежним процессом, — заново (WP1b).
  splitConveyor.recoverDeliveryChecks();
  // Одноразовые базы ревью, забытые упавшей панелью: только свои, по метке, старше 12 часов.
  void sweepStaleReviewStands(execDocker, process.cwd()).catch((error: unknown) => {
    console.warn('[review-stand] stale sweep failed', error);
  });
  // Наблюдение за MR доставленных групп (WP1j): таймеры жили в прежнем процессе.
  mrWatch.recover();
  // Группы, чей прогон не пережил перезапуск, — прерваны и продолжаются (WP1c).
  // Тоже после усыновления: живой усыновлённый прогон — не обрыв.
  const groupAlive = (group: { chatId?: string }): boolean => {
    if (!group.chatId) return false;
    const keys = [group.chatId, ...conversationKeys(ctx.store.getChatLinks(), group.chatId)];
    return keys.some((key) => {
      const foreign = parseForeignChatKey(key);
      return foreign
        ? providerChats.status(foreign.chatId).isRunning
        : chatRuns.isProcessAlive(key);
    });
  };
  for (const { parentChatId, event } of splitConveyor.recoverInterruptedGroups(groupAlive)) {
    sayToParent(parentChatId, event);
  }
  // Ожидание сброса лимита подписки (журнал 89a): таймер жил в прежнем процессе.
  // ПОСЛЕ обрывов: запуск очереди отсюда синхронно ставит группам «стартует»
  // без чата, и сверка обрывов звала бы их оборванными (ревью 30.09).
  splitConveyor.recoverLimitWaits();

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

  const shutdown = (): void => {
    // Чаты Claude — НЕ гасим: CLI за посредником переживает перезапуск панели
    // вместе с фоновыми командами, и новый сервер подключается к нему по журналу
    // (решение W3-4a). Гаснет только то, что без сервера не живёт; остановить
    // всех — действие человека, а не побочный эффект Ctrl+C или сторожа.
    chatRuns.detachAll();
    projectRunner.stopAll();
    providerChats.stopAll();
    projectTestRuns.stopAll();
    projectTestManual.stopAll(new Date().toISOString());
    e2eRuns.stopAll();
    mutationChecks.stopAll();
    e2eWatch.close();
    // Хвост учёта расхода — тоже: он копится пачкой в памяти шлюза, и панель,
    // закрытая по Ctrl+C или перезапущенная сторожем, унесла бы с собой
    // последние секунды. Запись синхронная, выход она не задерживает.
    platformGateway.flushSpend();
    // Фоновая проба тоже гаснет: таймер с `unref` выход не задерживает, но
    // проба, начатая в секунду закрытия, дописала бы `state.json` уже после
    // того, как его сохранил кто-то другой.
    platformWatch.stop();
    // Сторож групп: отложенные числа сигналов — на диск, тик гаснет.
    groupWatcher.stop();
    // Пинги тёплого кэша: тик гаснет, идущий пинг погасил `detachAll` выше.
    keepWarm.stop();
    // Ждущие карточки агента — ответить отменой: иначе запрос переходника висит
    // до таймаута уже мёртвого процесса.
    panelPending.cancelAll();
    // Разбор наблюдателя — процесс CLI без сервера бессмысленен: снимаем.
    // Тумблер остаётся как был, после старта наблюдатель продолжит.
    watcher.shutdown();
    // Загрузки обрываются (докачаются с места), сервер моделей живёт дальше —
    // новый процесс панели подхватит его по записи.
    localModels.shutdown();
    clearInterval(localRunTimer);
    clearInterval(stallTimer);
    keepAwake.stop();
  };

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
    handoffChains,
    treePause,
    pendingAsks,
    providerChats,
    splitConveyor,
    statusChats,
    splitOverlap,
    splitReview,
    splitView: (chatIds) => {
      const view = splitConveyor.view(chatIds);
      if (view) mrStateRefresh.touch(view.parentChatId);
      return view;
    },
    recheckMr: (parentChatId, index) =>
      recheckDeliveredMr(
        {
          store: {
            get: (parent) => ctx.store.getSplitPlan(parent),
            set: (record) => ctx.store.setSplitPlan(record),
          },
          read: readMr,
          recheck: (parent, at, prompt) => splitConveyor.recheckDelivered(parent, at, prompt),
          scope: (record, group) =>
            group.path
              ? readRecheckScope({
                  mainDir: copyRootOf(record),
                  copy: group.path,
                  ...(group.base ? { base: group.base } : {}),
                })
              : Promise.resolve(undefined),
          log: (message, error) => console.warn(message, error),
        },
        parentChatId,
        index,
      ),
    dlpProxy,
    platformGateway,
    platformGatewayAutoStart,
    platformWatch,
    events,
    panelPending,
    selfBaseUrl,
    watcher,
    localModels,
    keepAwake,
    globalLayer,
    kit,
    verifyLedger,
    runRoute: (origin) => runRoute(origin),
    gatewayPort: platformRouting.gatewayPort,
    claudeSettingsRoute: platformRouting.claudeSettingsRoute,
    localMcpPicks: platformRouting.localMcpPicks,
    claudeSwitchEnv: () => localModels.claudeEnv(),
    shutdown,
  };
}

/**
 * Уведомление о прогоне тестов для Telegram: провалы важнее самого факта
 * завершения.
 *
 * Итог прогона уже посчитан реестром к моменту рассылки, поэтому число берётся
 * из него, а не считается заново. Провалов нет — уходит обычное «работа
 * закончена».
 */
function testNotice(notice: RunNotice, run: ProjectTestRun | undefined): TelegramNotice {
  const failed = run?.summary?.failed ?? 0;
  if (failed === 0) return notice;
  return {
    kind: 'testFailed',
    chatId: notice.chatId,
    projectPath: notice.projectPath,
    failed,
    total: run?.summary?.total,
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
