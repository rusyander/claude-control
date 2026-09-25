/**
 * Есть ли у Claude Code авторежим прав для этой модели — без знания о
 * провайдерах, поэтому модуль без импортов: его берёт и реестр прогонов, когда
 * контур подставил свою модель (`ChatRunRegistry.ts`), и тянуть за собой весь
 * реестр провайдеров ради одной таблицы ему незачем.
 *
 * Таблица короткая намеренно: семейства, где авторежим есть, перечислены, всё
 * незнакомое — без него (haiku в их числе нет). Ошибка в сторону «нет» стоит лишь того, что рутину
 * подтвердит панель, а не CLI; ошибка в сторону «да» ставила бы прогон на
 * карточку на каждой правке.
 */
const AUTO_MODE_FAMILIES = ['opus', 'sonnet', 'fable'] as const;

/** Имя модели без регистра и без суффикса контекста (`opus[1m]` → `opus`). */
function normalize(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '');
}

export function claudeModelHasAutoMode(model?: string): boolean {
  const name = normalize(model ?? '');
  // Модель не названа — CLI берёт свою по умолчанию, а она из семейств выше.
  if (!name || name === 'default') return true;
  const segments = name.split(/[-_.:/]/);
  // Алиас (`sonnet`) или полное имя Claude (`claude-sonnet-5`); чужая модель со
  // словом «opus» в названии семейством Claude не является.
  if (segments.length === 1) return (AUTO_MODE_FAMILIES as readonly string[]).includes(name);
  return segments[0] === 'claude' && AUTO_MODE_FAMILIES.some((family) => segments.includes(family));
}
