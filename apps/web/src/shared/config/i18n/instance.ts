import i18n, { type BackendModule } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { ru, type TranslationSchema } from './ru';

export type Language = 'ru' | 'en';

/** `en-US` из настроек браузера → `en`; всё незнакомое — русский, как и fallbackLng. */
export function toLanguage(code: string | undefined): Language {
  return code?.toLowerCase().startsWith('en') ? 'en' : 'ru';
}

/*
 * Русский словарь — в главном чанке: панель открывается сразу, без мигания
 * непереведённого текста. Английский — отдельный чанк, который i18next
 * подтягивает сам при первом `changeLanguage('en')`: это 160 КБ исходника,
 * нужные только тем, кто переключил язык. Пока чанк едет, `t()` отдаёт
 * русский текст (fallbackLng), а не ключи.
 */
const dictionaries: Record<Language, () => Promise<TranslationSchema>> = {
  ru: () => Promise.resolve(ru),
  en: () => import('./en').then((m) => m.en),
};

const lazyDictionaries: BackendModule = {
  type: 'backend',
  init() {},
  read(language, namespace, callback) {
    if (namespace !== 'translation') {
      callback(null, {});
      return;
    }
    dictionaries[toLanguage(language)]().then(
      (dictionary) => callback(null, dictionary),
      (error: unknown) => callback(error instanceof Error ? error : String(error), null),
    );
  },
};

void i18n
  .use(lazyDictionaries)
  .use(initReactI18next)
  .init({
    resources: { ru: { translation: ru } },
    // Есть bundled-ресурсы, но недостающий язык всё равно спрашивать у backend.
    partialBundledLanguages: true,
    lng: 'ru',
    fallbackLng: 'ru',
    interpolation: { escapeValue: false },
  });

export { i18n };
