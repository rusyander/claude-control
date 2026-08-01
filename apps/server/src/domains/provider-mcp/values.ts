/**
 * Общие проверки чужих значений и слияние немоделируемых полей записи.
 *
 * Чужой конфиг написан человеком, а не панелью: форма каждого поля — лишь
 * ожидание, поэтому все читатели форматов приводят значения одинаково
 * (рукописный `"args": "-y pkg"` иначе уехал бы в API строкой под видом
 * `string[]` и уронил страницу на `args.join(' ')`).
 */

/** Значение — отображение «строка → строка» (env, headers). */
export function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === 'string');
}

/** Список строк из чужого значения: не массив → пусто, чужие элементы отброшены. */
export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Общий для всех форматов порядок вывода серверов — по имени. */
export function sortByName<T extends { name: string }>(servers: T[]): T[] {
  return servers.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Поля прежней записи, которые панель НЕ моделирует, — их она переносит по
 * значению, чтобы правка одного сервера не теряла чужих настроек.
 */
export function preserveUnmodelled(
  existing: Record<string, unknown> | undefined,
  modelledKeys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(existing ?? {}).filter(([key]) => !modelledKeys.includes(key)),
  );
}
