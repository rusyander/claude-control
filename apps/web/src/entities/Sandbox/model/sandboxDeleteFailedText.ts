import { toErrorMessage } from '../../../shared/api/toErrorMessage';

/**
 * Текст о песочнице, которую не удалось удалить.
 *
 * Сервер намеренно отвечает отказом, а не `{ok:true}`: внутри песочницы лежит
 * копия доступа к аккаунту, и «удалили» вместо «не смогли» — худший из ответов.
 * До экрана этот отказ доходил без рамки: сырое сообщение сервера показывалось
 * как есть, на любом языке интерфейса. Объяснение сервера сохраняем целиком —
 * в нём назван путь к папке, а руками убрать её больше некому.
 */
export function sandboxDeleteFailedText(
  error: unknown,
  translate: (key: string, vars?: Record<string, unknown>) => string,
): string {
  return translate('sandbox.deleteFailed', { reason: toErrorMessage(error) });
}
