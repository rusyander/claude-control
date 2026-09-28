import axios from 'axios';

/**
 * Отказ отправки значит «ответ на прошлый вопрос ещё идёт» (сервер,
 * `provider-chat-routes.ts`, 409 `foreign-answer-running`). Ход при этом ЖИВ:
 * гасить индикатор нельзя — человек увидел бы простой, пока CLI печатает, а
 * ответ появился бы только после перезагрузки.
 */
export function isAnswerRunningRefusal(cause: unknown): boolean {
  return axios.isAxiosError(cause) && cause.response?.status === 409;
}
