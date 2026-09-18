import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeJsonFile } from '../../lib/safe-io.ts';
import { ProjectFileError, resolveProjectPath } from '../project-files/paths.ts';
import { coded } from '../../lib/server-text.ts';
import type { CodedMessage } from '@agentdeck/contracts';

/**
 * Общая работа с файлами тестового хозяйства проекта.
 *
 * Всё, что лежит в `.agent/tests/`, читается по одним правилам: путь считается
 * с той же защитой от обхода, что у файлов проекта; файл может быть недописан,
 * сломан или чужого размера — это НЕ повод падать, а повод вернуть причину и
 * не трогать чужую работу. Запись всегда атомарная: агент может читать файл
 * ровно в тот момент, когда панель его сохраняет.
 */

/** Папка с кейсами внутри проекта. Клиентская форма пути — всегда через `/`. */
export const TESTS_DIR = '.agent/tests';

/** Потолок на файл: кейсы — текст, мегабайты здесь означают порчу. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export class ProjectTestsError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ProjectTestsError';
  }
}

/** Такого нет — 404, а не молчаливое «ок» на удаление несуществующего. */
export class ProjectTestsNotFoundError extends ProjectTestsError {
  override statusCode = 404;
  constructor(message: string) {
    super(message);
    this.name = 'ProjectTestsNotFoundError';
  }
}

/**
 * Файл занят чужой работой: по этой группе прямо сейчас идёт прогон.
 *
 * 409, а не «сохранили и разъехались»: агент пишет в тот же файл десятки раз в
 * минуту, и правка из панели поверх его записи потеряется молча — человек
 * увидит своё изменение в форме и не увидит его на диске.
 */
export class ProjectTestsLockedError extends ProjectTestsError {
  override statusCode = 409;
  /** Прогон, который держит группу, — по нему его и открывают в панели. */
  readonly runId: string;

  constructor(message: string, runId: string) {
    super(message);
    this.name = 'ProjectTestsLockedError';
    this.runId = runId;
  }
}

/**
 * Возможности нет на ЭТОЙ машине (нет браузера для PDF) — 501, а не 500 и не
 * пустой файл: человек должен прочитать, чего не хватает, и поставить это.
 */
export class ProjectTestsUnavailableError extends ProjectTestsError {
  override statusCode = 501;
  constructor(message: string) {
    super(message);
    this.name = 'ProjectTestsUnavailableError';
  }
}

/** Идентификатор файла или сущности = имя файла: диапазон сужен намеренно. */
export function assertId(id: string, what = 'Идентификатор'): string {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) {
    throw coded(
      new ProjectTestsError(`${what}: латиница в нижнем регистре, цифры и дефис, до 40 символов.`),
      'id-format-invalid',
      { id },
    );
  }
  return id;
}

/** Абсолютный путь внутри `.agent/tests` — с защитой от обхода каталога. */
export function testsPath(root: string, relative: string): string {
  try {
    return resolveProjectPath(root, `${TESTS_DIR}/${relative}`);
  } catch (error) {
    if (error instanceof ProjectFileError) throw new ProjectTestsError(error.message);
    throw error;
  }
}

/** Путь от корня проекта — его же видит человек в панели. */
export function testsFile(relative: string): string {
  return `${TESTS_DIR}/${relative}`;
}

/** Строка из чужого файла — или значение по умолчанию. */
export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Непустая строка или `undefined` — форма, в которой поля лежат в кейсе. */
export function optional(value: unknown): string | undefined {
  const result = text(value).trim();
  return result || undefined;
}

/** Список строк из чего угодно: массива, строки с переводами, мусора. */
export function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => text(item).trim()).filter(Boolean);
  }
  const single = text(value).trim();
  return single ? [single] : [];
}

/** Разбор JSON-файла раздела. Ошибка — это причина, а не исключение. */
export function readJson(
  root: string,
  relative: string,
): { data?: unknown; error?: string } & CodedMessage {
  const path = testsPath(root, relative);
  if (!existsSync(path)) return {};
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (error) {
    return {
      error: `Файл не читается: ${(error as Error).message}`,
      messageCode: 'file-unreadable',
      params: { reason: (error as Error).message },
    };
  }
  if (raw.byteLength > MAX_FILE_BYTES)
    return { error: 'Файл слишком велик.', messageCode: 'file-too-large' };
  try {
    return { data: JSON.parse(raw.toString('utf8')) as unknown };
  } catch (error) {
    // Файл НЕ чиним и не перезаписываем: за сломанным JSON стоит чья-то работа.
    return {
      error: `Файл не разобрался: ${(error as Error).message}`,
      messageCode: 'file-unparsed',
      params: { reason: (error as Error).message },
    };
  }
}

/** Запись файла раздела: каталог создаётся, замена атомарная. */
export function writeJson(root: string, relative: string, data: unknown): void {
  const path = testsPath(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeJsonFile(path, data);
}

/** Файлы каталога внутри `.agent/tests` с нужным суффиксом, по алфавиту. */
export function listFiles(root: string, dir: string, suffix: string): string[] {
  const path = join(root, ...TESTS_DIR.split('/'), ...dir.split('/').filter(Boolean));
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => entry.name.slice(0, -suffix.length))
      .filter((id) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(id))
      .sort();
  } catch {
    return [];
  }
}

/** Существует ли файл раздела. */
export function testsFileExists(root: string, relative: string): boolean {
  return existsSync(testsPath(root, relative));
}
