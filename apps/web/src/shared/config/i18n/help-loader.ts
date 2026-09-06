import type { HelpSchema } from './help/ru';
import { i18n, type Language } from './instance';

/*
 * Справка — 400 КБ текста на язык, а читают её редко: грузится при первом
 * открытии раздела (лоадер маршрута /help) и при смене языка на открытой
 * странице. Ключи остаются `help.…` в общем неймспейсе — документы разделов
 * ничего не знают о том, что их словарь приехал отдельно.
 */
const helpDictionaries: Record<Language, () => Promise<HelpSchema>> = {
  ru: () => import('./help/ru').then((m) => m.helpRu),
  en: () => import('./help/en').then((m) => m.helpEn),
};
const helpPending = new Map<Language, Promise<void>>();
const helpReady = new Set<Language>();

export function hasHelp(language: Language): boolean {
  return helpReady.has(language);
}

/** Идемпотентно: повторный вызов — тот же промис, чанк не качается дважды. Неудача не залипает. */
export function loadHelp(language: Language): Promise<void> {
  let pending = helpPending.get(language);
  if (!pending) {
    pending = helpDictionaries[language]().then((help) => {
      i18n.addResourceBundle(language, 'translation', { help }, true, true);
      helpReady.add(language);
    });
    pending.catch(() => helpPending.delete(language));
    helpPending.set(language, pending);
  }
  return pending;
}
