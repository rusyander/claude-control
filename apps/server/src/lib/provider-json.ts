import { UnrecognizedFormatError } from './codex-toml.ts';
import { stripBom } from './text-form.ts';

/**
 * Разбор JSON-конфига ЧУЖОГО инструмента (Gemini `settings.json`, Cursor
 * `mcp.json`, OpenCode `opencode.json`) — один на все разделы, чтобы правила
 * fail-closed не разъезжались между MCP, env и правами.
 *
 * BOM снимается: с ним `JSON.parse` падает на совершенно валидном файле (так его
 * пишут Блокнот и PowerShell), и раздел уходил бы в режим «только чтение» на
 * здоровом конфиге. Обратно BOM вернёт `writeTextFile` (он сохраняет форму файла).
 *
 * Любая ошибка разбора и любой корень, кроме объекта (массив, число, `null`), →
 * `UnrecognizedFormatError`: панель не знает, что это за файл, и не пишет в него.
 */
/**
 * Стабильное представление значения для СРАВНЕНИЯ «до/после»: ключи объектов
 * сортируются рекурсивно, порядок массивов сохраняется. Нужно проекциям «всё,
 * кроме управляемых панелью ключей»: сравнивать надо СОДЕРЖИМОЕ, а не порядок
 * обхода, причём на ЛЮБОЙ глубине (замена-массив у `JSON.stringify` фильтрует
 * ключи на всех уровнях сразу и для вложенных объектов работает неверно).
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',');
  return `{${body}}`;
}

export function parseProviderJsonObject<T>(text: string): T {
  try {
    const parsed = JSON.parse(stripBom(text)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new UnrecognizedFormatError();
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof UnrecognizedFormatError) throw error;
    throw new UnrecognizedFormatError();
  }
}
