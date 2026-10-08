/**
 * Перезапускать ли прогон самим после падения.
 *
 * Раньше решение принималось разбором ТЕКСТА ошибки по шаблону («network»,
 * «timed out», «50[234]»). Текст же приходил с пользовательским вводом внутри:
 * вложение с именем `network.zip` или `report 503.pdf` объявлялось «временным
 * сбоем», и клиент дважды молча переотправлял заведомо отклонённое сообщение —
 * несколько секунд тишины вместо ответа. Теперь решает только структурный
 * признак: `retriable` от сервера (он же и разбирает текст CLI — но свой) либо
 * обрыв связи, замеченный самим клиентом. Отказ с кодом не ретраится никогда.
 */
export function shouldAutoRetry(input: {
  error?: string;
  errorCode?: string;
  errorRetriable?: boolean;
  lastPrompt?: string;
  spentRetries: number;
  maxRetries: number;
  stoppedByUser: boolean;
}): boolean {
  if (!input.error || !input.lastPrompt) return false;
  if (input.errorCode) return false;
  if (input.errorRetriable !== true) return false;
  if (input.spentRetries >= input.maxRetries) return false;
  // Остановлено человеком — никаких «сам перезапущу»: кнопка «Остановить»
  // означает «хватит», даже если сбой выглядел временным.
  return !input.stoppedByUser;
}
