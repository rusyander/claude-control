import { UnrecognizedFormatError } from '../../lib/codex-toml.ts';

/**
 * Общая нормализация для всех форматов раздела: разбор списков черновика,
 * чтение списков и секций из файла и вычитание ведомых ключей из проекции
 * «всё, кроме нашего».
 */

/**
 * Список имён инструментов: массив непустых строк. Пробелы по краям срезаются,
 * повторы схлопываются (порядок первого вхождения сохраняется). Не массив или
 * элемент не строка → `undefined` (черновик целиком отклоняется).
 */
export function parseToolList(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const list: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    const name = item.trim();
    if (!name) continue;
    if (!list.includes(name)) list.push(name);
  }
  return list;
}

/**
 * Список строк ИЗ ФАЙЛА (имена инструментов Gemini, правила Qwen и Cursor). Не
 * массив строк → fail-closed (форма не наша).
 */
export function readStringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new UnrecognizedFormatError();
  if (!value.every((item) => typeof item === 'string')) throw new UnrecognizedFormatError();
  return value as string[];
}

/** Секция файла как объект. Не объект (строка/массив/число) → fail-closed. */
export function objectSection(
  config: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const section = config[key];
  if (section === undefined || section === null) return undefined;
  if (typeof section !== 'object' || Array.isArray(section)) throw new UnrecognizedFormatError();
  return section as Record<string, unknown>;
}

/**
 * Вычесть ведомые панелью ключи из секции проекции. Секция, оставшаяся пустой
 * после вычитания, из проекции убирается — иначе `{}` и «ключа не было»
 * считались бы разными и запись падала бы на здоровом файле.
 *
 * Возвращает `false`, если секции нет или она не объект: вызывающий решает,
 * оставить такую форму в проекции или выбросить её целиком.
 */
export function stripManagedSectionKeys(
  rest: Record<string, unknown>,
  key: string,
  managed: readonly string[],
): boolean {
  const section = rest[key];
  if (!section || typeof section !== 'object' || Array.isArray(section)) return false;
  const sectionRest: Record<string, unknown> = { ...(section as Record<string, unknown>) };
  for (const name of managed) delete sectionRest[name];
  if (Object.keys(sectionRest).length > 0) rest[key] = sectionRest;
  else delete rest[key];
  return true;
}
