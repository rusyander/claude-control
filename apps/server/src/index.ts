import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ServerContext } from './context.ts';
import { allowedOrigins } from './lib/origin-guard.ts';
import { readApiToken } from './lib/api-token.ts';
import { registerAccessGate } from './lib/access-gate.ts';
import { createConfigWatcher } from './lib/config-watcher.ts';
import { registerEmptyBodyGuard } from './lib/empty-body.ts';
import { detectProviders } from './providers/detect.ts';
import { autostartProjects } from './domains/project-runner.ts';
import { buildDlpRuntime } from './domains/dlp.ts';
import { startSandboxHousekeeping } from './domains/sandbox/SandboxConfig.ts';
import { createRuntime, installShutdownHandlers } from './bootstrap/runtime.ts';
import { buildRouteTable } from './bootstrap/route-table.ts';
import { startupBanner } from './bootstrap/banner.ts';

/**
 * Сборка сервера: гейт доступа, долгоживущие объекты, таблица маршрутов,
 * наблюдатель за конфигами, запуск. Сами части живут в `bootstrap/` и `lib/`
 * — здесь только порядок, в котором они соединяются.
 */

const PORT = Number(process.env.PORT ?? 5178);
const WEB_PORT = Number(process.env.WEB_PORT ?? 8888);
const HOST = '127.0.0.1'; // только локально: приложение читает и пишет личные конфиги

/** Свой интерфейс и никто больше — правила и их обоснование в origin-guard.ts. */
const ALLOWED_ORIGINS = allowedOrigins(WEB_PORT);

const ctx = new ServerContext();
const app = Fastify({ logger: { level: 'warn' } });

// Два рубежа до маршрутов и до CORS: Origin и — при включённом удалённом
// доступе — токен. Тумблер читается на каждый запрос: он меняется на лету.
registerAccessGate(app, {
  allowedOrigins: ALLOWED_ORIGINS,
  requiresToken: () => ctx.store.getSettings().remoteAccess.enabled,
  expectedToken: readApiToken,
});

// Пустое тело — `{}`, а не `undefined`: почему это хук, а не правка по месту,
// написано в самом модуле.
registerEmptyBodyGuard(app);

// Объекты, живущие дольше запроса, — только отсюда их можно погасить при выходе.
const runtime = createRuntime(ctx, `http://${HOST}:${PORT}`);

// Состояние читается на каждый sync, а не замыкается: и настройки, и
// расположение подменяются целиком при смене каталога (`ctx.relocate`).
const configWatcher = createConfigWatcher({
  read: () => ({ enabled: ctx.store.getSettings().watchFiles, paths: ctx.location.paths }),
  broadcast: runtime.events.broadcast,
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
  if (request.method !== 'GET') configWatcher.sync();
  done();
});

// Читать ответ разрешено только своему интерфейсу. Запрос без Origin сюда
// доходит уже отфильтрованным гейтом выше, поэтому здесь он считается своим.
await app.register(cors, {
  origin: (origin, callback) => callback(null, !origin || ALLOWED_ORIGINS.has(origin)),
});

for (const register of buildRouteTable(runtime)) register(app, ctx);

configWatcher.sync();

// Песочницы существуют только пока жив сервер: их реестр держится в памяти.
// Всё, что лежит на диске к моменту старта, — след аварийного завершения, а
// внутри копия .credentials.json. Подметаем, не дожидаясь, пока человек
// сделает это руками, и здесь же взводим периодическое подметание: раньше его
// заводило только создание песочницы, поэтому в сеансе, где модалку не
// открывали, брошенная копия доступа лежала до следующего перезапуска.
const sandboxSweep = startSandboxHousekeeping();

installShutdownHandlers(runtime);

await app.listen({ port: PORT, host: HOST });

// Прогрев кеша поиска CLI: первый `where`/`which` по всем провайдерам блокирует
// цикл событий ~1,5 с — лучше сразу после старта, чем на первом запросе панели.
setImmediate(() => {
  try {
    detectProviders(ctx.store);
  } catch {
    // Детект никогда не роняет сервер; прогрев — тем более.
  }
});

// Цели с включённым тумблером автозапуска поднимаются сами и БЕЗ браузера —
// панель уже открыта там, где нужно.
// Слушатель к этому моменту принят, так что медленный dev-сервер не задержит
// готовность API.
const autostarted = await autostartProjects(runtime.projectRunner, ctx.store);

// Прокси защиты данных поднимается сам, если он включён: CLI уже настроен на
// его адрес, и молчаливое «панель перезапустилась, прокси не поднялся» означало
// бы либо отказ всех запросов, либо — хуже — их уход в модель без фильтра.
let dlpNote = '';
if (ctx.store.getSettings().dlp.enabled) {
  const { dlpProxy } = runtime;
  try {
    await dlpProxy.start(buildDlpRuntime(ctx.store, ctx.location.paths.appData));
    dlpNote = `Защита данных: ${dlpProxy.status().address} → ${dlpProxy.status().upstream}`;
  } catch (error) {
    dlpNote = `Защита данных НЕ поднялась: ${error instanceof Error ? error.message : String(error)}`;
  }
}

process.stdout.write(
  startupBanner({
    host: HOST,
    port: PORT,
    location: ctx.location,
    sandboxSweep,
    autostarted,
    dlpNote,
  }),
);
