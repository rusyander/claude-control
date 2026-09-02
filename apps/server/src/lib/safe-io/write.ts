import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { applyTextForm } from '../text-form.ts';
import { backupEntry } from './backups.ts';
import { applyFileMode, fileMode, resolveWriteTarget } from './path-guards.ts';
import { readTextForm } from './read.ts';
import type { WriteOptions } from './safe-io.types.ts';

/**
 * Счётчик в имени временного файла. Только pid мало: два обращения к одному
 * пути (или разлапистый бэкап поверх записи) в рамках одного процесса взяли бы
 * одинаковое имя `.tmp-<pid>` и затёрли бы промежуточный файл друг друга.
 * Монотонный счётчик даёт каждой записи собственное имя.
 */
let tmpCounter = 0;

/**
 * Общее ядро записи: пишем во временный файл рядом с целевым и переименовываем
 * (в пределах одного тома это атомарно) — прерванная запись не оставит обрезанный
 * конфиг. Пишем в цель ссылки, а не поверх самой ссылки (см. resolveWriteTarget),
 * и возвращаем целевому файлу его режим (см. applyFileMode).
 */
function writeAtomic(path: string, payload: string | Buffer): void {
  const mode = fileMode(path);
  const target = resolveWriteTarget(path);
  mkdirSync(dirname(target), { recursive: true });

  const tmp = `${target}.tmp-${process.pid}-${(tmpCounter += 1)}`;
  try {
    writeFileSync(tmp, payload);
    renameWithRetry(tmp, target);
  } catch (error) {
    // Не вышло — временный файл не должен остаться лежать рядом с конфигом:
    // на стенде такие `state.json.tmp-*` копились после отказов переименования.
    rmSync(tmp, { force: true });
    throw error;
  }
  applyFileMode(target, mode, path);
}

/** Коды, с которыми Windows отдаёт «файл занят»: антивирус или индексатор держит цель долю секунды. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Переименование с несколькими попытками. Атомарной записи это не отменяет —
 * цель либо прежняя, либо новая, — но однократная попытка на Windows
 * проигрывала сканеру файлов и роняла запрос 500 на здоровом конфиге.
 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 4 || !TRANSIENT_RENAME_CODES.has(code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
}

/** Копия перед разрушающей записью — если запрошена каталогом копий. */
function makeBackup(path: string, options: WriteOptions): string | undefined {
  return options.backupDir ? backupEntry(path, options.backupDir, options.backupName) : undefined;
}

export function writeTextFile(
  path: string,
  content: string,
  options: WriteOptions = {},
): string | undefined {
  const backupPath = makeBackup(path, options);

  // Форму берём ДО записи: был BOM — вернём BOM, был CRLF — приведём к CRLF.
  // Иначе сгенерированный нами LF-текст оставил бы в чужом файле смешанные
  // окончания строк. У нового файла формы нет — пишем содержимое как есть.
  const form = options.preserveForm === false ? undefined : readTextForm(path);
  writeAtomic(path, form ? applyTextForm(content, form) : content);

  return backupPath;
}

export function writeJsonFile(
  path: string,
  data: unknown,
  options: WriteOptions = {},
): string | undefined {
  // Хвостовой перевод строки — тоже форма чужого файла: ~/.claude.json Claude Code
  // пишет без него. Только для JSON, который мы переписываем целиком из структуры:
  // у текста, набранного человеком в редакторе, хвост — его решение, не наше.
  const form = options.preserveForm === false ? undefined : readTextForm(path);
  const tail = form?.trailingNewline === false ? '' : '\n';
  return writeTextFile(path, `${JSON.stringify(data, null, 2)}${tail}`, options);
}

/**
 * Двоичная запись — тем же атомарным приёмом, но без разговоров о форме текста:
 * у картинки в папке скилла нет ни BOM, ни переводов строк, а перегон через
 * utf8 её бы испортил. Нужна там, где содержимое приходит буфером (архив
 * переноса окружения).
 */
export function writeBinaryFile(
  path: string,
  data: Buffer,
  options: WriteOptions = {},
): string | undefined {
  const backupPath = makeBackup(path, options);
  writeAtomic(path, data);
  return backupPath;
}
