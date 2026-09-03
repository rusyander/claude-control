/**
 * Текст отказа сервера, если он его прислал: он точнее общей формулировки
 * («правило «Почта»: выражение не разбирается» вместо «сохранить не удалось»).
 */
export function dlpErrorMessage(error: unknown, fallback: string): string {
  const message = (error as { response?: { data?: { message?: unknown } } } | null)?.response?.data
    ?.message;
  return typeof message === 'string' && message.trim() ? message : fallback;
}
