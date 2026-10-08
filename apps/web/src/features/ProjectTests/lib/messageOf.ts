import { messageFromPayload } from '@shared/api/client';

/** Текст ошибки любой из мутаций — одной строкой, как её показывает окно. */
export function messageOf(error: unknown): string | undefined {
  if (!error) return undefined;
  const response = (error as { response?: { data?: unknown } }).response;
  return messageFromPayload(response?.data) ?? (error as Error).message;
}
