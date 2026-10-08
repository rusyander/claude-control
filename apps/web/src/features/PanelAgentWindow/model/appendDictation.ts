/**
 * Надиктованное ДОПИСЫВАЕТСЯ к набранному: часть фразы могла быть набрана
 * руками до микрофона. Отправки здесь нет и быть не должно — решает человек.
 */
export function appendDictation(current: string, heard: string): string {
  const text = heard.trim();
  if (!text) return current;
  const base = current.trimEnd();
  return base ? `${base} ${text}` : text;
}
