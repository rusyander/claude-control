import { isAxiosError } from 'axios';

/**
 * Сервер не принял одобрение: предпросмотр карточки неполный (409
 * `preview_truncated`). Карточка об этом могла не знать — окно гасит «Выполнить»
 * и оставляет её ждать отклонения, а не показывает общий «не принято».
 */
export function isPreviewTruncatedRefusal(error: unknown): boolean {
  if (!isAxiosError(error) || error.response?.status !== 409) return false;
  const data = error.response.data as { error?: unknown } | undefined;
  return data?.error === 'preview_truncated';
}
