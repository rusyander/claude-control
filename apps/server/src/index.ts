import { watch, type FSWatcher } from 'chokidar';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ServerContext } from './context.ts';
import { registerConfigRoutes } from './routes/config-routes.ts';
import { registerConfigBundleRoutes } from './routes/config-bundle-routes.ts';
import { registerEntityRoutes } from './routes/entity-routes.ts';
import { registerGroupRoutes } from './routes/group-routes.ts';
import { registerAnalyticsRoutes } from './routes/analytics-routes.ts';
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
import { registerProjectRunnerRoutes } from './routes/project-runner-routes.ts';
import { ProjectRunnerRegistry } from './domains/project-runner.ts';
import { sweepAbandonedSandboxes } from './domains/sandbox/SandboxConfig.ts';

const PORT = Number(process.env.PORT ?? 5178);
const WEB_PORT = Number(process.env.WEB_PORT ?? 8888);
const HOST = '127.0.0.1'; // только локально: приложение читает и пишет личные конфиги

/**
 * Свой интерфейс и никто больше. У API нет аутентификации — он по построению
 * отдаёт секреты (`/api/env/reveal`) и заводит хуки, то есть команды, которые
 * Claude Code выполнит сам. Пока сервер запущен, он доступен и любой открытой
 * вкладке: браузер отправит запрос на localhost с чужой страницы. Отражать
 * присланный Origin поэтому нельзя — иначе сторонний сайт вычитает токены
 * из .mcp-secrets.env и поставит хук с произвольной командой.
 */
const ALLOWED_ORIGINS = new Set([`http://localhost:${WEB_PORT}`, `http://127.0.0.1:${WEB_PORT}`]);

/** Запрос без Origin — curl, сам сервер, переход по адресу: не кросс-доменный вызов. */
function isAllowedOrigin(origin: string | undefined): boolean {
  return !origin || ALLOWED_ORIGINS.has(origin);
}

const ctx = new ServerContext();
const app = Fastify({ logger: { level: 'warn' } });

/**
 * Отказ выдаётся до маршрутов и до CORS — свой обработчик, а не ошибка плагина:
 * так чужой запрос не доходит до кода, а ответ остаётся понятным (403, а не 500).
 *
 * Проверок две. Origin ловит обычный кросс-доменный вызов. Sec-Fetch-Site нужен
 * там, где Origin не присылают: форма или <img> с чужой страницы уходят на
 * localhost и без него, а CORS ограничивает лишь чтение ответа — не отправку.
 */
app.addHook('onRequest', (request, reply, done) => {
  const origin = request.headers.origin;
  const site = request.headers['sec-fetch-site'];

  // Возврат с сервера авторизации MCP — это переход по адресу в отдельном окне
  // с чужого домена, то есть заведомо cross-site. Пропускаем именно его: это
  // GET без побочных эффектов, а сам вход защищён параметром state, который
  // сгенерировали мы, — подделать его нельзя. Всё прочее остаётся под запретом.
  const path = request.url.split('?')[0];
  const isOAuthCallback = request.method === 'GET' && path === '/api/mcp/oauth/callback';

  if (!isOAuthCallback && (!isAllowedOrigin(origin) || site === 'cross-site')) {
    reply.code(403).send({ error: 'Запрос с постороннего сайта отклонён' });
    return;
  }

  done();
});

await app.register(cors, {
  origin: (origin, callback) => callback(null, isAllowedOrigin(origin ?? undefined)),
});

registerConfigRoutes(app, ctx);
registerConfigBundleRoutes(app, ctx);
registerEntityRoutes(app, ctx);
registerGroupRoutes(app, ctx);
registerAnalyticsRoutes(app, ctx);
registerPluginRoutes(app, ctx);
registerAssistantRoutes(app);
registerScriptRoutes(app, ctx);
registerChatRoutes(app, ctx);
registerSandboxRoutes(app, ctx);
registerResourceRoutes(app, ctx);
registerBackupRoutes(app, ctx);
registerHistoryRoutes(app, ctx);
registerSearchRoutes(app, ctx);
registerProjectRoutes(app, ctx);

// Реестр dev-серверов проектов держим здесь, а не внутри маршрутов: при выходе
// сервера панели их надо погасить (иначе спавненные процессы осиротеют).
const projectRunner = new ProjectRunnerRegistry();
registerProjectRunnerRoutes(app, ctx, projectRunner);

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

let watcher: FSWatcher | undefined;

function startWatching(): void {
  void watcher?.close();
  if (!ctx.store.getSettings().watchFiles) return;

  const { paths } = ctx.location;
  watcher = watch(
    [
      paths.settings,
      paths.settingsLocal,
      paths.claudeMd,
      paths.secretsEnv,
      paths.skills,
      paths.mcpConfig,
    ],
    {
      ignoreInitial: true,
      // Конфиги пишутся целиком, и без задержки прилетает событие на недописанный
      // файл — читать его бессмысленно, получим то старое, то битое содержимое.
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      depth: 3,
    },
  );

  watcher.on('all', (_event, changedPath) => {
    broadcast(domainsForPath(changedPath), changedPath);
  });
}

function domainsForPath(changedPath: string): string[] {
  const { paths } = ctx.location;
  if (changedPath.startsWith(paths.skills)) return ['skills'];
  if (changedPath === paths.claudeMd) return ['rules'];
  if (changedPath === paths.mcpConfig) return ['mcp'];
  if (changedPath === paths.secretsEnv) return ['env'];
  // Локальные настройки попадают в те же списки: панель показывает их наравне
  // с основными, поэтому и обновлять надо то же самое.
  if (changedPath === paths.settings || changedPath === paths.settingsLocal) {
    return ['hooks', 'permissions', 'env'];
  }
  return ['overview'];
}

startWatching();

// Песочницы существуют только пока жив сервер: их реестр держится в памяти.
// Всё, что лежит на диске к моменту старта, — след аварийного завершения, а
// внутри копия .credentials.json. Подметаем, не дожидаясь, пока человек
// сделает это руками.
const sweptSandboxes = sweepAbandonedSandboxes();

// Спавненные dev-серверы проектов живут в памяти процесса. Гасим их при выходе,
// чтобы дочерние процессы не осиротели и не держали занятыми порты.
const shutdownRunners = (): void => projectRunner.stopAll();
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

const { location } = ctx;
process.stdout.write(
  [
    `Claude Control API: http://${HOST}:${PORT}`,
    `Каталог конфигурации: ${location.paths.root} (источник: ${location.source})`,
    location.isValid ? '' : `ВНИМАНИЕ: ${location.problem ?? 'каталог недоступен'}`,
    location.missing.length > 0 ? `Не найдено: ${location.missing.join(', ')}` : '',
    sweptSandboxes.length > 0
      ? `Убрано брошенных песочниц: ${sweptSandboxes.length} (в них лежала копия учётных данных)`
      : '',
    '',
  ]
    .filter(Boolean)
    .join('\n'),
);
