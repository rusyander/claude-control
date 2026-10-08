/**
 * Значок рядом со словом, а не вместо него: скринридеру он скрыт (`aria-hidden`),
 * человеку — быстрый признак строки, которую стоит прочитать.
 */
export const STATE_GLYPH: Record<string, string> = {
  yes: '✔',
  no: '—',
  indirect: '≈',
  unknown: '?',
};
