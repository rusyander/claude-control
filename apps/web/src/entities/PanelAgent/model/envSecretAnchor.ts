import { ENV_SECRET_PREFIX } from './pageTarget.constants';

export function envSecretAnchor(key: string): string {
  return `${ENV_SECRET_PREFIX}${key}`;
}
