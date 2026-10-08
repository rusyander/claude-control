/**
 * Надиктованное дописывается к набранному до микрофона. Отправки здесь нет:
 * агенту сообщение отдаёт человек, и оно идёт тем же путём, что набранное, —
 * через маску данных сервера.
 */
export function appendDictation(typed: string, heard: string): string {
  const text = heard.trim();
  if (!text) return typed;
  const base = typed.trimEnd();
  return base ? `${base} ${text}` : text;
}
