import axios from 'axios';

/** Код текста отказа сервера (`messageCode`) — чтобы отличить ответ от сбоя. */
export function messageCodeOf(error: unknown): string | undefined {
  if (!axios.isAxiosError(error)) return undefined;
  const data: unknown = error.response?.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const code = (data as { messageCode?: unknown }).messageCode;
  return typeof code === 'string' ? code : undefined;
}
