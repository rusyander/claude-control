import type { IntegrationLink } from '@agentdeck/contracts';

export function withoutConfluencePage(link: IntegrationLink): IntegrationLink {
  const { confluencePageId: _id, confluencePageTitle: _title, ...rest } = link;
  return rest;
}
