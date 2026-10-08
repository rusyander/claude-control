/**
 * Путь к одной сущности. id — не всегда слаг: у прав доступа это
 * `deny:Read(~/.ssh/**)`, и сырая подстановка режет его на лишние сегменты
 * пути — Fastify-маршрут `/:id` читает ровно один сегмент и отвечает 404,
 * то есть правило нельзя ни изменить, ни удалить. Кодируем всегда.
 */
export function entityPath(resource: string, id: string): string {
  return `/${resource}/${encodeURIComponent(id)}`;
}
