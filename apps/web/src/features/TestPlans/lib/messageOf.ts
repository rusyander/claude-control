import { messageFromPayload } from '@shared/api/client';

/** Текст отказа сервера одной строкой — например «правила „магия“ нет». */
export function messageOf(error: unknown): string {
  const response = (error as { response?: { data?: unknown } }).response;
  return messageFromPayload(response?.data) ?? (error as Error).message;
}
