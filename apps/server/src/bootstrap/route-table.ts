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
import { registerProviderCompareRoutes } from '../routes/provider-compare-routes.ts';
import { registerFormatCheckRoutes } from '../routes/format-check-routes.ts';
import { registerPluginRoutes } from '../routes/plugin-routes.ts';
import { registerAssistantRoutes } from '../routes/assistant-routes.ts';
import { registerScriptRoutes } from '../routes/script-routes.ts';
import { registerChatRoutes } from '../routes/chat-routes.ts';
import { registerChatSplitRoutes } from '../routes/chat/split-routes.ts';
import { registerChatHandoffRoutes } from '../routes/chat/handoff-routes.ts';
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
import { registerProviderChatRoutes } from '../routes/provider-chat-routes.ts';
import { registerDlpRoutes } from '../routes/dlp-routes.ts';
import { registerPromptGateRoutes } from '../routes/prompt-gate-routes.ts';
import { registerRemoteRoutes } from '../routes/remote-routes.ts';
import { registerEventsRoutes } from '../routes/events-routes.ts';
import type { Runtime } from './runtime.ts';

/**
 * Все маршруты панели одной таблицей. Форма у модулей общая (`RouteRegistrar`),
 * поэтому строки читаются как список разделов, а не как набор разных вызовов;
 * тому, кому нужен долгоживущий объект, он подаётся замыканием — видно прямо
 * здесь, кто такой объект держит.
 */
export function buildRouteTable(runtime: Runtime): RouteRegistrar[] {
  const {
    chatRuns,
    chatSession,
    providerChats,
    handoffChains,
    projectRunner,
    projectTestRuns,
    dlpProxy,
    notifyRun,
    events,
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
    // Разделение задач по чатам заводит копии репозитория и открывает разговоры —
    // у Claude через реестр прогонов, у чужого CLI через его собственный сервис.
    // Поэтому оба живут дольше запроса и приходят сюда параметром.
    (instance, context) =>
      registerChatSplitRoutes(instance, context, {
        runs: chatRuns,
        providerChats,
        session: chatSession,
      }),
    // Продолжение в чистой сессии: маршруты заводят новый разговор по кнопке, а
    // цепочки (тумблер автомата и номер шага) переживают запрос — как и реестр.
    (instance, context) =>
      registerChatHandoffRoutes(instance, context, {
        runs: chatRuns,
        chains: handoffChains,
        session: chatSession,
        providerChats,
      }),
    (instance, context) => registerProviderChatRoutes(instance, context, providerChats),
    (instance, context) => registerProjectRunnerRoutes(instance, context, projectRunner),
    (instance, context) => registerProjectTestsRoutes(instance, context, projectTestRuns),
    (instance, context) => registerDlpRoutes(instance, context, dlpProxy),
    (instance, context) => registerRemoteRoutes(instance, context, notifyRun),
    registerPromptGateRoutes,
    // Поток событий об изменениях файлов: подписчиков держит хаб, рассылку по
    // нему ведёт наблюдатель за конфигами.
    (instance, context) => registerEventsRoutes(instance, context, events),
  ];
}
