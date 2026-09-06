/**
 * Словарь панели. Русский — в главном чанке, английский и обе справки — ленивые
 * чанки (`instance.ts`, `help-loader.ts`). Снаружи — один вход.
 */
export { i18n, toLanguage } from './instance';
export type { Language } from './instance';
export { hasHelp, loadHelp } from './help-loader';
export { useHelpDictionary } from './useHelpDictionary';
