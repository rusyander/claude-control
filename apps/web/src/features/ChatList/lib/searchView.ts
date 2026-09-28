/**
 * Что показывать под полем поиска разговоров.
 *
 * В режиме «По сообщениям» совпадения приходят с сервера, и только когда
 * запрос не короче минимума. Раньше короткий или ПУСТОЙ запрос всё равно
 * показывал совпадения — прежние, оставшиеся от последнего поиска, — а вместо
 * счётчика висела подсказка «введите хотя бы 2 символа». Человек стирал
 * «кактус» и видел один разговор вместо всех (кейс chat-006).
 *
 *  - `useBodyHits` — список строится из ответа сервера; иначе — весь список;
 *  - `showHint` — подсказка про минимум вместо счётчика: только пока запрос
 *    набирается (не пуст, но короче минимума). Пустое поле — это «покажи всё»,
 *    и счётчик обязан сказать «N из N».
 */
export function searchView(input: {
  mode: 'title' | 'messages';
  /** То, что сейчас в поле, — без дебаунса: подсказка должна исчезнуть сразу. */
  query: string;
  /** Запрос, ушедший на сервер (после дебаунса). */
  bodyQuery: string;
  minLength: number;
}): { useBodyHits: boolean; showHint: boolean } {
  if (input.mode !== 'messages') return { useBodyHits: false, showHint: false };
  const typed = input.query.trim();
  const isBodyReady = input.bodyQuery.length >= input.minLength;
  return {
    // Оба условия: дебаунс отстаёт от поля, и стёртый запрос не должен ещё
    // полсекунды показывать ответ на прежний.
    useBodyHits: isBodyReady && typed.length >= input.minLength,
    showHint: typed.length > 0 && typed.length < input.minLength,
  };
}
