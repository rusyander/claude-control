import type { PathLang } from '@agentdeck/contracts';

/** Другая сторона — та, что переводится с правленной. */
export function otherLang(lang: PathLang): PathLang {
  return lang === 'ru' ? 'en' : 'ru';
}
