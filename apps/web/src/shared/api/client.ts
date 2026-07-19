import axios from 'axios';

/**
 * Клиент локального API. Базовый путь относительный — Vite проксирует /api
 * на сервер, поэтому адрес и порт нигде в коде не зашиты и не мешают
 * будущей сборке под Electron.
 */
export const apiClient = axios.create({
  baseURL: '/api',
  timeout: 60_000,
});

/**
 * Сообщение об ошибке, пригодное для показа пользователю. Сервер присылает
 * человеческий текст в поле message — берём его, а не сырой статус.
 */
export function toErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const payload = error.response?.data as { message?: string } | undefined;
    return payload?.message ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
