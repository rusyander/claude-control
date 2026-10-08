import type { IntegrationLink, IntegrationLinks } from '@agentdeck/contracts';

/**
 * Черновик привязки: что человек выбрал в поиске и что из этого уйдёт на сервер.
 *
 * Из найденного объекта берём ключ и заголовок, но НЕ ссылку: ключ переживает
 * переезд сайта, а адрес собирается из настроек коннектора. Заголовок хранится
 * только чтобы строка привязки читалась без похода в Jira — сам по себе он ни
 * на что не влияет и спокойно устаревает.
 */

/** Привязка нужной области: сам проект или одна из его групп тестов. */
export function pickLink(links: IntegrationLinks | undefined, groupId: string): IntegrationLink {
  if (!links) return {};
  if (!groupId) return links.project ?? {};
  return links.groups?.[groupId] ?? {};
}
