/**
 * Переезд данных со старого имени продукта (прежнее → agentdeck) через
 * НАСТОЯЩИЙ запуск сервера.
 *
 *   node tools/qa/check-brand-migration.mjs
 *
 * Стенд не нужен и не трогается: проверка раскладывает во временном каталоге
 * домашний каталог «как у человека до переименования» — `~/.<прежнее>/api-token`,
 * `<конфиг>/<прежнее>/state.json` с включённым гейтом по токену и
 * зашифрованный токен интеграции в `provider-keys.enc` (+ ключевой файл), — и
 * поднимает сервер с подменёнными HOME/USERPROFILE/CLAUDE_CONFIG_DIR/LOCALAPPDATA.
 *
 * Доказательства — только то, что видно снаружи процесса:
 *  - новый каталог появился, старый не изменился ни байтом (кроме пометки);
 *  - прежний токен пускает в API, без токена — 401;
 *  - сохранённый токен интеграции расшифровывается: API отдаёт его маску;
 *  - второй запуск ничего не копирует заново и не затирает новый каталог.
 *
 * Каталоги проверки остаются в `.agent/tmp/brand-migration/` — это улика, а не мусор.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../..');
const PORT = Number(process.env.CHECK_PORT ?? 5263);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const base = join(ROOT, '.agent', 'tmp', 'brand-migration', stamp);
const home = join(base, 'home');
const configDir = join(home, '.claude');
const localAppData = join(home, 'AppData', 'Local');

/**
 * Прежнее имя записано задом наперёд — иначе, чем в `brand.mjs`: литерала в дереве
 * нет (историю переписывают заменой слова), а проверка должна поймать ошибку в
 * сборке имени, а не повторить её.
 */
const OLD_SLUG = [...'lortnoc-edualc'].reverse().join('');
const OLD_ENV = OLD_SLUG.replace('-', '_').toUpperCase();
const OLD_HOME = join(home, `.${OLD_SLUG}`);
const NEW_HOME = join(home, '.agentdeck');
const OLD_APPDATA = join(configDir, OLD_SLUG);
const NEW_APPDATA = join(configDir, 'agentdeck');
const MARKER = 'MIGRATED-TO-agentdeck.txt';
// Значения одноразовые, созданные здесь же: настоящих секретов проверка не видит.
const accessValue = randomBytes(24).toString('hex');
const TAIL = '9f3a';
const storedValue = `tok-${randomBytes(12).toString('hex')}${TAIL}`;

let failed = 0;
function check(ok, label) {
  console.log(`${ok ? '✓' : '✕'} ${label}`);
  if (!ok) failed += 1;
}

/** Снимок каталога: путь → sha1 содержимого. */
function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(dir, path)] = createHash('sha1').update(readFileSync(path)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

const withoutMarker = (snap) =>
  JSON.stringify(Object.fromEntries(Object.entries(snap).filter(([k]) => k !== MARKER)));

// === Раскладка «до переименования» ===
mkdirSync(OLD_HOME, { recursive: true });
mkdirSync(OLD_APPDATA, { recursive: true });
mkdirSync(localAppData, { recursive: true });
writeFileSync(join(configDir, 'settings.json'), '{}\n');
writeFileSync(join(OLD_HOME, 'api-token'), `${accessValue}\n`);
writeFileSync(
  join(OLD_APPDATA, 'state.json'),
  JSON.stringify({
    settings: { remoteAccess: { enabled: true, publicUrl: '', notify: false } },
  }),
);
// Шифрованное хранилище пишет сам модуль сервера — в ПРЕЖНИЙ каталог напрямую.
const seed = spawnSync(
  process.execPath,
  [
    '--experimental-strip-types',
    '--input-type=module',
    '-e',
    `const m = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'apps/server/src/lib/provider-keys.ts')).href)});
     m.setStoredKey(process.argv[1], 'int:atlassian', process.argv[2]);`,
    OLD_APPDATA,
    storedValue,
  ],
  { encoding: 'utf8' },
);
check(seed.status === 0, `хранилище ключей заведено в прежнем каталоге ${seed.stderr.trim()}`);
check(
  existsSync(join(OLD_APPDATA, 'provider-keys.enc')) &&
    existsSync(join(OLD_APPDATA, 'provider-keys.key')),
  'provider-keys.enc + provider-keys.key лежат под прежним именем',
);
check(!existsSync(NEW_HOME) && !existsSync(NEW_APPDATA), 'новых каталогов до запуска нет');
const oldHomeBefore = withoutMarker(snapshot(OLD_HOME));
const oldAppBefore = withoutMarker(snapshot(OLD_APPDATA));

// === Запуск ===
function portOpen() {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port: PORT });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

async function boot() {
  if (await portOpen()) throw new Error(`порт ${PORT} уже занят — задайте CHECK_PORT`);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: configDir,
    LOCALAPPDATA: localAppData,
    APPDATA: join(home, 'AppData', 'Roaming'),
    PORT: String(PORT),
    WEB_PORT: String(PORT + 1000),
  };
  for (const key of Object.keys(env)) {
    if (new RegExp(`^(AGENTDECK|${OLD_ENV})_`).test(key)) delete env[key];
  }
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', join(ROOT, 'apps/server/src/index.ts')],
    { cwd: join(ROOT, 'apps/server'), env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`сервер вышел (${child.exitCode}):\n${output}`);
    if (await portOpen()) return { child, output: () => output };
    await new Promise((r) => setTimeout(r, 300));
  }
  child.kill();
  throw new Error(`сервер не поднялся за минуту:\n${output}`);
}

async function stop(run) {
  if (run.child.exitCode !== null) return;
  const exited = new Promise((done) => run.child.once('exit', done));
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(run.child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else run.child.kill('SIGTERM');
  await exited;
  while (await portOpen()) await new Promise((r) => setTimeout(r, 200));
}

const api = (path, bearer) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });

let run;
try {
  run = await boot();

  check(existsSync(join(NEW_HOME, 'api-token')), '~/.agentdeck/api-token появился');
  check(
    existsSync(join(NEW_APPDATA, 'state.json')) &&
      existsSync(join(NEW_APPDATA, 'provider-keys.enc')) &&
      existsSync(join(NEW_APPDATA, 'provider-keys.key')),
    '<конфиг>/agentdeck: state.json + ключ и хранилище вместе',
  );
  check(
    existsSync(join(OLD_HOME, MARKER)) && existsSync(join(OLD_APPDATA, MARKER)),
    'в прежних каталогах лежит пометка о переезде',
  );
  check(
    withoutMarker(snapshot(OLD_HOME)) === oldHomeBefore &&
      withoutMarker(snapshot(OLD_APPDATA)) === oldAppBefore,
    'прежние каталоги не изменились (кроме пометки)',
  );
  check(
    (run.output().match(/данные перенесены/g) ?? []).length === 2,
    'в журнале по строке на каждый перенесённый каталог',
  );

  const anonymous = await api('/api/location');
  check(
    anonymous.status === 401,
    `без токена — 401 (гейт из перенесённого state.json): ${anonymous.status}`,
  );
  const location = await api('/api/location', accessValue);
  const body = location.ok ? await location.json() : {};
  check(location.status === 200, `прежний токен пускает: ${location.status}`);
  check(
    resolve(body.paths?.appData ?? '') === resolve(NEW_APPDATA),
    `панель работает с новым каталогом данных: ${body.paths?.appData}`,
  );
  const integrations = await api('/api/integrations', accessValue);
  const text = await integrations.text();
  check(
    integrations.status === 200 && text.includes(TAIL) && !text.includes(storedValue),
    'сохранённый токен интеграции расшифрован (маска отдаётся, значение — нет)',
  );

  // === Второй запуск: ничего не копируется заново, новый каталог не затирается ===
  await stop(run);
  writeFileSync(join(NEW_APPDATA, 'written-after-migration.txt'), 'новое');
  writeFileSync(join(OLD_APPDATA, 'written-to-old-later.txt'), 'старое');
  const markerTime = statSync(join(OLD_APPDATA, MARKER)).mtimeMs;
  run = await boot();
  check(!/данные перенесены/.test(run.output()), 'второй запуск ничего не переносит');
  check(existsSync(join(NEW_APPDATA, 'written-after-migration.txt')), 'новый каталог не затёрт');
  check(!existsSync(join(NEW_APPDATA, 'written-to-old-later.txt')), 'каталоги не сливаются');
  check(statSync(join(OLD_APPDATA, MARKER)).mtimeMs === markerTime, 'пометка не переписана');
  check(
    (await api('/api/location', accessValue)).status === 200,
    'токен работает и после второго запуска',
  );
} catch (error) {
  check(false, error instanceof Error ? error.message : String(error));
} finally {
  if (run) await stop(run);
}

console.log(`\nкаталоги проверки: ${base}`);
console.log(failed ? `\n✕ провалено: ${failed}` : '\n✓ переезд данных подтверждён');
process.exit(failed ? 1 : 0);
