/**
 * Пометки кэша промпта (`cache_control`) на пути Anthropic → OpenAI (n4).
 *
 * Мост раньше выбрасывал их у всех: «у контура кэша нет». Замер 22.10.2026
 * показал обратное — платформа компании держит части содержимого как есть, и
 * LiteLLM внутри доносит пометку до Anthropic: haiku с пометкой `ttl: '1h'`
 * читает префикс из кэша и через шесть минут, без пометки не кэширует ничего.
 * Значит, Claude Code через контур без пометок платит за весь вход каждый ход.
 *
 * Переносятся они ТОЛЬКО у моделей, которым драйвер их объявил
 * (`cacheMarkModels`): чужой ключ в части у gpt и vLLM никто не проверял, и
 * строгий шлюз вправе отвергнуть запрос целиком.
 */

/** Пометка в форме, которую принимает вендор: тип и срок, ничего больше. */
export interface CacheMark {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Пометка блока, очищенная до документированных полей. Чужое поле (бета вендора
 * вроде `scope`) наверх не едет: без заголовка беты, который шлюз не передаёт,
 * Anthropic отвергает запрос с ним целиком. Не та форма — пометки нет.
 */
export function cacheMarkOf(value: unknown): CacheMark | undefined {
  if (!isRecord(value) || value.type !== 'ephemeral') return undefined;
  return value.ttl === '1h' || value.ttl === '5m'
    ? { type: 'ephemeral', ttl: value.ttl }
    : { type: 'ephemeral' };
}

/** Пометка списка инструментов: у Anthropic её ставят на последний инструмент. */
export function toolListMark(tools: unknown): CacheMark | undefined {
  if (!Array.isArray(tools)) return undefined;
  let mark: CacheMark | undefined;
  for (const tool of tools) {
    const own = isRecord(tool) ? cacheMarkOf(tool.cache_control) : undefined;
    if (own) mark = own;
  }
  return mark;
}

/**
 * Переносит ли мост пометки для этой модели. Решает манифест драйвера: свойство
 * платформы (донесёт ли она часть как есть) и семейства модели (прочтёт ли её
 * апстрим) — ни то, ни другое мост сам не знает.
 */
export function forwardsCacheMarks(driver: { cacheMarkModels?: RegExp }, model: unknown): boolean {
  return Boolean(
    driver.cacheMarkModels && typeof model === 'string' && driver.cacheMarkModels.test(model),
  );
}
