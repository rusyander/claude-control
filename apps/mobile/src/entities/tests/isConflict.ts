import { ApiError } from '../../shared/api/client';

/**
 * 409 — «занято»: прогон уже идёт (запущен в панели или агентом). Экран с
 * таким отказом устарел и перечитывает состояние, иначе кнопка «Запустить»
 * упиралась бы в тот же отказ снова.
 */
export const isConflict = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 409;
