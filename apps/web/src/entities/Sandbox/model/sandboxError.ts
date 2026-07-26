import { messageFromPayload, toErrorMessage } from '@shared/api/client';

/**
 * Текст ошибки из тела неуспешного ответа песочницы.
 *
 * Прогон читается как поток SSE, но отказ приходит ДО первого кадра: сборка
 * временной конфигурации и чтение доступа на сервере выполняются раньше
 * заголовков потока, поэтому при 4xx/5xx тело — обычный JSON-конверт Fastify
 * без единой строки `data:`. Без разбора цикл чтения просто завершался молча,
 * и пользователь видел пустой ответ вместо причины отказа.
 *
 * Возвращает undefined, если сервер не объяснил отказ, — тогда показывать
 * нужно свой текст со статусом.
 */
export function sandboxErrorText(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;

  try {
    return messageFromPayload(JSON.parse(trimmed));
  } catch {
    // Не JSON (страница прокси, ответ отладочного посредника) — берём как есть,
    // но обрезаем: в разметке ошибки могут быть килобайты.
    return trimmed.slice(0, 300);
  }
}

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
