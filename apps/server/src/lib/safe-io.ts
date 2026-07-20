import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  copyFileSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
} from 'node:fs';
import { dirname, join, basename } from 'node:path';

/**
 * Файловые операции с двумя страховками, потому что мы правим рабочий конфиг
 * живого инструмента: испорченный settings.json ломает Claude Code целиком.
 *
 *   1. Резервная копия перед каждой записью — в claude-control/backups/.
 *   2. Атомарная запись: пишем во временный файл и переименовываем.
 *      Прерванная запись не оставит обрезанный конфиг.
 *
 * Тем же механизмом страхуются удаления (скилл, файл скилла): там копия —
 * единственный способ отменить операцию, потому что стирается целая папка.
 */

export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) return fallback;
  return JSON.parse(raw) as T;
}

export function readTextFile(path: string, fallback = ''): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : fallback;
}

export interface WriteOptions {
  /** Куда складывать резервные копии. Пусто — не делать копий. */
  backupDir?: string;
}

/**
 * Счётчик в имени временного файла. Только pid мало: два обращения к одному
 * пути (или разлапистый бэкап поверх записи) в рамках одного процесса взяли бы
 * одинаковое имя `.tmp-<pid>` и затёрли бы промежуточный файл друг друга.
 * Монотонный счётчик даёт каждой записи собственное имя.
 */
let tmpCounter = 0;

export function writeTextFile(
  path: string,
  content: string,
  options: WriteOptions = {},
): string | undefined {
  const backupPath = options.backupDir ? makeBackup(path, options.backupDir) : undefined;
  mkdirSync(dirname(path), { recursive: true });

  // Временный файл лежит рядом с целевым: переименование в пределах одного тома атомарно.
  const tmp = `${path}.tmp-${process.pid}-${(tmpCounter += 1)}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);

  return backupPath;
}

export function writeJsonFile(
  path: string,
  data: unknown,
  options: WriteOptions = {},
): string | undefined {
  return writeTextFile(path, `${JSON.stringify(data, null, 2)}\n`, options);
}

/**
 * Копия с отметкой времени — файла или папки целиком. Timestamp без двоеточий:
 * иначе имя невалидно в Windows. `name` задаётся, когда одного basename мало,
 * чтобы различить копии (скилл лежит и в skills/, и в skills-disabled/).
 */
export function backupEntry(path: string, backupDir: string, name?: string): string | undefined {
  if (!existsSync(path)) return undefined;
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = name ?? basename(path);
  const target = join(backupDir, `${base}.${stamp}.bak`);

  copyRecursive(path, target);
  rotateBackups(backupDir, base);
  return target;
}

/**
 * Сколько копий одного файла хранить. Панель пишет конфиг при каждой правке —
 * без ограничения каталог копий растёт бесконечно, а внутри лежат в том числе
 * копии `.mcp-secrets.env` открытым текстом. Десяти хватает, чтобы отмотать
 * назад несколько шагов; всё, что старше, только занимает место.
 *
 * Настраивается: кому-то нужно больше истории, кому-то — меньше копий секретов
 * на диске. Значение задаётся из настроек через `setBackupKeep` при старте и
 * при их изменении; по умолчанию — десять.
 */
let keepBackups = 10;

/**
 * Верхний предел глубины ротации — тот же, что в контракте `appSettingsSchema`
 * (backupKeep: 1..100). Держим его и на сервере: без клампа PATCH со значением
 * вроде 100000 заставил бы панель хранить сто тысяч копий (в т.ч. `.mcp-secrets.env`
 * открытым текстом) на диске.
 */
export const MAX_BACKUP_KEEP = 100;

/** Привести глубину ротации к контрактному диапазону [1..100] (floor). */
export function clampBackupKeep(count: number): number {
  return Math.min(MAX_BACKUP_KEEP, Math.max(1, Math.floor(count)));
}

/** Сколько копий одного файла держать (из настроек панели). Диапазон 1..100. */
export function setBackupKeep(count: number): void {
  if (Number.isFinite(count) && count >= 1) keepBackups = clampBackupKeep(count);
}

function rotateBackups(backupDir: string, base: string): void {
  const prefix = `${base}.`;
  const own = readdirSync(backupDir)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.bak'))
    // Отметка времени в имени — ISO, поэтому лексикографический порядок
    // совпадает с хронологическим, и читать stat каждого файла незачем.
    .sort();

  for (const stale of own.slice(0, Math.max(0, own.length - keepBackups))) {
    removeEntry(join(backupDir, stale));
  }
}

/**
 * Рекурсивные обход своими руками, а не `fs.cpSync` и `fs.rmSync`.
 *
 * Замерено на Node 24 под Windows: рекурсивные операции ломаются, если в пути
 * есть нелатинские символы. `cpSync` убивает процесс молча — без исключения,
 * без сообщения, с нулевым кодом выхода. `rmSync` с `force: true` рапортует
 * об успехе, а папка остаётся на диске: панель сказала бы «удалено», ничего
 * не удалив. Поймано на скилле с русским именем папки.
 *
 * Поштучные операции — `copyFileSync`, `unlinkSync`, `rmdirSync`, `readdirSync` —
 * те же пути обрабатывают правильно, поэтому обход пишем сами. Названия у
 * скиллов и их файлов приходят от пользователя, так что кириллица здесь
 * ожидаема, а не экзотика.
 */
export function copyRecursive(source: string, target: string): void {
  if (!statSync(source).isDirectory()) {
    copyFileSync(source, target);
    return;
  }

  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    copyRecursive(join(source, entry.name), join(target, entry.name));
  }
}

/** Удаление файла или папки целиком. Отсутствующий путь — не ошибка. */
export function removeEntry(target: string): void {
  if (!existsSync(target)) return;

  if (!statSync(target).isDirectory()) {
    unlinkSync(target);
    return;
  }

  for (const entry of readdirSync(target)) removeEntry(join(target, entry));
  rmdirSync(target);
}

function makeBackup(path: string, backupDir: string): string | undefined {
  return backupEntry(path, backupDir);
}

/** Проверка, что строка — валидный JSON. Используется до записи, чтобы не портить конфиг. */
export function assertValidJson(raw: string): void {
  try {
    JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Невалидный JSON: ${detail}`, { cause: error });
  }
}
