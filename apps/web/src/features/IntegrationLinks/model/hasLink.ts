import type { IntegrationLink } from '@agentdeck/contracts';
import { DEFAULT_INTEGRATIONS, linkRows, type LinkSites } from '@entities/Integration';
import { cleanLink } from './cleanLink';

/** Без сайтов: строки привязки от адресов не зависят, только их ссылки. */
export const NO_SITES: LinkSites = {
  jira: DEFAULT_INTEGRATIONS.jira,
  confluence: DEFAULT_INTEGRATIONS.confluence,
};

/**
 * Есть ли что показать строкой — тем же `linkRows`, что рисует привязку. Одни
 * заголовки без ключа строк не дают, и «Группа «…»» оставалась пустой подписью.
 */
export function hasLink(link: IntegrationLink): boolean {
  return linkRows(cleanLink(link), NO_SITES).length > 0;
}
