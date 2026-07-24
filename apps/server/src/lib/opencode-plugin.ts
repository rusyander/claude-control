import { UnrecognizedFormatError } from './codex-toml.ts';

/**
 * Плагины OpenCode из npm — ключ `plugin` в `opencode.json` (OPENCODE-4, часть 2).
 *
 * КЛЮЧ ПОДТВЕРЖДЁН ДОКУМЕНТАЦИЕЙ, а не угадан: страница плагинов OpenCode и
 * справочник конфигурации называют его одинаково, и он же есть в опубликованной
 * схеме `https://opencode.ai/config.json` как свойство корня:
 *
 * ```jsonc
 * {
 *   "$schema": "https://opencode.ai/config.json",
 *   "plugin": ["opencode-helicone-session", "opencode-wakatime", "@my-org/custom-plugin"]
 * }
 * ```
 *
 * Обычные и scoped-пакеты (`@org/name`) поддерживаются одинаково.
 *
 * РАСШИРЕННАЯ ФОРМА. По схеме элементом массива может быть не только строка, но и
 * ПАРА `[имя, объект-настроек]`. Такую запись панель НЕ ведёт: формы её настроек
 * документация не описывает, и переписывать её вслепую нельзя. Она сохраняется по
 * значению и показывается только для чтения — ровно как «сохранённые» записи в
 * разделе прав (OPENCODE-1).
 *
 * FAIL-CLOSED: `plugin` не массив → `UnrecognizedFormatError` (раздел только для
 * чтения, запись 422). Пустой результат УДАЛЯЕТ ключ, а не пишет `[]`.
 */

/** Запись `plugin`, которую панель не ведёт (пара «имя + настройки»). */
export interface OpencodePluginPreservedEntry {
  /** Позиция в массиве — единственная её идентичность (имени у пары может не быть). */
  index: number;
  /** Значение в компактном JSON — только для показа (в файле оно не меняется). */
  value: string;
}

/** Разобранное состояние ключа `plugin`. */
export interface OpencodePluginState {
  /** Ключ `plugin` присутствует в файле. */
  present: boolean;
  /** Имена npm-пакетов простой формы, в порядке файла. */
  packages: string[];
  /** Записи расширенной формы — сохраняются как есть. */
  preserved: OpencodePluginPreservedEntry[];
}

/** Максимальная длина показываемого значения сохранённой записи. */
const PRESERVED_VALUE_LIMIT = 200;

/** Компактное значение для показа сохранённой записи (обрезается по длине). */
function describeValue(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > PRESERVED_VALUE_LIMIT ? `${text.slice(0, PRESERVED_VALUE_LIMIT)}…` : text;
}

/**
 * Имя npm-пакета в форме, которую панель принимает к записи: непустая строка без
 * пробелов и переводов строк. Scoped-пакеты (`@org/name`) допустимы явно.
 *
 * Полную валидацию имён npm панель не изображает: задача — не пустить в файл
 * заведомо сломанное значение (пустое, с пробелом, с кавычкой-переводом строки),
 * а не подменить собой сам npm.
 */
export function isOpencodePluginPackage(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && /^[^\s"']+$/.test(value);
}

/**
 * Разобрать значение ключа `plugin`.
 *
 * `undefined` → ключа нет (npm-плагинов не подключено; ключ панель молча не
 * создаёт). Не массив (объект, строка, число) → `UnrecognizedFormatError`.
 */
export function readOpencodePlugins(raw: unknown): OpencodePluginState {
  if (raw === undefined || raw === null) return { present: false, packages: [], preserved: [] };
  if (!Array.isArray(raw)) throw new UnrecognizedFormatError();

  const packages: string[] = [];
  const preserved: OpencodePluginPreservedEntry[] = [];

  raw.forEach((item, index) => {
    if (typeof item === 'string' && item.trim()) packages.push(item);
    else preserved.push({ index, value: describeValue(item) });
  });

  return { present: true, packages, preserved };
}

/**
 * Собрать новое значение ключа `plugin` из черновика.
 *
 * Простые (строковые) записи заменяются черновиком целиком, а записи расширенной
 * формы остаются НА СВОИХ ПОЗИЦИЯХ по значению: сначала идут сохранённые записи
 * в исходном порядке относительно друг друга, вперемешку с новыми именами так,
 * чтобы их индексы не «переехали» сильнее необходимого. Проще и честнее:
 * сохранённые записи держим в их относительном порядке в начале там, где они и
 * были, а список имён кладём в порядке черновика.
 *
 * Пустой результат → `undefined`: вызывающий УДАЛЯЕТ ключ, а не пишет `[]`.
 */
export function applyOpencodePlugins(raw: unknown, packages: string[]): unknown[] | undefined {
  const original = raw === undefined || raw === null ? [] : raw;
  if (!Array.isArray(original)) throw new UnrecognizedFormatError();

  for (const name of packages) {
    if (!isOpencodePluginPackage(name)) throw new UnrecognizedFormatError();
  }

  // Записи, которых панель не ведёт, переносим как есть и в прежнем порядке —
  // сначала они, потом список имён из черновика. Позиции внутри массива для
  // OpenCode не значимы (это набор подключаемых плагинов), а порядок сохранённых
  // записей относительно друг друга остаётся прежним.
  const kept = original.filter((item) => !(typeof item === 'string' && item.trim()));
  const next = [...kept, ...packages];

  return next.length > 0 ? next : undefined;
}
