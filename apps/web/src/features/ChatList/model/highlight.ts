/**
 * Разбор сниппета на куски с пометкой совпадений — чистая логика подсветки,
 * отделённая от разметки, чтобы её можно было проверить юнит-тестом. Поиск
 * без учёта регистра, регистр исходного текста в кусках сохраняется.
 */

export interface SnippetPart {
  text: string;
  /** Этот кусок совпал с запросом — его подсвечивают в разметке. */
  match: boolean;
}

/** Делит `snippet` на чередующиеся куски «обычный / совпавший» по запросу. */
export function highlightSnippet(snippet: string, query: string): SnippetPart[] {
  const needle = query.trim();
  if (!snippet) return [];
  if (!needle) return [{ text: snippet, match: false }];

  const lowerSnippet = snippet.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const parts: SnippetPart[] = [];
  let index = 0;

  while (index < snippet.length) {
    const at = lowerSnippet.indexOf(lowerNeedle, index);
    if (at < 0) {
      parts.push({ text: snippet.slice(index), match: false });
      break;
    }

    if (at > index) parts.push({ text: snippet.slice(index, at), match: false });
    parts.push({ text: snippet.slice(at, at + needle.length), match: true });
    index = at + needle.length;
  }

  return parts;
}
