/**
 * Название разговора, начатого просьбой режима («Презентация», «Картинка»).
 *
 * Сервер зовёт такой разговор словом режима и словами человека: «Картинка: кот
 * на окне». Слово пишется по-русски — название одно на все клиенты и кэшируется,
 * — а панель и телефон на английском меняют его на своё (ревью: название чата
 * оставалось русским при английском интерфейсе). Слово режима — то же, что в меню
 * отправки: «Рисунок» в ленте и «Картинка» в меню называли одно и то же по-разному
 * (ревью z4 C15).
 */
export const MEDIA_TITLE_WORD = {
  deck: 'Презентация',
  'deck-revise': 'Правка презентации',
  picture: 'Картинка',
} as const;

export type MediaTitleMode = keyof typeof MEDIA_TITLE_WORD;

/** Прежнее слово: названия, собранные до переименования, лежат в кэше сводок. */
const LEGACY_TITLE_WORD: Record<string, MediaTitleMode> = { Рисунок: 'picture' };

export function mediaTitle(mode: MediaTitleMode, topic: string): string {
  return `${MEDIA_TITLE_WORD[mode]}: ${topic}`;
}

/** Название на языке клиента: слово режима — своим, слова человека — как есть. */
export function localizeMediaTitle(title: string, word: (mode: MediaTitleMode) => string): string {
  const words: [string, MediaTitleMode][] = [
    ...(Object.entries(MEDIA_TITLE_WORD) as [MediaTitleMode, string][]).map(
      ([mode, ru]): [string, MediaTitleMode] => [ru, mode],
    ),
    ...Object.entries(LEGACY_TITLE_WORD),
  ];
  for (const [ru, mode] of words) {
    const prefix = `${ru}: `;
    if (title.startsWith(prefix)) return `${word(mode)}: ${title.slice(prefix.length)}`;
  }
  return title;
}
