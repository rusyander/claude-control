import { INTEGRATION_SECRET_PREFIX } from './pageTarget.constants';

export function integrationSecretAnchor(id: string): string {
  return `${INTEGRATION_SECRET_PREFIX}${id}`;
}
