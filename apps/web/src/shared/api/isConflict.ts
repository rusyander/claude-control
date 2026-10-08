import axios from 'axios';

/**
 * Отказ 409 — «занято»: сервер отверг запрос не из-за его формы, а потому что
 * состояние ушло вперёд (прогон уже идёт, группу держит чужой прогон). Экран,
 * получивший такой отказ, устарел и должен перечитать состояние.
 */
export function isConflict(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 409;
}
