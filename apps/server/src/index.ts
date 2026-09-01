import { join } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ServerContext } from './context.ts';
import { allowedOrigins, isOAuthCallback, isRequestAllowed } from './lib/origin-guard.ts';
import { isValidApiToken, presentedToken, readApiToken } from './lib/api-token.ts';
import { createConfigWatcher } from './lib/config-watcher.ts';
import { registerEmptyBodyGuard } from './lib/empty-body.ts';
import { registerConfigRoutes } from './routes/config-routes.ts';
import { registerEnvTransferRoutes } from './routes/env-transfer-routes.ts';
import { registerEntityRoutes } from './routes/entity-routes.ts';
import { registerProviderMcpRoutes } from './routes/provider-mcp-routes.ts';
import { registerProviderEnvRoutes } from './routes/provider-env-routes.ts';
import { registerProviderInstructionsRoutes } from './routes/provider-instructions-routes.ts';
import { registerProviderRulesRoutes } from './routes/provider-rules-routes.ts';
import { registerProviderHooksRoutes } from './routes/provider-hooks-routes.ts';
import { registerProviderPluginsRoutes } from './routes/provider-plugins-routes.ts';
import { registerProviderSkillsRoutes } from './routes/provider-skills-routes.ts';
import { registerProviderPermissionsRoutes } from './routes/provider-permissions-routes.ts';
import { registerProviderKeysRoutes } from './routes/provider-keys-routes.ts';
import { registerGroupRoutes } from './routes/group-routes.ts';
import { registerAnalyticsRoutes } from './routes/analytics-routes.ts';
import { registerModelRoutes } from './routes/model-routes.ts';
import { registerEndpointRoutes } from './routes/endpoint-routes.ts';
import { registerProviderCheckRoutes } from './routes/provider-check-routes.ts';
import { registerProviderPreviewRoutes } from './routes/provider-preview-routes.ts';
import { registerProviderCompareRoutes } from './routes/provider-compare-routes.ts';
import { registerFormatCheckRoutes } from './routes/format-check-routes.ts';
import { registerPluginRoutes } from './routes/plugin-routes.ts';
import { registerAssistantRoutes } from './routes/assistant-routes.ts';
import { registerScriptRoutes } from './routes/script-routes.ts';
import { registerChatRoutes } from './routes/chat-routes.ts';
import { registerChatSplitRoutes } from './routes/chat/split-routes.ts';
import { createHandoffPlanner, registerChatHandoffRoutes } from './routes/chat/handoff-routes.ts';
import { HandoffChains } from './domains/chat/ChatHandoff.ts';
import { registerSandboxRoutes } from './routes/sandbox-routes.ts';
import { registerResourceRoutes } from './routes/resource-routes.ts';
import { registerBackupRoutes } from './routes/backup-routes.ts';
import { registerHistoryRoutes } from './routes/history-routes.ts';
import { registerSearchRoutes } from './routes/search-routes.ts';
import { registerProjectRoutes } from './routes/project-routes.ts';
import { registerProviderProjectRoutes } from './routes/provider-project-routes.ts';
import { registerProjectRunnerRoutes } from './routes/project-runner-routes.ts';
import { registerProjectGitRoutes } from './routes/project-git-routes.ts';
import { registerProjectFilesRoutes } from './routes/project-files-routes.ts';
import { registerProjectTestsRoutes } from './routes/project-tests-routes.ts';
import { registerProviderChatRoutes } from './routes/provider-chat-routes.ts';
import { registerDlpRoutes } from './routes/dlp-routes.ts';
import { registerPromptGateRoutes } from './routes/prompt-gate-routes.ts';
import { registerRemoteRoutes } from './routes/remote-routes.ts';
import { createRunNotifier } from './domains/remote-notify.ts';
import type { RouteRegistrar } from './routes/register.ts';
import { ChatRunRegistry } from './domains/chat/ChatRunRegistry.ts';
import { ProviderChatService } from './domains/provider-chat.ts';
import { ProjectRunnerRegistry, autostartProjects } from './domains/project-runner.ts';
import { ProjectTestRunRegistry } from './domains/project-tests.ts';
import { buildDlpRuntime, DlpProxy } from './domains/dlp.ts';
import { startSandboxHousekeeping } from './domains/sandbox/SandboxConfig.ts';

const PORT = Number(process.env.PORT ?? 5178);
const WEB_PORT = Number(process.env.WEB_PORT ?? 8888);
const HOST = '127.0.0.1'; // только локально: приложение читает и пишет личные конфиги

/** Свой интерфейс и никто больше — правила и их обоснование в origin-guard.ts. */
const ALLOWED_ORIGINS = allowedOrigins(WEB_PORT);

const ctx = new ServerContext();
const app = Fastify({ logger: { level: 'warn' } });

/**
 * Отказ выдаётся до маршрутов и до CORS — свой обработчик, а не ошибка плагина:
 * так чужой запрос не доходит до кода, а ответ остаётся понятным (403, а не 500).
 */
app.addHook('onRequest', (request, reply, done) => {
  const site = request.headers['sec-fetch-site'];
  const guarded = {
    method: request.method,
    url: request.url,
    origin: request.headers.origin,
    site: typeof site === 'string' ? site : undefined,
  };

  if (!isRequestAllowed(guarded, ALLOWED_ORIGINS)) {
    reply.code(403).send({ error: 'Запрос с постороннего сайта отклонён' });
    return;
  }

  /**
   * Второй рубеж — токен, и он поднимается только при включённом удалённом
   * доступе. Проверка Origin выше от телефона не защищает вовсе: заголовок
   * подделывает любой не-браузерный клиент, а через Tailscale Serve запрос
   * приходит с петли и от местного неотличим. Поэтому включённый доступ требует
   * токен ОТ ВСЕХ, включая свой интерфейс: прокси Vite подставляет его сам,
   * читая тот же файл на той же машине.
   */
  if (ctx.store.getSettings().remoteAccess.enabled && !isOAuthCallback(guarded)) {
    const presented = presentedToken(request.headers.authorization, request.query);
    if (!isValidApiToken(presented, readApiToken())) {
      reply.code(401).send({ error: 'Нужен токен доступа' });
      return;
    }
  }

  done();
});

// Пустое тело — `{}`, а не `undefined`: почему это хук, а не правка по месту,
// написано в самом модуле.
registerEmptyBodyGuard(app);

/**
 * Наблюдатель за файлами настраивается не только на старте: тумблер «следить за
 * изменениями» и каталог конфигурации меняются на лету (PATCH /api/settings,
 * POST /api/location, импорт состояния). Перечитываем состояние после каждого
 * изменяющего запроса — это дешёвая проверка слепка путей, зато панель не
 * остаётся ни со включённым наблюдением после выключения тумблера, ни со
 * следилкой по ПРЕЖНЕМУ каталогу после переезда. Хук объявлен до маршрутов:
 * добавленный позже, он бы к ним не применился.
 */
app.addHook('onResponse', (request, _reply, done) => {
  if (request.method !== 'GET') syncConfigWatcher();
  done();
});

// Читать ответ разрешено только своему интерфейсу. Запрос без Origin сюда
// доходит уже отфильтрованным хуком выше, поэтому здесь он считается своим.
await app.register(cors, {
  origin: (origin, callback) => callback(null, !origin || ALLOWED_ORIGINS.has(origin)),
});

// Объекты, живущие дольше запроса, создаются здесь: только отсюда их можно
// погасить при выходе. Реестр dev-серверов проектов — иначе спавненные процессы
// осиротеют; порт становится известен уже после ответа на запуск (его печатает
// сам dev-сервер), поэтому запоминает его реестр — через узкий колбэк, а не
// зная про состояние панели. Реестр прогонов чата — по той же причине.
const projectRunner = new ProjectRunnerRegistry({
  onPortDiscovered: ({ projectPath, dir, port }) => {
    const target = dir ? join(projectPath, dir) : projectPath;
    ctx.store.rememberRunnerPort(target, port, { projectPath, dir });
  },
});
const chatRuns = new ChatRunRegistry();
// Прогоны тестов — третий такой объект: агент ходит по кейсам минутами, и
// оборванный при выходе панели процесс остался бы висеть с полным доступом.
const projectTestRuns = new ProjectTestRunRegistry();
/**
 * Уведомления на телефон. Реестр прогонов знает, ЧТО случилось, но не знает ни
 * про устройства, ни про настройку — поэтому отправитель собирается здесь и
 * подаётся реестру тем же приёмом, что и оценка стоимости шага.
 */
const notifyRun = createRunNotifier({
  isEnabled: () => ctx.store.getSettings().remoteAccess.notify,
  devices: () => ctx.store.getPushDevices(),
  forget: (token) => ctx.store.removePushDevice(token),
});
chatRuns.setNotifier(notifyRun);
/**
 * Дерево чатов переживает смену ключа. Разделение заводит чат под временным
 * `new-<ts>-<n>`, а настоящий `sessionId` Claude Code выдаёт уже в прогоне —
 * и в списке чат появляется под ним. Без переноса связи ветвь дерева обрывалась
 * бы ровно в момент, когда чат становится настоящим.
 */
chatRuns.setSessionListener((chatId, sessionId) => ctx.store.linkChatSession(chatId, sessionId));
/**
 * Цепочки продолжений в чистой сессии: тумблер автомата и номер шага. Объект
 * переживает запрос — тумблер ставится в одном обращении, а срабатывает при
 * завершении прогона, возможно, уже без открытой вкладки.
 */
const handoffChains = new HandoffChains();
/**
 * Кто решает, продолжать ли работу самому. Реестр знает только, что прогон
 * кончился; предохранители (свежесть файла-опоры, потолок цепочки, успешное
 * завершение) живут в домене и подаются сюда тем же приёмом, что и уведомления.
 */
chatRuns.setHandoffPlanner(
  createHandoffPlanner({
    runs: chatRuns,
    chains: handoffChains,
    selfBaseUrl: `http://127.0.0.1:${process.env.PORT ?? 5178}`,
    contextLimit: () => ctx.store.getSettings().handoffContextLimit,
  }),
);
const providerChats = new ProviderChatService();
// Прокси защиты данных: тоже слушатель, тоже переживает запрос. Создаётся
// всегда, поднимается — только если человек включил его в настройках.
const dlpProxy = new DlpProxy();

/**
 * Все маршруты панели одной таблицей. Форма у модулей общая (`RouteRegistrar`),
 * поэтому строки читаются как список разделов, а не как набор разных вызовов;
 * тому, кому нужен долгоживущий объект, он подаётся замыканием — видно прямо
 * здесь, кто такой объект держит.
 */
const ROUTES: RouteRegistrar[] = [
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
  registerProviderProjectRoutes,
  // Реестр прогонов git-маршрутам нужен ровно за одним: не дать снести рабочую
  // копию, в которой прямо сейчас работает агент.
  (instance, context) => registerProjectGitRoutes(instance, context, chatRuns),
  registerProjectFilesRoutes,
  (instance, context) => registerChatRoutes(instance, context, chatRuns),
  // Разделение задач по чатам заводит копии репозитория и открывает разговоры —
  // у Claude через реестр прогонов, у чужого CLI через его собственный сервис.
  // Поэтому оба живут дольше запроса и приходят сюда параметром.
  (instance, context) =>
    registerChatSplitRoutes(instance, context, { runs: chatRuns, providerChats }),
  // Продолжение в чистой сессии: маршруты заводят новый разговор по кнопке, а
  // цепочки (тумблер автомата и номер шага) переживают запрос — как и реестр.
  (instance, context) =>
    registerChatHandoffRoutes(instance, context, {
      runs: chatRuns,
      chains: handoffChains,
      providerChats,
    }),
  (instance, context) => registerProviderChatRoutes(instance, context, providerChats),
  (instance, context) => registerProjectRunnerRoutes(instance, context, projectRunner),
  (instance, context) => registerProjectTestsRoutes(instance, context, projectTestRuns),
  (instance, context) => registerDlpRoutes(instance, context, dlpProxy),
  (instance, context) => registerRemoteRoutes(instance, context, notifyRun),
  registerPromptGateRoutes,
];

for (const register of ROUTES) register(app, ctx);

/**
 * Поток событий об изменениях файлов. Конфиги правит не только это приложение:
 * их меняет пользователь руками и сам Claude Code, — поэтому интерфейс должен
 * узнавать об этом и обновляться, а не показывать устаревшие данные.
 */
const subscribers = new Set<(event: string) => void>();

/**
 * Как часто в поток уходит пустой комментарий.
 *
 * Молчащее соединение рвут все, кто стоит между браузером и сервером, — прокси
 * разработки, NAT, спящий ноутбук, — и рвут ТИХО: сокет остаётся полуоткрытым,
 * ошибки браузер не видит, переподключаться не начинает. Панель после этого
 * живёт снимком: новый разговор из терминала или с телефона в списке не
 * появляется, лента не дописывается, и всё чинится только перезагрузкой
 * страницы. Регулярный байт в поток не даёт соединению замолчать, а если оно
 * всё-таки оборвалось — обрыв становится ЯВНЫМ, и клиент переподключается сам.
 */
const HEARTBEAT_MS = 25_000;

app.get('/api/events', (request, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Прокси разработки и обратные прокси иначе копят ответ в буфере: события
    // приходят пачкой через минуту вместо того, чтобы приходить сразу.
    'X-Accel-Buffering': 'no',
  });
  reply.raw.write(': connected\n\n');

  const send = (payload: string): void => {
    reply.raw.write(`data: ${payload}\n\n`);
  };
  subscribers.add(send);

  const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), HEARTBEAT_MS);
  // Таймер не должен держать процесс живым на выходе.
  heartbeat.unref?.();

  request.raw.on('close', () => {
    clearInterval(heartbeat);
    subscribers.delete(send);
  });
});

function broadcast(domains: string[], path: string): void {
  const payload = JSON.stringify({ type: 'changed', domains, path, at: new Date().toISOString() });
  for (const send of subscribers) send(payload);
}

// Состояние читается на каждый sync, а не замыкается: и настройки, и
// расположение подменяются целиком при смене каталога (`ctx.relocate`).
const configWatcher = createConfigWatcher({
  read: () => ({ enabled: ctx.store.getSettings().watchFiles, paths: ctx.location.paths }),
  broadcast,
});

/** Объявлена функцией: хук выше ссылается на неё до этой строки (подъём). */
function syncConfigWatcher(): void {
  configWatcher.sync();
}

syncConfigWatcher();

// Песочницы существуют только пока жив сервер: их реестр держится в памяти.
// Всё, что лежит на диске к моменту старта, — след аварийного завершения, а
// внутри копия .credentials.json. Подметаем, не дожидаясь, пока человек
// сделает это руками, и здесь же взводим периодическое подметание: раньше его
// заводило только создание песочницы, поэтому в сеансе, где модалку не
// открывали, брошенная копия доступа лежала до следующего перезапуска.
const sandboxSweep = startSandboxHousekeeping();

// Спавненные dev-серверы проектов и CLI чужих чатов живут в памяти процесса.
// Гасим их при выходе, чтобы дочерние процессы не осиротели и не держали
// занятыми порты.
const shutdownRunners = (): void => {
  projectRunner.stopAll();
  providerChats.stopAll();
  projectTestRuns.stopAll();
};
process.on('exit', shutdownRunners);
process.on('SIGINT', () => {
  shutdownRunners();
  process.exit(0);
});
process.on('SIGTERM', () => {
  shutdownRunners();
  process.exit(0);
});

await app.listen({ port: PORT, host: HOST });

// Цели с включённым тумблером автозапуска поднимаются сами и БЕЗ браузера —
// панель уже открыта там, где нужно.
// Слушатель к этому моменту принят, так что медленный dev-сервер не задержит
// готовность API.
const autostarted = await autostartProjects(projectRunner, ctx.store);

// Прокси защиты данных поднимается сам, если он включён: CLI уже настроен на
// его адрес, и молчаливое «панель перезапустилась, прокси не поднялся» означало
// бы либо отказ всех запросов, либо — хуже — их уход в модель без фильтра.
let dlpNote = '';
if (ctx.store.getSettings().dlp.enabled) {
  try {
    await dlpProxy.start(buildDlpRuntime(ctx.store, ctx.location.paths.appData));
    dlpNote = `Защита данных: ${dlpProxy.status().address} → ${dlpProxy.status().upstream}`;
  } catch (error) {
    dlpNote = `Защита данных НЕ поднялась: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const { location } = ctx;
process.stdout.write(
  [
    `Claude Control API: http://${HOST}:${PORT}`,
    `Каталог конфигурации: ${location.paths.root} (источник: ${location.source})`,
    location.isValid ? '' : `ВНИМАНИЕ: ${location.problem ?? 'каталог недоступен'}`,
    location.missing.length > 0 ? `Не найдено: ${location.missing.join(', ')}` : '',
    sandboxSweep.removed.length > 0
      ? `Убрано брошенных песочниц: ${sandboxSweep.removed.length} (в них лежала копия учётных данных)`
      : '',
    // Отказ уборки виден и здесь, а не только в потоке ошибок: внутри такой
    // папки осталась копия доступа к аккаунту, и убрать её может только человек.
    ...sandboxSweep.failed.map(
      (item) => `Песочницу не удалось убрать: ${item.path} — ${item.error}`,
    ),
    // Порт печатает сам dev-сервер, и к этому моменту он обычно ещё не назвался —
    // поэтому в строке либо уже известный порт, либо честное «адрес будет в панели».
    ...autostarted.started.map(
      (run) => `Автозапуск: ${run.path}${run.port ? ` → порт ${run.port}` : ' (адрес — в панели)'}`,
    ),
    ...autostarted.failed.map((run) => `Автозапуск не удался: ${run.path} — ${run.message}`),
    dlpNote,
    '',
  ]
    .filter(Boolean)
    .join('\n'),
);
