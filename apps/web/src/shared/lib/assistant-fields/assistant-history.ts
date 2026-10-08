import type { AssistTurn } from './assistant-fields.types';

/**
 * Прежние реплики окна помощника — в тело запроса.
 *
 * Сессии у помощника нет (лёгкое окно, решение владельца D4 28.09): сервер
 * запускает CLI без сохранения разговора, и «поменяй только описание» вторым
 * ходом понятно модели лишь потому, что первый ход едет в том же запросе.
 * Неудачный ответ («помощник не ответил») — не реплика разговора: модель его
 * не писала.
 */
export function assistHistory(
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; text: string; failed?: boolean }>,
): AssistTurn[] {
  return messages
    .filter((message) => !message.failed && message.text.trim())
    .map((message) => ({ role: message.role, text: message.text }));
}
