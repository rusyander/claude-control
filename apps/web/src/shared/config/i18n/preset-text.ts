/** Раздел словаря `presets` — `presets/presets.types.ts`. */
export type PresetArea = 'permission' | 'mcp' | 'hook' | 'hookEvent';

type Translate = (key: string, options: { defaultValue: string }) => string;

/**
 * Текст готовой заготовки на языке интерфейса. Русский источник — сама
 * заготовка (contracts, `HookEditor/model/hookPresets.ts`): он и есть
 * `fallback`, и он же показывается, пока перевода нет. Английский — словарь
 * `presets/en.ts`. Без этого английская панель показывала заготовки прав,
 * MCP и хуков по-русски (кадры справки, 28.09).
 *
 * `translate` — `t` из `useTranslation()` вызывающего: так текст меняется
 * вместе с языком без перезагрузки.
 */
export function presetText(
  translate: Translate,
  area: PresetArea,
  id: string,
  field: string,
  fallback: string,
): string {
  return translate(`presets.${area}.${id}.${field}`, { defaultValue: fallback });
}
