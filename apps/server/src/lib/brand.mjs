/**
 * Имя продукта и переезд со старого имени — ОДНА копия на сервер, скрипты
 * `tools/` (переходники MCP, keepalive, doctor) и прокси Vite.
 *
 * До 17.09.2026 продукт назывался иначе (`LEGACY_BRAND_NAME`, `LEGACY_BRAND_SLUG`).
 * Имя успело оказаться на диске у человека: каталог данных `<конфиг>/<прежнее имя>`,
 * домашний `~/.<прежнее имя>` (токен API, ручной доступ, чаты, песочницы),
 * `%LOCALAPPDATA%\<прежнее имя>` (журнал keepalive), переменные с прежним
 * префиксом. Всё это продолжает работать: переменные читаются запасным
 * именем, каталоги один раз КОПИРУЮТСЯ под новое имя.
 *
 * Прежнее имя собирается из частей и буквально в дереве не встречается: история
 * репозитория переписывается заменой слова, и литерал здесь превратился бы в
 * новое имя — переезд молча перестал бы что-либо находить.
 *
 * Обычный `.mjs` без зависимостей намеренно: скрипты `tools/` исполняет голый
 * Node без `--experimental-strip-types`, а второй копии правил переезда быть не
 * должно — две копии разъезжаются первой же правкой.
 */

import {
  chmodSync,
  copyFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';

export const BRAND_NAME = 'AgentDeck';
export const BRAND_SLUG = 'agentdeck';
/** Прежнее имя: только чтобы найти старые данные и переменные, никогда для записи. */
const LEGACY_PARTS = ['claude', 'control'];
const capital = (word) => word.charAt(0).toUpperCase() + word.slice(1);
export const LEGACY_BRAND_NAME = LEGACY_PARTS.map(capital).join(' ');
export const LEGACY_BRAND_SLUG = LEGACY_PARTS.join('-');
/** Слитно с заглавными — так назывались задачи планировщика Windows. */
export const LEGACY_BRAND_PASCAL = LEGACY_PARTS.map(capital).join('');

const ENV_PREFIX = 'AGENTDECK_';
const LEGACY_ENV_PREFIX = `${LEGACY_PARTS.join('_').toUpperCase()}_`;

/** Файл-пометка в СТАРОМ каталоге: человек, открыв его, видит, куда уехали данные. */
export const MIGRATION_MARKER = 'MIGRATED-TO-agentdeck.txt';

/** Полупереехавшая копия старше этого — брошенная (процесс убили посреди копирования). */
const STALE_TEMP_MS = 10 * 60_000;

/** Имя переменной под новым брендом: `URL` → `AGENTDECK_URL`. */
export function brandEnvName(name) {
  return ENV_PREFIX + name;
}

/** Имя той же переменной под прежним брендом: `URL` → `<ПРЕЖНИЙ_ПРЕФИКС>_URL`. */
export function legacyEnvName(name) {
  return LEGACY_ENV_PREFIX + name;
}

/**
 * Значение переменной панели: сначала `AGENTDECK_<name>`, затем прежнее
 * `<ПРЕЖНИЙ_ПРЕФИКС>_<name>`. Пустая строка — как отсутствие: так её понимали и
 * все прежние места чтения (`||`, `?.trim()`).
 */
export function brandEnv(name, env = process.env) {
  const fresh = env[brandEnvName(name)];
  if (typeof fresh === 'string' && fresh.trim() !== '') return fresh;
  const legacy = env[legacyEnvName(name)];
  if (typeof legacy === 'string' && legacy.trim() !== '') return legacy;
  return undefined;
}

/** Каталог данных панели внутри каталога конфигурации CLI. */
export function appDataDirOf(configRoot) {
  return join(configRoot, BRAND_SLUG);
}

export function legacyAppDataDirOf(configRoot) {
  return join(configRoot, LEGACY_BRAND_SLUG);
}

/**
 * Каталог данных панели с переездом: вызывается там, где каталог начинают
 * использовать (создание хранилища). Возвращает каталог, с которым работать, —
 * прежний, если копия не удалась: пустой новый каталог выглядел бы для человека
 * как потеря всех настроек.
 */
export function resolveAppDataDir(configRoot, log) {
  return resolveBrandDir(legacyAppDataDirOf(configRoot), appDataDirOf(configRoot), log);
}

/** `~/.agentdeck` — токен API, ручной доступ, чаты, песочницы, медиа. */
export function panelHomeDirPath(home = homedir()) {
  return join(home, `.${BRAND_SLUG}`);
}

export function legacyPanelHomeDirPath(home = homedir()) {
  return join(home, `.${LEGACY_BRAND_SLUG}`);
}

/** Домашний каталог панели с переездом (см. `resolveAppDataDir`). */
export function panelHomeDir(log) {
  return resolveBrandDir(legacyPanelHomeDirPath(), panelHomeDirPath(), log);
}

/**
 * Файл в домашнем каталоге панели — БЕЗ переезда, только чтение: для процессов,
 * которые не владеют данными (переходники MCP, прокси Vite). Новый путь, если
 * файл там есть, иначе прежний, если есть он; иначе новый — чтобы сообщение об
 * ошибке называло актуальное место.
 */
export function panelHomeFile(name, home = homedir()) {
  const fresh = join(panelHomeDirPath(home), name);
  if (existsSync(fresh)) return fresh;
  const legacy = join(legacyPanelHomeDirPath(home), name);
  return existsSync(legacy) ? legacy : fresh;
}

/** Результаты уже решённых переездов этого процесса: ключ — пара путей. */
const settled = new Map();

/**
 * Решить, каким каталогом пользоваться, скопировав прежний под новое имя.
 *
 * Правила (решение владельца 17.09.2026):
 *  - новый каталог есть и не пуст — берём его, прежний не трогаем и НЕ сливаем;
 *  - нового нет (или он пуст), прежний есть — копия целиком во временный
 *    соседний каталог, затем одно переименование: оборванная копия никогда не
 *    выглядит готовым каталогом;
 *  - прежний каталог только читается, в нём появляется лишь файл-пометка;
 *  - копия не удалась — работаем с прежним каталогом, в журнал одна строка.
 *
 * Идемпотентно: второй вызов в процессе отвечает из памяти, второй запуск
 * видит непустой новый каталог.
 */
export function resolveBrandDir(legacyDir, freshDir, log = defaultLog) {
  const key = `${resolve(legacyDir)}\u0000${resolve(freshDir)}`;
  const known = settled.get(key);
  if (known) return known;
  const outcome = migrateDir(legacyDir, freshDir, log);
  const dir = outcome === 'failed' ? legacyDir : freshDir;
  settled.set(key, dir);
  return dir;
}

/**
 * Сам переезд. Ответ: `migrated` — скопировано сейчас; `kept` — новый уже есть;
 * `none` — старого нет, переносить нечего; `failed` — копия не удалась.
 */
export function migrateDir(legacyDir, freshDir, log = defaultLog) {
  if (samePath(legacyDir, freshDir)) return 'none';
  if (hasContent(freshDir)) return 'kept';
  if (!isDirectory(legacyDir)) return 'none';

  const parent = dirname(freshDir);
  const tempDir = join(parent, `${basename(freshDir)}.migrating-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(parent, { recursive: true });
    sweepStaleTemps(parent, basename(freshDir));
    copyTree(legacyDir, tempDir);
    // Пустой новый каталог мог создать кто-то до нас (например, журнал):
    // переименованию он мешает, а данных в нём нет по определению.
    if (existsSync(freshDir)) rmdirSync(freshDir);
    renameSync(tempDir, freshDir);
  } catch (error) {
    removeTree(tempDir);
    // Параллельный процесс успел первым — его копия и есть результат.
    if (hasContent(freshDir)) return 'kept';
    log(
      `[${BRAND_SLUG}] не удалось перенести ${legacyDir} → ${freshDir}: ${describe(error)}. ` +
        'Работаю с прежним каталогом, перенос повторится при следующем запуске.',
    );
    return 'failed';
  }

  try {
    writeFileSync(
      join(legacyDir, MIGRATION_MARKER),
      `${LEGACY_BRAND_NAME} переименован в ${BRAND_NAME}.\n` +
        `Данные скопированы в ${freshDir} (${new Date().toISOString()}).\n` +
        'Этот каталог больше не используется и оставлен как резервная копия — его можно удалить.\n',
      'utf8',
    );
  } catch {
    // Пометка — удобство, не условие: каталог мог быть только для чтения.
  }
  log(
    `[${BRAND_SLUG}] данные перенесены: ${legacyDir} → ${freshDir} (прежний каталог оставлен резервной копией)`,
  );
  return 'migrated';
}

function defaultLog(line) {
  process.stderr.write(`${line}\n`);
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

function samePath(a, b) {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasContent(path) {
  try {
    return statSync(path).isDirectory() && readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

/**
 * Копия по одному элементу. Рекурсивные `cpSync`/`rmSync` на Windows ломаются на
 * путях не латиницей (`.claude/gotchas.md` §Windows filesystem), а имена копий и
 * скиллов в `backups/` приходят от человека. Права файла переносятся явно:
 * `provider-keys.key`, `credentials.json`, `api-token` лежат с 0600.
 * Символические ссылки не переносятся — данные панели ими не пользуются, а
 * создание ссылки на Windows требует прав.
 */
function copyTree(from, to) {
  const stat = lstatSync(from);
  mkdirSync(to, { recursive: true });
  applyMode(to, stat.mode);
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else if (entry.isFile()) {
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      applyMode(target, lstatSync(source).mode);
    }
  }
}

function applyMode(path, mode) {
  if (process.platform === 'win32') return;
  chmodSync(path, mode & 0o777);
}

function removeTree(path) {
  try {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) removeTree(child);
      else unlinkSync(child);
    }
    rmdirSync(path);
  } catch {
    // Остаток уберёт следующий запуск (`sweepStaleTemps`).
  }
}

function sweepStaleTemps(parent, name) {
  const prefix = `${name}.migrating-`;
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const path = join(parent, entry.name);
    try {
      // Свежая копия может принадлежать параллельному процессу — её не трогаем.
      if (Date.now() - statSync(path).mtimeMs > STALE_TEMP_MS) removeTree(path);
    } catch {
      // Исчезла сама — тем лучше.
    }
  }
}
