import type { IntegrationLink, ConfluencePage } from '@agentdeck/contracts';

export function withConfluencePage(link: IntegrationLink, page: ConfluencePage): IntegrationLink {
  return { ...link, confluencePageId: page.id, confluencePageTitle: page.title };
}
