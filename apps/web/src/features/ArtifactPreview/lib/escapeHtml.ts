/** Экранирование текста файла, когда подсветка ещё не готова. */
export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char] ?? char,
  );
}
