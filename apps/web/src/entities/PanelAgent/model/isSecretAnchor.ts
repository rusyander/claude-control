import {
  CONTOUR_KEY_PREFIX,
  MCP_SECRET_PREFIX,
  ENV_SECRET_PREFIX,
  ENDPOINT_TOKEN_PREFIX,
  INTEGRATION_SECRET_PREFIX,
} from './pageTarget.constants';

export const SECRET_PREFIXES = [
  CONTOUR_KEY_PREFIX,
  MCP_SECRET_PREFIX,
  ENV_SECRET_PREFIX,
  ENDPOINT_TOKEN_PREFIX,
  INTEGRATION_SECRET_PREFIX,
];

/** Якорь — поле секрета (ключ контура, секрет MCP, env, токен), который вводит человек. */
export function isSecretAnchor(focus: string | undefined): boolean {
  return SECRET_PREFIXES.some((prefix) => focus?.startsWith(prefix));
}
