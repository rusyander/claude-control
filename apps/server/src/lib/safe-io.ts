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
import { encryptSecret } from './secret-crypto.ts';
import { applyTextForm, detectTextForm, stripBom, type TextForm } from './text-form.ts';

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
  // BOM снимаем: с ним `JSON.parse` падает на совершенно валидном файле
  // (Блокнот/PowerShell пишут settings.json именно так) — это уводило бы раздел
  // в fail-closed на здоровом конфиге. Сам BOM при записи вернётся (см. writeTextFile).
  return JSON.parse(stripBom(raw)) as T;
}

export function readTextFile(path: string, fallback = ''): string {
  // Тоже без BOM: иначе он утекал бы в редактор инструкций как невидимый символ
  // в начале текста и «прилипал» бы вторым при каждом сохранении.
  return existsSync(path) ? stripBom(readFileSync(path, 'utf8')) : fallback;
}

/**
 * Форма существующего файла (BOM + переводы строк) — или `undefined`, если файла
 * нет либо он неправдоподобно велик (форму не гадаем и не читаем гигабайты).
 */
export function readTextForm(path: string): TextForm | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > MAX_FORM_PROBE_BYTES) return undefined;
    return detectTextForm(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Выше этого размера форму файла не определяем — запись идёт как есть. */
const MAX_FORM_PROBE_BYTES = 4 * 1024 * 1024;

export interface WriteOptions {
  /** Куда складывать резервные копии. Пусто — не делать копий. */
  backupDir?: string;
  /**
   * Под каким ИМЕНЕМ сохранять копию (по умолчанию — basename пути).
   *
   * Нужно, потому что каталог копий один на всю панель, а разные провайдеры имеют
   * файлы с ОДИНАКОВЫМИ basename: `~/.claude/settings.json` и
   * `~/.gemini/settings.json`, `~/.codex/AGENTS.md` и `~/.config/opencode/AGENTS.md`.
   * Без разделения копии смешивались бы в одной ротации, а откат по basename вернул
   * бы чужой файл поверх claude-конфига. Провайдер-разделы передают сюда
   * `<id>-<basename>`.
   */
  backupName?: string;
  /**
   * Сохранять форму СУЩЕСТВУЮЩЕГО файла (BOM + стиль переводов строк). По
   * умолчанию да: панель правит чужие рабочие файлы и не должна менять их вид.
   * Явное `false` — для хирургических правок, где итог уже собран из исходного
   * текста байт-в-байт (нормализация всего файла там как раз навредила бы).
   */
  preserveForm?: boolean;
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
  const backupPath = options.backupDir
    ? makeBackup(path, options.backupDir, options.backupName)
    : undefined;

  // Форму берём ДО записи: был BOM — вернём BOM, был CRLF — приведём к CRLF.
  // Иначе сгенерированный нами LF-текст оставил бы в чужом файле смешанные
  // окончания строк. У нового файла формы нет — пишем содержимое как есть.
  const form = options.preserveForm === false ? undefined : readTextForm(path);
  const payload = form ? applyTextForm(content, form) : content;

  mkdirSync(dirname(path), { recursive: true });

  // Временный файл лежит рядом с целевым: переименование в пределах одного тома атомарно.
  const tmp = `${path}.tmp-${process.pid}-${(tmpCounter += 1)}`;
  writeFileSync(tmp, payload, 'utf8');
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
 * Опциональное шифрование копий файла секретов `.mcp-secrets.env`.
 *
 * Копия этого файла по умолчанию лежит открытым текстом рядом с токенами.
 * Когда пользователь включает шифрование и вводит парольную фразу (держим её
 * только в памяти процесса, не в state.json), копии секретов пишутся
 * зашифрованными. Настройка и фраза приходят извне через сеттеры — так же,
 * как глубина ротации (`setBackupKeep`), чтобы safe-io не тянул contracts и
 * настройки в себя.
 */
let encryptSecretBackups = false;
let secretsBasename = '.mcp-secrets.env';
/** Парольная фраза — ТОЛЬКО в памяти, никогда на диск. Пусто — не задана. */
let secretPassphrase: string | undefined;

/** Включить/выключить шифрование копий файла секретов (из настроек панели). */
export function setEncryptSecretBackups(enabled: boolean): void {
  encryptSecretBackups = enabled;
}

/** Basename файла секретов — по нему backupEntry узнаёт, что копию надо шифровать. */
export function setSecretsBasename(name: string): void {
  if (name) secretsBasename = name;
}

/** Задать/сбросить парольную фразу шифрования копий секретов (память процесса). */
export function setSecretPassphrase(passphrase: string | undefined): void {
  secretPassphrase = passphrase;
}

/** Загружена ли парольная фраза в память сейчас (для подсказок в интерфейсе). */
export function hasSecretPassphrase(): boolean {
  return secretPassphrase !== undefined;
}

/** Эта копия — файла секретов? По basename исходного пути. */
function isSecretsPath(path: string): boolean {
  return basename(path) === secretsBasename;
}

/**
 * Копия с отметкой времени — файла или папки целиком. Timestamp без двоеточий:
 * иначе имя невалидно в Windows. `name` задаётся, когда одного basename мало,
 * чтобы различить копии (скилл лежит и в skills/, и в skills-disabled/).
 *
 * Копия файла секретов при включённом шифровании пишется зашифрованной. Если
 * шифрование включено, а парольной фразы в памяти нет (например, после
 * перезапуска сервера до повторного ввода) — копию НЕ делаем вовсе: писать
 * секреты открытым текстом в этом режиме нельзя, а молча подменить шифр
 * плейнтекстом — обман. Возвращаем undefined, как и при отсутствии исходника.
 */
export function backupEntry(path: string, backupDir: string, name?: string): string | undefined {
  if (!existsSync(path)) return undefined;
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = name ?? basename(path);
  const target = join(backupDir, `${base}.${stamp}.bak`);

  if (isSecretsPath(path) && encryptSecretBackups) {
    if (secretPassphrase === undefined) return undefined;
    const blob = encryptSecret(readFileSync(path, 'utf8'), secretPassphrase);
    writeFileSync(target, blob);
  } else {
    copyRecursive(path, target);
  }

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

function makeBackup(path: string, backupDir: string, name?: string): string | undefined {
  return backupEntry(path, backupDir, name);
}

/**
 * Имя резервной копии файла ПРОВАЙДЕРА — с префиксом его id.
 *
 * Каталог копий один на всю панель, а basename у файлов разных провайдеров
 * совпадает: `~/.gemini/settings.json` и `~/.claude/settings.json`,
 * `~/.codex/AGENTS.md` и `~/.config/opencode/AGENTS.md`. Без префикса их копии
 * попадали бы в ОДНУ ротацию (десять копий на всех), лента истории показывала бы
 * дифф чужого файла против claude-конфига, а откат (он ищет цель по basename)
 * вернул бы настройки Gemini поверх `~/.claude/settings.json`. Префикс делает
 * копии провайдеров различимыми и невосстановимыми по чужому пути (fail-closed).
 */
export function providerBackupName(providerId: string, filePath: string): string {
  return `${providerId}-${basename(filePath)}`;
}

/**
 * Имя резервной копии ПРОЕКТНОГО файла провайдера — `<id>-project-<basename>`.
 *
 * Отдельно от `providerBackupName`, потому что basename проектного файла
 * совпадает с глобальным (`<проект>/.codex/config.toml` ↔ `~/.codex/config.toml`,
 * `<проект>/AGENTS.md` ↔ `~/.codex/AGENTS.md`). Без своего префикса копии
 * проектных и глобальных файлов делили бы одну ротацию (правки проекта вытесняли
 * бы историю глобального конфига), а лента изменений показывала бы дифф проекта
 * как правку глобального файла. Восстановление у них так же запрещено.
 */
export function providerProjectBackupName(providerId: string, filePath: string): string {
  return `${providerId}-project-${basename(filePath)}`;
}

/** Проверка, что строка — валидный JSON. Используется до записи, чтобы не портить конфиг. */
export function assertValidJson(raw: string): void {
  try {
    JSON.parse(stripBom(raw));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Невалидный JSON: ${detail}`, { cause: error });
  }
}
