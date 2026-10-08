import type { AtlassianSettings, IntegrationLink } from '@agentdeck/contracts';
import { linkRows } from '@entities/Integration';
import { cleanLink } from './cleanLink';

/** Без сайта: строки привязки от адресов не зависят, только их ссылки. */
export const NO_SITE: AtlassianSettings = {
  enabled: false,
  baseUrl: '',
  email: '',
  deployment: '',
  confluenceUrl: '',
};

/**
 * Есть ли что показать строкой — тем же `linkRows`, что рисует привязку. Одни
 * заголовки без ключа строк не дают, и «Группа «…»» оставалась пустой подписью.
 */
export function hasLink(link: IntegrationLink): boolean {
  return linkRows(cleanLink(link), NO_SITE).length > 0;
}
