import { PICK_SCRIPT_PATH } from '@agentdeck/contracts/site-preview';

/** Тег, который прокси вставляет в страницу: скрипт выбора с того же origin, что и сайт. */
export const PICK_TAG = `<script src="${PICK_SCRIPT_PATH}"></script>`;

/** Вставлять скрипт можно только в разметку страницы: JS, CSS, картинки идут байт в байт. */
export function isHtmlResponse(contentType: string | undefined): boolean {
  return /^\s*text\/html\b/i.test(contentType ?? '');
}

const HEAD_OPEN = /<head(?:\s[^>]*)?>/i;
const HTML_OPEN = /<html(?:\s[^>]*)?>/i;

/**
 * Вставить тег выбора ровно один раз: сразу после `<head>`, без него — после `<html>`, без
 * обоих — в начало. Строка читается как latin1 (байт = символ), поэтому любая кодировка
 * страницы переживает вставку: меняются только байты самого тега.
 */
export function injectPickTag(html: string): string {
  for (const pattern of [HEAD_OPEN, HTML_OPEN]) {
    const match = pattern.exec(html);
    if (match) {
      const at = match.index + match[0].length;
      return `${html.slice(0, at)}${PICK_TAG}${html.slice(at)}`;
    }
  }
  return `${PICK_TAG}${html}`;
}
