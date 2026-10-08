import { INTEGRATION_CARD_PREFIX } from './pageTarget.constants';

export function integrationAnchor(id: string): string {
  return `${INTEGRATION_CARD_PREFIX}${id}`;
}
