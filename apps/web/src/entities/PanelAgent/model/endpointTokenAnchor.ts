import { ENDPOINT_TOKEN_PREFIX } from './pageTarget.constants';

export function endpointTokenAnchor(id: string): string {
  return `${ENDPOINT_TOKEN_PREFIX}${id}`;
}
