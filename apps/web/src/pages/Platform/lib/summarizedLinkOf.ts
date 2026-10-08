import type { PlatformSummarizedLink } from '@agentdeck/contracts';

/**
 * Решения карточки «Контур сжимал историю» — здесь, а не в разметке: прогон
 * фронта идёт в node и компонентов не рендерит.
 */

export const LINKS: readonly PlatformSummarizedLink[] = ['message', 'run', 'none'];

/** Привязка случая; незнакомое слово сервера читается как «подписать негде». */
export function summarizedLinkOf(link: unknown): PlatformSummarizedLink {
  return LINKS.includes(link as PlatformSummarizedLink) ? (link as PlatformSummarizedLink) : 'none';
}
