/**
 * Переезд драйвера платформы компании на нейтральное имя через НАСТОЯЩИЙ запуск
 * сервера.
 *
 *   node tools/qa/check-platform-rename.mjs
 *
 * Стенд человека не нужен и не трогается: во временном каталоге лежит домашний
 * каталог «как до переименования» — `state.json` с контуром под прежним именем
 * драйвера (без префикса полей: так его писала прежняя панель) и ключ контура в
 * зашифрованном хранилище. Над контуром стоит `stub-platform.mjs`, который
 * называет вендорные поля ПРЕЖНИМ словом — как настоящая установка платформы.
 *
 * Доказательства — только снаружи процесса:
 *  - на диске запись переписана нынешним именем и прежним префиксом полей;
 *  - карточка отдаёт нынешний драйвер, правила на проводе названы прежним словом;
 *  - запрос через шлюз панели: стадии контура распознаны, обрыв проверками стал
 *    ошибкой с названиями проверок, вендорный кадр клиенту не уехал;
 *  - дверь сохранения принимает прежнее имя и пишет нынешнее;
 *  - второй запуск файл не трогает.
 *
 * Без переезда (`migrateLegacyPlatform` вернёт запись как есть) контур читается
 * совместимым шлюзом: кадры платформы не узнаются — проверка краснеет.
 * Каталоги проверки остаются в `.agent/tmp/platform-rename/` — это улика.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startStubPlatform } from './stub-platform.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const PORT = Number(process.env.CHECK_PORT ?? 5271);
const GATEWAY_PORT = Number(process.env.CHECK_GATEWAY_PORT ?? 5272);
/** Прежнее имя драйвера — то самое слово, которым платформа называет свои поля. */
// Записано задом наперёд, иначе, чем в `platform-legacy.ts`: литерала в дереве нет
// (историю переписывают заменой слова), а проверка ловит ошибку сборки имени.
const LEGACY = [...'anogrog'].reverse().join('');
/** Префикс переменных панели под прежним именем продукта. */
const OLD_ENV = [...'LORTNOC_EDUALC'].reverse().join('');
const CONTOUR = 'corp-legacy';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const base = join(ROOT, '.agent', 'tmp', 'platform-rename', stamp);
const home = join(base, 'home');
const configDir = join(home, '.claude');
const appData = join(configDir, 'agentdeck');
const stateFile = join(appData, 'state.json');
// Одноразовое значение, созданное здесь же: настоящих секретов проверка не видит.
const key = `stub-${randomBytes(12).toString('hex')}`;

let failed = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? '✓' : '✕'} ${label}${ok || !detail ? '' : `\n    ${detail}`}`);
  if (!ok) failed += 1;
}

function portOpen(port) {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

async function boot() {
  if (await portOpen(PORT)) throw new Error(`порт ${PORT} уже занят — задайте CHECK_PORT`);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: configDir,
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    PORT: String(PORT),
    WEB_PORT: String(PORT + 1000),
  };
  for (const name of Object.keys(env)) {
    if (new RegExp(`^(AGENTDECK|${OLD_ENV})_`).test(name)) delete env[name];
  }
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', join(ROOT, 'apps/server/src/index.ts')],
    { cwd: join(ROOT, 'apps/server'), env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`сервер вышел (${child.exitCode}):\n${output}`);
    if (await portOpen(PORT)) return child;
    await new Promise((r) => setTimeout(r, 300));
  }
  child.kill();
  throw new Error(`сервер не поднялся за минуту:\n${output}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((done) => child.once('exit', done));
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else child.kill('SIGTERM');
  await exited;
  while (await portOpen(PORT)) await new Promise((r) => setTimeout(r, 200));
}

async function api(path, init = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body, text };
}

const stub = await startStubPlatform({ port: 0, vendorPrefix: LEGACY });

// === Раскладка «до переименования» ===
mkdirSync(appData, { recursive: true });
mkdirSync(join(home, 'AppData', 'Local'), { recursive: true });
writeFileSync(join(configDir, 'settings.json'), '{}\n');
writeFileSync(
  stateFile,
  `${JSON.stringify(
    {
      settings: {
        platforms: [
          {
            id: CONTOUR,
            title: 'Контур до переименования',
            driver: LEGACY,
            baseUrl: stub.url,
            enabled: true,
            mode: 'best-effort',
            budgetUsd: 0,
            capabilities: [],
            targets: [],
            projectPaths: [],
            caCertPath: '',
          },
        ],
        platformGateway: { enabled: true, port: GATEWAY_PORT, forceStream: true },
      },
    },
    null,
    2,
  )}\n`,
);
const seed = spawnSync(
  process.execPath,
  [
    '--experimental-strip-types',
    '--no-warnings',
    '--input-type=module',
    '-e',
    `const m = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'apps/server/src/lib/provider-keys.ts')).href)});
     m.setStoredKey(process.argv[1], process.argv[2], process.argv[3]);`,
    appData,
    `platform:${CONTOUR}`,
    key,
  ],
  { encoding: 'utf8' },
);
check(seed.status === 0, 'ключ контура заведён в хранилище', seed.stderr.trim());

let child;
try {
  child = await boot();

  // --- Диск ---
  const stored = JSON.parse(readFileSync(stateFile, 'utf8')).settings.platforms[0];
  check(
    stored.driver === 'enterprise-platform' && stored.manifest?.vendorPrefix === LEGACY,
    'state.json переписан: нынешнее имя драйвера, прежнее слово — префиксом полей',
    JSON.stringify({ driver: stored.driver, manifest: stored.manifest }),
  );

  // --- Карточка ---
  const list = await api('/platforms');
  const card = (list.body?.platforms ?? []).find((item) => item.platform?.id === CONTOUR);
  check(
    card?.platform?.driver === 'enterprise-platform' && card?.hasToken === true,
    'карточка: нынешний драйвер, ключ на месте',
    JSON.stringify({ driver: card?.platform?.driver, hasToken: card?.hasToken }),
  );
  const ruleIds = (card?.rules ?? []).map((row) => row.id);
  check(
    ruleIds.includes(`${LEGACY}_tools`) && ruleIds.includes(`${LEGACY}_tool_mode`),
    'правила на проводе названы словом платформы',
    JSON.stringify(ruleIds),
  );

  // --- Шлюз ---
  const activated = await api(`/platforms/${CONTOUR}/activate`, { method: 'POST', body: '{}' });
  check(activated.status === 200, 'контур активирован', activated.text.slice(0, 200));
  const restarted = await api('/platforms/gateway/restart', { method: 'POST', body: '{}' });
  const port = restarted.body?.status?.port ?? GATEWAY_PORT;
  check(
    restarted.body?.status?.routes?.some((route) => route.platformId === CONTOUR && route.ready),
    'шлюз знает маршрут контура',
    JSON.stringify(restarted.body?.status?.routes),
  );

  const chat = (model) =>
    fetch(`http://127.0.0.1:${port}/${CONTOUR}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 32,
        messages: [{ role: 'user', content: 'привет' }],
      }),
    }).then(async (res) => ({ status: res.status, text: await res.text() }));
  const lastEvent = async () =>
    ((await api('/platforms/gateway')).body?.status?.events ?? []).find(
      (event) => event.platformId === CONTOUR,
    );

  const clean = await chat('stub-chat');
  check(
    clean.status === 200 && clean.text.includes('[DONE]') && !clean.text.includes(`${LEGACY}_`),
    'обычный ответ дошёл, вендорный кадр клиенту не уехал',
    `${clean.status}: ${clean.text.slice(0, 300)}`,
  );
  const cleanEvent = await lastEvent();
  check(
    (cleanEvent?.stages ?? []).includes('inference'),
    'стадии контура распознаны по прежнему слову',
    JSON.stringify(cleanEvent?.stages),
  );
  check(
    stub.calls.some((call) => call.authorization === `Bearer ${key}`),
    'ключ из хранилища ушёл наверх',
  );

  const guarded = await chat('stub-guardrails');
  check(
    /"code"\s*:\s*"content_policy_violation"/.test(guarded.text),
    'обрыв проверками стал ошибкой отказа по содержимому',
    guarded.text.slice(-300),
  );
  const guardEvent = await lastEvent();
  check(
    (guardEvent?.violations ?? []).includes('Токсичность') && guardEvent?.interrupted === true,
    'названия проверок в следе запроса',
    JSON.stringify(guardEvent),
  );

  // --- Дверь сохранения: прежнее имя на входе ---
  const saved = await api('/platforms/corp-input', {
    method: 'PUT',
    body: JSON.stringify({
      settings: {
        id: 'corp-input',
        title: 'Прежнее имя на входе',
        driver: LEGACY,
        baseUrl: stub.url,
        enabled: false,
        mode: 'best-effort',
        budgetUsd: 0,
        budgetSince: '',
        capabilities: [],
        targets: [],
        projectPaths: [],
        agents: [],
        caCertPath: '',
      },
    }),
  });
  const input = JSON.parse(readFileSync(stateFile, 'utf8')).settings.platforms.find(
    (platform) => platform.id === 'corp-input',
  );
  check(
    saved.status === 200 && input?.driver === 'enterprise-platform',
    'дверь сохранения приняла прежнее имя и записала нынешнее',
    `${saved.status} ${JSON.stringify(input?.driver)} ${saved.text.slice(0, 200)}`,
  );

  // --- Второй запуск ---
  await stop(child);
  const bytes = readFileSync(stateFile, 'utf8');
  const mtime = statSync(stateFile).mtimeMs;
  child = await boot();
  await api('/platforms');
  check(
    readFileSync(stateFile, 'utf8') === bytes && statSync(stateFile).mtimeMs === mtime,
    'второй запуск state.json не трогает',
  );
  check(!bytes.includes(`"driver": "${LEGACY}"`), 'прежнего имени драйвера в файле не осталось');
} catch (error) {
  check(false, error instanceof Error ? error.message : String(error));
} finally {
  await stop(child);
  await stub.close();
}

console.log(`\nкаталоги проверки: ${base}`);
console.log(failed ? `\n✕ провалено: ${failed}` : '\n✓ переезд драйвера подтверждён');
process.exit(failed ? 1 : 0);
