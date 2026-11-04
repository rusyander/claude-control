import type { RouteRegistrar } from '../routes/register.ts';
import { gateHumanRoutesFor } from '../routes/chat/human-only/ledger-gate.ts';
import { registerConfigRoutes } from '../routes/config-routes/config-routes.ts';
import { registerEnvTransferRoutes } from '../routes/env-transfer-routes/env-transfer-routes.ts';
import { registerEntityRoutes } from '../routes/entity-routes/entity-routes.ts';
import { registerProviderMcpRoutes } from '../routes/provider-mcp-routes/provider-mcp-routes.ts';
import { registerProviderEnvRoutes } from '../routes/provider-env-routes/provider-env-routes.ts';
import { registerProviderInstructionsRoutes } from '../routes/provider-instructions-routes.ts';
import { registerProviderRulesRoutes } from '../routes/provider-rules-routes.ts';
import { registerProviderHooksRoutes } from '../routes/provider-hooks-routes/provider-hooks-routes.ts';
import { registerProviderPluginsRoutes } from '../routes/provider-plugins-routes/provider-plugins-routes.ts';
import { registerProviderSkillsRoutes } from '../routes/provider-skills-routes/provider-skills-routes.ts';
import { registerProviderPermissionsRoutes } from '../routes/provider-permissions-routes/provider-permissions-routes.ts';
import { registerProviderKeysRoutes } from '../routes/provider-keys-routes/provider-keys-routes.ts';
import { registerLegacyGroupsRoutes } from '../routes/legacy-groups-routes/legacy-groups-routes.ts';
import { registerAnalyticsRoutes } from '../routes/analytics-routes/analytics-routes.ts';
import { registerAnalyticsSessionRoutes } from '../routes/analytics-session-routes/analytics-session-routes.ts';
import { registerModelRoutes } from '../routes/model-routes/model-routes.ts';
import { registerEndpointRoutes } from '../routes/endpoint-routes.ts';
import { registerProviderCheckRoutes } from '../routes/provider-check-routes.ts';
import { registerProviderPreviewRoutes } from '../routes/provider-preview-routes.ts';
import { registerConfigPreviewRoutes } from '../routes/config-preview-routes.ts';
import { registerProviderCompareRoutes } from '../routes/provider-compare-routes/provider-compare-routes.ts';
import { registerGlobalLayerRoutes } from '../routes/global-layer-routes.ts';
import { registerKitRoutes } from '../routes/kit-routes/kit-routes.ts';
import { registerPortabilityRoutes } from '../routes/portability-routes/portability-routes.ts';
import { registerPortabilityCarryRoutes } from '../routes/portability-carry-routes/portability-carry-routes.ts';
import { registerFormatCheckRoutes } from '../routes/format-check-routes/format-check-routes.ts';
import { registerPluginRoutes } from '../routes/plugin-routes/plugin-routes.ts';
import { registerAssistantRoutes } from '../routes/assistant-routes/assistant-routes.ts';
import { registerScriptRoutes } from '../routes/script-routes/script-routes.ts';
import { registerChatRoutes } from '../routes/chat-routes/chat-routes.ts';
import { registerChatCascadeRoutes } from '../routes/chat/cascade-routes.ts';
import { registerChatHandoffRoutes } from '../routes/chat/handoff-routes.ts';
import { registerChatTreeRoutes } from '../routes/chat/tree-routes/tree-routes.ts';
import { registerSandboxRoutes } from '../routes/sandbox-routes/sandbox-routes.ts';
import { registerResourceRoutes } from '../routes/resource-routes/resource-routes.ts';
import { registerBackupRoutes } from '../routes/backup-routes/backup-routes.ts';
import { registerHistoryRoutes } from '../routes/history-routes.ts';
import { registerSearchRoutes } from '../routes/search-routes.ts';
import { registerProjectRoutes } from '../routes/project-routes/project-routes.ts';
import { registerProjectLocalRoutes } from '../routes/project-local-routes.ts';
import { registerProviderProjectRoutes } from '../routes/provider-project-routes/provider-project-routes.ts';
import { registerProjectRunnerRoutes } from '../routes/project-runner-routes/project-runner-routes.ts';
import { registerComposeRoutes } from '../routes/compose-routes/compose-routes.ts';
import { registerBackendGuardRoutes } from '../routes/backend-guard-routes/backend-guard-routes.ts';
import { registerDatabaseRoutes } from '../routes/database-routes/database-routes.ts';
import { registerApiExplorerRoutes } from '../routes/api-explorer-routes/api-explorer-routes.ts';
import { registerLogsRoutes } from '../routes/logs-routes/logs-routes.ts';
import { registerProjectGitRoutes } from '../routes/project-git-routes/project-git-routes.ts';
import { registerSieveRoutes } from '../routes/sieve-routes.ts';
import { registerProjectFilesRoutes } from '../routes/project-files-routes/project-files-routes.ts';
import { registerProjectTestsRoutes } from '../routes/project-tests-routes/project-tests-routes.ts';
import { registerProjectTestsPublishRoutes } from '../routes/project-tests/publish-routes.ts';
import { registerIntegrationsRoutes } from '../routes/integrations-routes/integrations-routes.ts';
import { registerProviderChatRoutes } from '../routes/provider-chat-routes/provider-chat-routes.ts';
import { registerCompromiseRoutes } from '../routes/compromise-routes.ts';
import { registerMediaRoutes } from '../routes/media-routes/media-routes.ts';
import { registerPromptGateRoutes } from '../routes/prompt-gate-routes.ts';
import { registerPromptRoutes } from '../routes/prompt-routes/prompt-routes.ts';
import { phoneSigningGateFor } from '../routes/phone-signing-routes/phone-signing-gate.ts';
import { registerPhoneSigningRoutes } from '../routes/phone-signing-routes/phone-signing-routes.ts';
import { registerMobileApkRoutes } from '../routes/mobile-apk-routes/mobile-apk-routes.ts';
import { registerChangelogRoutes } from '../routes/changelog-routes/changelog-routes.ts';
import { registerEventsRoutes } from '../routes/events-routes.ts';
import { registerUsageLimitsRoutes } from '../routes/usage-limits-routes/usage-limits-routes.ts';
import { createUsageLimits } from '../domains/usage-limits/usage-limits.ts';
import { readClaudeCredentials } from '../lib/credentials/credentials.ts';
import { registerDevRestartRoutes } from '../routes/dev-restart-routes/dev-restart-routes.ts';
import { registerPanelAgentRoutes } from '../routes/panel-agent/panel-agent-routes/panel-agent-routes.ts';
import { registerPanelAgentRunRoutes } from '../routes/panel-agent/run-routes/run-routes.ts';
import { coreSupervisorRoutes } from './runtime/core-supervisor-wiring.ts';
import { gatewayRoutes } from './runtime/gateway-wiring.ts';
import { localModelsRoutes } from './runtime/local-models-wiring.ts';
import { notifyRoutes } from './runtime/notify-wiring.ts';
import type { AccessGateDeps } from '../lib/access-gate/access-gate.ts';
import { createBridgeTokenLedger } from '../lib/bridge-tokens/bridge-tokens.ts';
import { coreHomeOf } from '../lib/hop-recorder.mjs';
import { createCoreAskPort } from '../domains/core-ask/core-ask.ts';
import { helperCarryOf } from '../domains/core-ask/helper-carry.ts';
import type { Runtime } from './runtime/runtime.ts';

/**
 * Все маршруты панели одной таблицей. Форма у модулей общая (`RouteRegistrar`),
 * поэтому строки читаются как список разделов, а не как набор разных вызовов;
 * тому, кому нужен долгоживущий объект, он подаётся замыканием — видно прямо
 * здесь, кто такой объект держит.
 */
export function buildRouteTable(runtime: Runtime, access: AccessGateDeps): RouteRegistrar[] {
  const {
    chatRuns,
    chatSession,
    coreChats,
    foreignCarry,
    handoffChains,
    treePause,
    projectRunner,
    projectTestRuns,
    projectTestManual,
    e2eRuns,
    mutationChecks,
    e2eWatch,
    dlpProxy,
    platformGateway,
    notifyRun,
    events,
    panelPending,
    selfBaseUrl,
    localModels,
    globalLayer,
    kit,
  } = runtime;
  // Служебные вопросы модели (помощники, ассистент, агент панели) — вопрос ядра «ask»: маршрут,
  // контур и ключ судит ядро на каждом вопросе, галочка, снятая минуту назад, уже действует.
  const askPort = createCoreAskPort(() => coreHomeOf());
  // Окна помощника формы и структуры получают набор чужого CLI, как прежнее окно (G13).
  const helperCarry = helperCarryOf(foreignCarry);

  return [
    // Первым: ворота «только человек» на каждый маршрут `human:*` журнала
    // возможностей ставит хук `onRoute`, а он видит лишь маршруты после себя.
    gateHumanRoutesFor,
    // Вторым: подпись телефона на маршрутах решений встаёт ПОСЛЕ ворот человека.
    phoneSigningGateFor(chatRuns, chatSession),
    registerConfigRoutes,
    registerEnvTransferRoutes,
    registerEntityRoutes,
    registerProviderMcpRoutes,
    registerProviderEnvRoutes,
    registerProviderInstructionsRoutes,
    registerProviderRulesRoutes,
    registerProviderHooksRoutes,
    registerProviderPluginsRoutes,
    registerProviderSkillsRoutes,
    registerProviderPermissionsRoutes,
    registerProviderKeysRoutes,
    // Прежние группы — только чтение: работу ведёт ядро (этап 10, F1).
    registerLegacyGroupsRoutes,
    registerAnalyticsRoutes,
    // «Перейти» / «Остановить» у сессий аналитики: прогоны панели знает реестр.
    (instance, context) => registerAnalyticsSessionRoutes(instance, context, chatRuns),
    registerModelRoutes,
    registerEndpointRoutes,
    registerProviderCheckRoutes,
    registerProviderPreviewRoutes,
    registerConfigPreviewRoutes,
    registerProviderCompareRoutes,
    registerPortabilityRoutes,
    // Перенос незакрытой работы к новому CLI (П6.1). Живёт отдельно от переноса
    // среды: тому хватает хранилища, а этому нужны реестр прогонов, память
    // цепочек, права сессии и ручки ядра для чужого CLI — всё, что переживает запрос.
    (instance, context) =>
      registerPortabilityCarryRoutes(instance, context, {
        runs: chatRuns,
        chains: handoffChains,
        session: chatSession,
        coreChats,
        foreignCarry,
      }),
    registerFormatCheckRoutes,
    registerPluginRoutes,
    // Помощники формы и структуры, окно ассистента — вопросом ядра активным CLI.
    (instance, context) => registerAssistantRoutes(instance, context, askPort, helperCarry),
    registerScriptRoutes,
    registerSandboxRoutes,
    (instance, context) => registerResourceRoutes(instance, context, askPort, helperCarry),
    registerBackupRoutes,
    registerHistoryRoutes,
    registerSearchRoutes,
    registerProjectRoutes,
    registerProjectLocalRoutes,
    registerProviderProjectRoutes,
    // Реестр прогонов git-маршрутам нужен ровно за одним: не дать снести рабочую
    // копию, в которой прямо сейчас работает агент.
    (instance, context) => registerProjectGitRoutes(instance, context, chatRuns),
    // Сита перед MR: выученные по тредам MR и счёт блокеров.
    registerSieveRoutes,
    // Сверка сит панели с их копией в глобальном слое — вкладка «Глобальный слой».
    (instance, context) => registerGlobalLayerRoutes(instance, context, globalLayer),
    // Встроенный набор панели (В2): своя страница, режимы по CLI, копии «моё».
    (instance, context) =>
      registerKitRoutes(instance, context, kit, () => events.broadcast(['kit'], '')),
    registerProjectFilesRoutes,
    (instance, context) =>
      registerChatRoutes(
        instance,
        context,
        chatRuns,
        chatSession,
        (chatId) => treePause.awaitsHuman(chatId),
        // Пауза дерева — решение человека: досылка вкладки её не снимает.
        (chatId) => treePause.isPaused(chatId),
        runtime.outsideTurnEnded,
        () => runtime.contours.summarizedIds(),
      ),
    // Правило «подбирать модель под задачу»: одно положение на проект, без
    // зависимостей — ни реестр прогонов, ни сессия ему не нужны.
    registerChatCascadeRoutes,
    // Пауза дерева: «Остановить всё» / «Продолжить всё» у родителя и само
    // дерево для пульта. Объект переживает запрос — он же глушит автостарты.
    (instance, context) => registerChatTreeRoutes(instance, context, treePause),
    // Продолжение в чистой сессии: маршруты заводят новый разговор по кнопке, а
    // цепочки (тумблер автомата и номер шага) переживают запрос — как и реестр.
    (instance, context) =>
      registerChatHandoffRoutes(instance, context, {
        runs: chatRuns,
        chains: handoffChains,
        session: chatSession,
        coreChats,
        foreignCarry,
      }),
    (instance, context) => registerProviderChatRoutes(instance, context),
    (instance, context) => registerProjectRunnerRoutes(instance, context, projectRunner),
    // Compose проекта: реестр действий живёт внутри маршрутов — идущий docker
    // compose панели при выходе не гасим, контейнеры и так остаются как есть.
    (instance, context) => registerComposeRoutes(instance, context),
    // База проекта: только чтение; переходник MCP агента ходит сюда же.
    (instance, context) => registerDatabaseRoutes(instance, context, { selfBaseUrl }),
    // Защита бэкенда: хук и правило в .claude проекта, тот же вопрос в брокере прав.
    (instance, context) => registerBackendGuardRoutes(instance, context),
    // API проекта: контракт, запрос через сервер панели (без CORS), сверка ответа.
    (instance, context) =>
      registerApiExplorerRoutes(instance, context, { runs: () => projectRunner.list() }),
    // Логи: вывод целей «Dev-сервера» из реестра запусков и сервисов Compose от docker.
    (instance, context) =>
      registerLogsRoutes(instance, context, { runs: (path) => projectRunner.logsOf(path) }),
    // Тестам нужны оба реестра: прогоны агента и ручная сессия человека. Оба
    // переживают запрос — вкладку закрывают, а прогон идёт дальше.
    (instance, context) =>
      registerProjectTestsRoutes(instance, context, projectTestRuns, projectTestManual, {
        e2eRuns,
        e2eWatch,
        mutations: mutationChecks,
      }),
    // Публикация отчёта наружу — часть интеграций, а не раздела тестов: ей нужны
    // токен, привязка и живая сеть, а раздел обязан работать и без всего этого.
    registerProjectTestsPublishRoutes,
    // Внешние интеграции. Адрес панели известен только здесь (порт задаётся
    // переменной окружения), а переходнику MCP он нужен, чтобы знать, куда идти.
    (instance, context) => registerIntegrationsRoutes(instance, context, selfBaseUrl),
    // Маршруты по зонам этапа 10 (`runtime/<зона>-wiring.ts`): каждая зона правит свой список.
    // Ни один из них хуков не ставит, и все идут после хуков ответов Telegram, как и прежде.
    // Уведомления: ответы из Telegram и устройства телефона.
    ...notifyRoutes({
      chatRuns,
      chatSession,
      telegramAnswersCover: runtime.telegramAnswersCover,
      chatTitle: runtime.chatTitle,
      notifyRun,
    }),
    // Шлюз контуров и прокси защиты данных.
    ...gatewayRoutes({
      dlpProxy,
      platformGateway,
      selfBaseUrl,
      claudeSettingsRoute: runtime.claudeSettingsRoute,
      localMcpPicks: runtime.localMcpPicks,
    }),
    // Реестр подписанных компромиссов партии «контур». Своих зависимостей нет:
    // список статичен, а ведёт его сервер, чтобы снятая подпись гасла сама.
    registerCompromiseRoutes,
    // Локальные модели и сон машины с телефона.
    ...localModelsRoutes({ localModels, kit, keepAwake: runtime.keepAwake }),
    // Картинки и колоды из чата (Т9). Запрос в контур идёт через звено ядра под меткой
    // панели (C3b): адрес и заглушку ключа даёт клиент учёта контуров.
    (instance, context) =>
      registerMediaRoutes(instance, context, (id, fresh) => runtime.contours.link(id, fresh)),
    registerPhoneSigningRoutes,
    // Сборка APK телефона кнопкой из настроек — рядом с удалённым доступом.
    registerMobileApkRoutes,
    // Лента «Что нового»: описания из репозитория и факты из git.
    (instance) => registerChangelogRoutes(instance),
    registerPromptGateRoutes,
    // Каталог промптов приложения: тексты режимов лежат файлами, а не строками
    // в коде, и правка человека живёт отдельно от встроенного текста.
    registerPromptRoutes,
    // Поток событий об изменениях файлов: подписчиков держит хаб, рассылку по
    // нему ведёт наблюдатель за конфигами.
    (instance, context) => registerEventsRoutes(instance, context, events),
    // Лимиты подписки в боковой панели: один кэш на сервер, запрос к Anthropic —
    // только отсюда и не чаще раза в минуту, пока поток кто-то слушает.
    (instance, context) =>
      registerUsageLimitsRoutes(
        instance,
        createUsageLimits({
          credentials: () => readClaudeCredentials(context.location.paths.root),
          appDataDir: () => context.location.paths.appData,
          listeners: () => events.size(),
          changed: () => events.broadcast(['usage-limits'], ''),
        }),
      ),
    // Отложенный перезапуск dev-сервера: правки ждут живых ходов, панель это видит.
    registerDevRestartRoutes,
    // Прокладка к ядру — список зоны надзора за ядром.
    ...coreSupervisorRoutes(
      runtime.coreSupervisor,
      runtime.chatStartCarry,
      runtime.chatStartRoutes,
    ),
    // Агент панели: действия исполняются настоящими маршрутами через `inject`,
    // поэтому ему нужен тот же гейт доступа (токен при удалённом доступе), а
    // решению по карточке — список своих источников.
    (instance, context) =>
      registerPanelAgentRoutes(instance, context, {
        hub: events,
        pending: panelPending,
        access,
        ...(access.bridges ? { bridges: access.bridges } : {}),
      }),
    // Ход агента: сессия ядра «ask» с одним мостом панели. Адрес панели — тем же правилом, что у
    // брокера прав чата; маршрут и контур судит ядро.
    (instance, context) =>
      registerPanelAgentRunRoutes(instance, context, {
        selfBaseUrl: `http://127.0.0.1:${process.env.PORT ?? 5178}`,
        ask: askPort,
        bridges: access.bridges ?? createBridgeTokenLedger(),
        pending: panelPending,
      }),
  ];
}
