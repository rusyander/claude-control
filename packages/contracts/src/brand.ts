/**
 * Имя продукта и служебные метки, которые оно оставляет в тексте.
 *
 * До 17.09.2026 продукт назывался иначе, и метка `<прежнее имя>:<вид>`
 * успела осесть в транскриптах: служебные блоки ответа агента (`split`,
 * `handoff`, `review`, `plan`, `deck`, `svg`) лежат в истории разговоров навсегда.
 * Панель ПРОСИТ у модели новую метку, а РАЗБИРАЕТ обе — иначе старые разговоры
 * показали бы сырой JSON вместо карточек.
 */

export const BRAND_NAME = 'AgentDeck';
export const BRAND_SLUG = 'agentdeck';
/** Прежнее имя — только для разбора старых меток, никогда для записи. */
const LEGACY_PARTS = ['claude', 'control'];
/**
 * Собрано из частей: история репозитория переписывается заменой слова, и литерал
 * превратился бы в новое имя — старые метки перестали бы узнаваться.
 */
export const LEGACY_BRAND_SLUG = LEGACY_PARTS.join('-');
export const LEGACY_BRAND_NAME = LEGACY_PARTS.map(
  (word) => word.charAt(0).toUpperCase() + word.slice(1),
).join(' ');

/** Язык служебного блока, который панель просит у модели: `agentdeck:<kind>`. */
export function blockLang(kind: string): string {
  return `${BRAND_SLUG}:${kind}`;
}

/** Тот же язык под прежним именем: `<LEGACY_BRAND_SLUG>:<kind>`. */
export function legacyBlockLang(kind: string): string {
  return `${LEGACY_BRAND_SLUG}:${kind}`;
}

/**
 * Фрагмент регулярного выражения: метка под нынешним ИЛИ прежним именем.
 * `kind` — латиница и дефис, экранировать нечего.
 */
export function blockLangPattern(kind: string): string {
  return `(?:${BRAND_SLUG}|${LEGACY_BRAND_SLUG}):${kind}`;
}

/** Метка блока (уже в нижнем регистре) — наш блок этого вида под любым из имён. */
export function isBlockLang(lang: string, kind: string): boolean {
  return lang === blockLang(kind) || lang === legacyBlockLang(kind);
}
