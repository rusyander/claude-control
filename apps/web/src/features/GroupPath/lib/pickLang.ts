import type { LocalizedText } from '@agentdeck/contracts';

/** Сторона текста на языке интерфейса; пустая — вторая, чтобы строка не была безымянной. */
export function pickLang(text: LocalizedText, language: string): string {
  const own = language.startsWith('en') ? text.en : text.ru;
  const other = language.startsWith('en') ? text.ru : text.en;
  return own.trim() || other.trim();
}
