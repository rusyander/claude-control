import type { ShotLang } from './shotVariant.types';

/** Язык панели → язык кадра: всё, что не английский, снято по-русски. */
export function shotLangOf(language: string): ShotLang {
  return language.startsWith('en') ? 'en' : 'ru';
}
