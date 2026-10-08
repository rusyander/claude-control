import type { Language } from './instance';
import type { HelpSchema } from './help/ru';
import { i18n } from './instance';
import { helpReady } from './help-loader.constants';

export const helpPending = new Map<Language, Promise<void>>();

/*
 * Справка — 400 КБ текста на язык, а читают её редко: грузится при первом
 * открытии раздела (лоадер маршрута /help) и при смене языка на открытой
 * странице. Ключи остаются `help.…` в общем неймспейсе — документы разделов
 * ничего не знают о том, что их словарь приехал отдельно.
 */
export const helpDictionaries: Record<Language, () => Promise<HelpSchema>> = {
  ru: () => import('./help/ru').then((m) => m.helpRu),
  en: () => import('./help/en').then((m) => m.helpEn),
};

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
