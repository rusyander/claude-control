import { MCP_SECRET_PREFIX } from './pageTarget.constants';

export function mcpSecretAnchor(name: string): string {
  return `${MCP_SECRET_PREFIX}${name}`;
}
