import type { PathLang } from '@agentdeck/contracts';
import { otherLang } from './otherLang';

/**
 * Вкладка языка после клавиши, как в любом tablist: стрелки — на соседнюю,
 * Home/End — к краям списка. Раньше Home/End тоже переключали сторону, и Home
 * на первой вкладке уводил на последнюю. Не клавиша вкладок — `undefined`.
 */
export function langAfterKey(key: string, lang: PathLang): PathLang | undefined {
  if (key === 'Home') return 'ru';
  if (key === 'End') return 'en';
  if (key === 'ArrowLeft' || key === 'ArrowRight') return otherLang(lang);
  return undefined;
}
