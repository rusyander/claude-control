/**
 * Похоже ли падение прогона на временное — «сеть моргнула», перегрузка, таймаут.
 *
 * Разбор текста живёт ЗДЕСЬ, а не на клиенте, и применяется только к ошибкам,
 * пришедшим от самого CLI. Клиент по тексту не решает ничего: он видит готовый
 * флаг. Отказы панели (занят/вложение/нет папки) сюда не попадают вовсе — они
 * уходят HTTP-статусом с кодом, и подставить в такой текст своё имя файла,
 * чтобы выпросить авто-ретрай, больше нельзя.
 */
export function isRetriableRunError(message: string): boolean {
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed|Connection error|overloaded|temporarily|timed?\s?out|\b50[234]\b|\b529\b/i.test(
    message,
  );
}
