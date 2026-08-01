/**
 * Адрес открытого элемента.
 *
 * `?id=…` — единый способ сослаться на что угодно: разговор, правило, скилл,
 * хук, сервер. Открытие элемента дописывает id в адрес, а переход по такому
 * адресу открывает элемент — ссылкой можно поделиться и вернуться к ней позже.
 *
 * `?topic=…` — раздел справки. Тем же способом: ссылка на объяснение
 * конкретного раздела открывается сразу на нужном документе.
 */
export function validateSearch(search: Record<string, unknown>): {
  id?: string;
  topic?: string;
  create?: boolean;
} {
  return {
    ...(typeof search.id === 'string' && search.id ? { id: search.id } : {}),
    ...(typeof search.topic === 'string' && search.topic ? { topic: search.topic } : {}),
    // `?create=1` — быстрое действие «Добавить» с обзора: раздел открывает свою
    // форму создания (см. useCreateParam). Держим булевым флагом, а не строкой.
    ...(search.create ? { create: true } : {}),
  };
}
