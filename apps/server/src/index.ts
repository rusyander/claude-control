import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ServerContext } from './context.ts';
import { allowedOrigins } from './lib/origin-guard/origin-guard.ts';
import { readApiToken } from './lib/api-token/api-token.ts';
import { registerAccessGate } from './lib/access-gate/access-gate.ts';
import { createBridgeTokenLedger } from './lib/bridge-tokens/bridge-tokens.ts';
import { createConfigWatcher } from './lib/config-watcher/config-watcher.ts';
import { appStateDomains } from './lib/app-state-events/app-state-events.ts';
import { registerEmptyBodyGuard } from './lib/empty-body.ts';
import { expandPathVars } from './lib/path-vars/path-vars.ts';
import { registerCodedErrors } from './lib/server-text/server-text.ts';
import { detectProviders } from './providers/detect/detect.ts';
import { autostartProjects } from './domains/project-runner/project-runner.ts';
import { isProjectOrCopy } from './domains/project-tests/project-tests.ts';
import { reconcileActivePlatform } from './domains/platform/activation/activation.ts';
import { startSandboxHousekeeping } from './domains/sandbox/SandboxConfig.ts';
import { createRuntime, installShutdownHandlers } from './bootstrap/runtime/runtime.ts';
import { buildRouteTable } from './bootstrap/route-table.ts';
import { registerContourPushHook } from './bootstrap/contour-push-hook.ts';
import { startupBanner } from './bootstrap/banner.ts';
import { forgetInheritedChildMarks } from './domains/chat/run-options/run-options.ts';

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

// До первого запуска чего-либо: панель, перезапущенная агентом группы, не
// передаёт его метки ребёнка ни одному своему прогону.
forgetInheritedChildMarks(process.env);
// Тоже до первого запуска: `%NVM_SYMLINK%` буквальным текстом в PATH оставлял чаты на чужом Node.
expandPathVars(process.env);

const ctx = new ServerContext();
const app = Fastify({
  logger: { level: 'warn' },
  // Ключ находки групп несёт путь проекта: глубокая папка Windows за 100 знаков давала 414 при импорте.
  routerOptions: { maxParamLength: 2048 },
});

// Два рубежа до маршрутов и до CORS: Origin и — при включённом удалённом
// доступе — токен. Тумблер читается на каждый запрос: он меняется на лету.
// Те же правила нужны агенту панели: его действия идут настоящими маршрутами.
const access = {
  allowedOrigins: ALLOWED_ORIGINS,
  requiresToken: () => ctx.store.getSettings().remoteAccess.enabled,
  expectedToken: readApiToken,
  // Мост сессии ядра (ход агента панели) входит своим токеном хода, а не токеном панели.
  bridges: createBridgeTokenLedger(),
};
registerAccessGate(app, access);

// Пустое тело — `{}`, а не `undefined`: почему это хук, а не правка по месту,
// написано в самом модуле.
registerEmptyBodyGuard(app);

// Ошибка с кодом текста, не пойманная маршрутом, уезжает с кодом (`server-text.ts`).
registerCodedErrors(app);

// Объекты, живущие дольше запроса, — только отсюда их можно погасить при выходе.
const runtime = createRuntime(ctx, `http://${HOST}:${PORT}`);

// Состояние читается на каждый sync, а не замыкается: и настройки, и
// расположение подменяются целиком при смене каталога (`ctx.relocate`).
const configWatcher = createConfigWatcher({
  read: () => ({ enabled: ctx.store.getSettings().watchFiles, paths: ctx.location.paths }),
  broadcast: (domains, path) => {
    runtime.events.broadcast(domains, path);
    // Правка файла пары — сверка замечает её и перезапускается сама (В5).
    if (domains.includes('globalLayer')) runtime.globalLayer.onGlobalChanged();
  },
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
app.addHook('onResponse', (request, reply, done) => {
  if (request.method !== 'GET') {
    configWatcher.sync();
    // Папки e2e — по тому же поводу: проект добавили или убрали из реестра,
    // тумблер наблюдения переключили.
    runtime.e2eWatch.sync();
    // Собственное состояние панели (настройки, группы, выбор группы) — на тот же
    // поток событий: иначе соседняя вкладка и телефон видят его только после F5.
    const domains = appStateDomains(request.method, request.url, reply.statusCode);
    if (domains.length > 0) runtime.events.broadcast(domains, '');
  }
  done();
});

// Правка контура доходит до шлюза человека у ядра до ответа на запрос (`contour-push-hook.ts`).
registerContourPushHook(app, runtime.contourPush);

// Читать ответ разрешено только своему интерфейсу. Запрос без Origin сюда
// доходит уже отфильтрованным гейтом выше, поэтому здесь он считается своим.
await app.register(cors, {
  origin: (origin, callback) => callback(null, !origin || ALLOWED_ORIGINS.has(origin)),
});

for (const register of buildRouteTable(runtime, access)) register(app, ctx);

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

// Папки e2e проектов ищутся обходом каждого проекта — после подъёма слушателя,
// чтобы готовность API не ждала обхода.
setImmediate(() => runtime.e2eWatch.sync());

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
// готовность API. Граница та же, что у ручного запуска: отметка у каталога вне
// проектов панели его команду не исполняет (F-16).
const autostarted = await autostartProjects(runtime.projectRunner, ctx.store, (path) =>
  isProjectOrCopy(
    path,
    ctx.store.getProjects().map((project) => project.path),
  ),
);

// Прокси защиты данных держит ядро (C3c): оно само открывает его по `settings.dlp.enabled` и
// повторяет настройку каждый такт, так что «панель перезапустилась, прокси не поднялся» больше
// не про панель. Баннер лишь называет, кто держит адрес.
const dlpNote = ctx.store.getSettings().dlp.enabled
  ? `Защита данных включена: слушатель :${ctx.store.getSettings().dlp.port} держит ядро`
  : '';

// Инвариант 1 сводится ЗДЕСЬ, на каждом старте, а не только на первом после
// Т2: настройки правит не одна панель — снимок с чужой машины и архив переноса
// приносят свои тумблеры. Делается ДО шлюза: тот показывает адреса по тумблерам,
// и погасить их после того, как человек прочитал баннер, было бы поздно. Сети
// здесь нет: только состояние панели.
reconcileActivePlatform(ctx.store);

// Шлюз контуров держит ядро (C3d): шлюз человека на хосте звеньев, адрес из настроек (5179) —
// тот, что уже вписан в конфигурацию CLI. Баннер называет, кто держит адрес; слушает ли он,
// говорит карточка шлюза (состояние ядра), а не панель.
const gatewayNote = ctx.store.getSettings().platformGateway.enabled
  ? `Шлюз контуров: 127.0.0.1:${ctx.store.getSettings().platformGateway.port} держит ядро`
  : '';

process.stdout.write(
  startupBanner({
    host: HOST,
    port: PORT,
    location: ctx.location,
    sandboxSweep,
    autostarted,
    dlpNote,
    gatewayNote,
  }),
);
