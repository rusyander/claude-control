/** Первая непустая строка без markdown-заголовка — то, что влезает в строку карточки. */
export function firstLine(text: string): string | undefined {
  const line = text
    .split('\n')
    .map((item) => item.replace(/^#+\s*/, '').trim())
    .find(Boolean);
  return line || undefined;
}
