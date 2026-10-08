import type { ServerMessageNestedParams } from '@agentdeck/contracts/server-messages';
import { serverMessageText } from './server-message';

/** То же для тела ответа об ошибке: `{ messageCode, params }`. */
export function serverMessageFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { messageCode, params } = payload as { messageCode?: unknown; params?: unknown };
  const safeParams =
    typeof params === 'object' && params !== null
      ? (params as ServerMessageNestedParams)
      : undefined;
  return serverMessageText(messageCode, safeParams);
}
