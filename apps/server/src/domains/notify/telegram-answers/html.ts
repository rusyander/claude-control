/**
 * Разметка сообщений Telegram — HTML (`parse_mode: 'HTML'`). Всё динамическое
 * (команда, имя чата, текст вопроса, ответ) проходит `escapeHtml` ПОСЛЕ маски
 * секретов: иначе `<` в команде ломал бы разметку, а `&` съедал бы символы.
 *
 * Разметка не разобралась (400 «can't parse entities») — то же сообщение уходит
 * простым текстом: `htmlToPlain` снимает теги и возвращает символы.
 */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** Ответ Bot API «разметку не разобрал». */
export function isParseRefusal(status: number, description: string): boolean {
  return status === 400 && /can't parse entities/i.test(description);
}

export const bold = (html: string): string => `<b>${html}</b>`;

/** Свёрнутая цитата: подробности, которые нужны не всегда. */
export const expandable = (html: string): string => `<blockquote expandable>${html}</blockquote>`;

export const code = (html: string): string => `<code>${html}</code>`;
