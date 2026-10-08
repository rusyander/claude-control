/**
 * Словарь панели. Русский — в главном чанке, английский и обе справки — ленивые
 * чанки (`instance.ts`, `help-loader.ts`). Снаружи — один вход.
 */
export { i18n, toLanguage } from './instance';
export type { Language } from './instance';
export { serverMessageText } from './server-message';
export { serverFieldList } from './serverFieldList';
export { serverFieldText } from './serverFieldText';
export { serverMessageFromPayload } from './serverMessageFromPayload';
export { hasHelp } from './help-loader';
export { loadHelp } from './loadHelp';
export { useHelpDictionary } from './useHelpDictionary';
export { presetText } from './preset-text';
export type { PresetArea } from './preset-text';
