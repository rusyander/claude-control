import type { RouteRegistrar } from '../routes/register.ts';
import { registerConfigRoutes } from '../routes/config-routes.ts';
import { registerEnvTransferRoutes } from '../routes/env-transfer-routes.ts';
import { registerEntityRoutes } from '../routes/entity-routes.ts';
import { registerProviderMcpRoutes } from '../routes/provider-mcp-routes.ts';
import { registerProviderEnvRoutes } from '../routes/provider-env-routes.ts';
import { registerProviderInstructionsRoutes } from '../routes/provider-instructions-routes.ts';
import { registerProviderRulesRoutes } from '../routes/provider-rules-routes.ts';
import { registerProviderHooksRoutes } from '../routes/provider-hooks-routes.ts';
import { registerProviderPluginsRoutes } from '../routes/provider-plugins-routes.ts';
import { registerProviderSkillsRoutes } from '../routes/provider-skills-routes.ts';
import { registerProviderPermissionsRoutes } from '../routes/provider-permissions-routes.ts';
import { registerProviderKeysRoutes } from '../routes/provider-keys-routes.ts';
import { registerGroupRoutes } from '../routes/group-routes.ts';
import { registerAnalyticsRoutes } from '../routes/analytics-routes.ts';
import { registerModelRoutes } from '../routes/model-routes.ts';
import { registerEndpointRoutes } from '../routes/endpoint-routes.ts';
import { registerProviderCheckRoutes } from '../routes/provider-check-routes.ts';
import { registerProviderPreviewRoutes } from '../routes/provider-preview-routes.ts';
import { registerConfigPreviewRoutes } from '../routes/config-preview-routes.ts';
import { registerProviderCompareRoutes } from '../routes/provider-compare-routes.ts';
import { registerFormatCheckRoutes } from '../routes/format-check-routes.ts';
import { registerPluginRoutes } from '../routes/plugin-routes.ts';
import { registerAssistantRoutes } from '../routes/assistant-routes.ts';
import { registerScriptRoutes } from '../routes/script-routes.ts';
import { registerChatRoutes } from '../routes/chat-routes.ts';
import { registerChatSplitRoutes } from '../routes/chat/split-routes.ts';
import { registerChatCascadeRoutes } from '../routes/chat/cascade-routes.ts';
import { registerChatHandoffRoutes } from '../routes/chat/handoff-routes.ts';
import { registerChatTreeRoutes } from '../routes/chat/tree-routes.ts';
import { registerSandboxRoutes } from '../routes/sandbox-routes.ts';
import { registerResourceRoutes } from '../routes/resource-routes.ts';
import { registerBackupRoutes } from '../routes/backup-routes.ts';
import { registerHistoryRoutes } from '../routes/history-routes.ts';
import { registerSearchRoutes } from '../routes/search-routes.ts';
import { registerProjectRoutes } from '../routes/project-routes.ts';
import { registerProjectLocalRoutes } from '../routes/project-local-routes.ts';
import { registerProviderProjectRoutes } from '../routes/provider-project-routes.ts';
import { registerProjectRunnerRoutes } from '../routes/project-runner-routes.ts';
import { registerProjectGitRoutes } from '../routes/project-git-routes.ts';
import { registerProjectFilesRoutes } from '../routes/project-files-routes.ts';
import { registerProjectTestsRoutes } from '../routes/project-tests-routes.ts';
import { registerProjectTestsPublishRoutes } from '../routes/project-tests/publish-routes.ts';
import { registerIntegrationsRoutes } from '../routes/integrations-routes.ts';
import { registerProviderChatRoutes } from '../routes/provider-chat-routes.ts';
import { registerDlpRoutes } from '../routes/dlp-routes.ts';
import { registerCompromiseRoutes } from '../routes/compromise-routes.ts';
import { registerPlatformRoutes } from '../routes/platform-routes.ts';
import { registerMediaRoutes } from '../routes/media-routes.ts';
import { registerPromptGateRoutes } from '../routes/prompt-gate-routes.ts';
import { registerPromptRoutes } from '../routes/prompt-routes.ts';
import { registerRemoteRoutes } from '../routes/remote-routes.ts';
import { registerEventsRoutes } from '../routes/events-routes.ts';
import { registerPanelAgentRoutes } from '../routes/panel-agent/panel-agent-routes.ts';
import { registerPanelAgentRunRoutes } from '../routes/panel-agent/run-routes.ts';
import type { AccessGateDeps } from '../lib/access-gate.ts';
import type { Runtime } from './runtime.ts';

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
    providerChats,
    handoffChains,
    treePause,
    splitConveyor,
    splitOverlap,
    splitReview,
    projectRunner,
    projectTestRuns,
    projectTestManual,
    dlpProxy,
    platformGateway,
    notifyRun,
    events,
    panelPending,
    selfBaseUrl,
  } = runtime;

  return [
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
    registerGroupRoutes,
    registerAnalyticsRoutes,
    registerModelRoutes,
    registerEndpointRoutes,
    registerProviderCheckRoutes,
    registerProviderPreviewRoutes,
    registerConfigPreviewRoutes,
    registerProviderCompareRoutes,
    registerFormatCheckRoutes,
    registerPluginRoutes,
    registerAssistantRoutes,
    registerScriptRoutes,
    registerSandboxRoutes,
    registerResourceRoutes,
    registerBackupRoutes,
    registerHistoryRoutes,
    registerSearchRoutes,
    registerProjectRoutes,
    registerProjectLocalRoutes,
    registerProviderProjectRoutes,
    // Реестр прогонов git-маршрутам нужен ровно за одним: не дать снести рабочую
    // копию, в которой прямо сейчас работает агент.
    (instance, context) => registerProjectGitRoutes(instance, context, chatRuns),
    registerProjectFilesRoutes,
    (instance, context) => registerChatRoutes(instance, context, chatRuns, chatSession),
    // Правило «подбирать модель под задачу»: одно положение на проект, без
    // зависимостей — ни реестр прогонов, ни сессия ему не нужны.
    registerChatCascadeRoutes,
    // Разделение задач по чатам заводит копии репозитория и открывает разговоры —
    // у Claude через реестр прогонов, у чужого CLI через его собственный сервис.
    // Поэтому оба живут дольше запроса и приходят сюда параметром.
    (instance, context) =>
      registerChatSplitRoutes(instance, context, {
        runs: chatRuns,
        providerChats,
        session: chatSession,
        gate: treePause,
        conveyor: splitConveyor,
        overlap: splitOverlap,
        review: splitReview,
      }),
    // Пауза дерева: «Остановить всё» / «Продолжить всё» у родителя и само
    // дерево для пульта. Объект переживает запрос — он же глушит автостарты.
    (instance, context) =>
      registerChatTreeRoutes(instance, context, treePause, (ids) => splitConveyor.view(ids)),
    // Продолжение в чистой сессии: маршруты заводят новый разговор по кнопке, а
    // цепочки (тумблер автомата и номер шага) переживают запрос — как и реестр.
    (instance, context) =>
      registerChatHandoffRoutes(instance, context, {
        runs: chatRuns,
        chains: handoffChains,
        session: chatSession,
        providerChats,
      }),
    (instance, context) =>
      registerProviderChatRoutes(instance, context, providerChats, handoffChains),
    (instance, context) => registerProjectRunnerRoutes(instance, context, projectRunner),
    // Тестам нужны оба реестра: прогоны агента и ручная сессия человека. Оба
    // переживают запрос — вкладку закрывают, а прогон идёт дальше.
    (instance, context) =>
      registerProjectTestsRoutes(instance, context, projectTestRuns, projectTestManual),
    // Публикация отчёта наружу — часть интеграций, а не раздела тестов: ей нужны
    // токен, привязка и живая сеть, а раздел обязан работать и без всего этого.
    registerProjectTestsPublishRoutes,
    // Внешние интеграции. Адрес панели известен только здесь (порт задаётся
    // переменной окружения), а переходнику MCP он нужен, чтобы знать, куда идти.
    (instance, context) => registerIntegrationsRoutes(instance, context, selfBaseUrl),
    (instance, context) => registerDlpRoutes(instance, context, dlpProxy),
    // Реестр подписанных компромиссов партии «контур». Своих зависимостей нет:
    // список статичен, а ведёт его сервер, чтобы снятая подпись гасла сама.
    registerCompromiseRoutes,
    // Контуры: список, настройка, ключ и проба по кнопке. Сам поход в контур
    // случается по нажатию, а не по расписанию; долгоживущий здесь только
    // слушатель шлюза — он переживает запрос и потому приходит извне. Адрес
    // панели нужен по той же причине, что и интеграциям: переходник MCP ходит
    // не в контур, а сюда, и в его записи лежит только этот адрес.
    (instance, context) => registerPlatformRoutes(instance, context, platformGateway, selfBaseUrl),
    // Картинки из чата (Т9). Порт спрашивается у ЖИВОГО слушателя, а не у
    // настроек: запрос в контур идёт через шлюз, а задуманный порт мог быть
    // занят — тогда настройка указывает на чужой процесс.
    (instance, context) =>
      registerMediaRoutes(
        instance,
        context,
        () => (platformGateway.status().running ? platformGateway.status().port : 0),
        {
          raise: () => runtime.platformGatewayAutoStart.ensure(),
          failure: () => runtime.platformGatewayAutoStart.state().error,
        },
      ),
    (instance, context) => registerRemoteRoutes(instance, context, notifyRun),
    registerPromptGateRoutes,
    // Каталог промптов приложения: тексты режимов лежат файлами, а не строками
    // в коде, и правка человека живёт отдельно от встроенного текста.
    registerPromptRoutes,
    // Поток событий об изменениях файлов: подписчиков держит хаб, рассылку по
    // нему ведёт наблюдатель за конфигами.
    (instance, context) => registerEventsRoutes(instance, context, events),
    // Агент панели: действия исполняются настоящими маршрутами через `inject`,
    // поэтому ему нужен тот же гейт доступа (токен при удалённом доступе), а
    // решению по карточке — список своих источников.
    (instance, context) =>
      registerPanelAgentRoutes(instance, context, { hub: events, pending: panelPending, access }),
    // Ход агента: процесс `claude` с одним переходником. Адрес панели — тем же
    // правилом, что у брокера прав чата; шлюз — живым портом, а не настройкой.
    (instance, context) =>
      registerPanelAgentRunRoutes(instance, context, {
        selfBaseUrl: `http://127.0.0.1:${process.env.PORT ?? 5178}`,
        gatewayPort: () =>
          runtime.platformGateway.status().running ? runtime.platformGateway.status().port : 0,
        pending: panelPending,
      }),
  ];
}
