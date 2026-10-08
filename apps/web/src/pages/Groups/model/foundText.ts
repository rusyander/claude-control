import type { DiscoveredGroup } from '@agentdeck/contracts';
import { uiLang } from './uiLang';

export interface FoundText {
  name: string;
  when: string;
  why: string;
}

/**
 * Имя, «Когда» и «почему» находки на языке интерфейса. Пустая сторона пары —
 * вторая сторона; находка старого вида (без пары) — строки как есть: модель
 * писала их на языке файлов, и английское имя в русском интерфейсе было жалобой.
 */
export function foundText(found: DiscoveredGroup, language: string): FoundText {
  const pair = found.localized;
  if (!pair) return { name: found.name, when: found.when, why: found.why };
  const lang = uiLang(language);
  const other = lang === 'en' ? 'ru' : 'en';
  const side = (text: { ru: string; en: string }, fallback: string): string =>
    text[lang].trim() || text[other].trim() || fallback;
  return {
    name: side(pair.name, found.name),
    when: side(pair.when, found.when),
    why: side(pair.why, found.why),
  };
}
