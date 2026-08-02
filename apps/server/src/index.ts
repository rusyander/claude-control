import { join } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ServerContext } from './context.ts';
import { allowedOrigins, isRequestAllowed } from './lib/origin-guard.ts';
import { createConfigWatcher } from './lib/config-watcher.ts';
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
import { registerProviderCheckRoutes } from './routes/provider-check-routes.ts';
import { registerProviderPreviewRoutes } from './routes/provider-preview-routes.ts';
import { registerProviderCompareRoutes } from './routes/provider-compare-routes.ts';
import { registerFormatCheckRoutes } from './routes/format-check-routes.ts';
import { registerPluginRoutes } from './routes/plugin-routes.ts';
import { registerAssistantRoutes } from './routes/assistant-routes.ts';
import { registerScriptRoutes } from './routes/script-routes.ts';
import { registerChatRoutes } from './routes/chat-routes.ts';
import { registerSandboxRoutes } from './routes/sandbox-routes.ts';
import { registerResourceRoutes } from './routes/resource-routes.ts';
import { registerBackupRoutes } from './routes/backup-routes.ts';
import { registerHistoryRoutes } from './routes/history-routes.ts';
import { registerSearchRoutes } from './routes/search-routes.ts';
import { registerProjectRoutes } from './routes/project-routes.ts';
import { registerProviderProjectRoutes } from './routes/provider-project-routes.ts';
import { registerProjectRunnerRoutes } from './routes/project-runner-routes.ts';
import { registerProjectGitRoutes } from './routes/project-git-routes.ts';
import { registerProviderChatRoutes } from './routes/provider-chat-routes.ts';
import type { RouteRegistrar } from './routes/register.ts';
import { ChatRunRegistry } from './domains/chat/ChatRunRegistry.ts';
import { ProviderChatService } from './domains/provider-chat.ts';
import { ProjectRunnerRegistry, autostartProjects } from './domains/project-runner.ts';
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

  const allowed = isRequestAllowed(
    {
      method: request.method,
      url: request.url,
      origin: request.headers.origin,
      site: typeof site === 'string' ? site : undefined,
    },
    ALLOWED_ORIGINS,
  );

  if (!allowed) {
    reply.code(403).send({ error: 'Запрос с постороннего сайта отклонён' });
    return;
  }

  done();
});

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
const providerChats = new ProviderChatService();

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
  registerProjectGitRoutes,
  (instance, context) => registerChatRoutes(instance, context, chatRuns),
  (instance, context) => registerProviderChatRoutes(instance, context, providerChats),
  (instance, context) => registerProjectRunnerRoutes(instance, context, projectRunner),
];

for (const register of ROUTES) register(app, ctx);

/**
 * Поток событий об изменениях файлов. Конфиги правит не только это приложение:
 * их меняет пользователь руками и сам Claude Code, — поэтому интерфейс должен
 * узнавать об этом и обновляться, а не показывать устаревшие данные.
 */
const subscribers = new Set<(event: string) => void>();

app.get('/api/events', (request, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  reply.raw.write(': connected\n\n');

  const send = (payload: string): void => {
    reply.raw.write(`data: ${payload}\n\n`);
  };
  subscribers.add(send);

  request.raw.on('close', () => {
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
    '',
  ]
    .filter(Boolean)
    .join('\n'),
);
