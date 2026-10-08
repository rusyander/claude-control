/** Первый абзац раздела — то, что влезает в подсказку строки. */
export function firstParagraph(text: string, limit = 280): string {
  const paragraph =
    text
      .split(/\n\s*\n/)
      .map((part) => part.replace(/^#+\s*/gm, '').trim())
      .find(Boolean) ?? '';
  const flat = paragraph.replace(/\s+/g, ' ');
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}
