import {
  isServerMessageCode,
  type ServerMessageParams,
} from '@agentdeck/contracts/server-messages';
import { i18n } from './instance';

/**
 * Текст сервера на языке интерфейса — по коду (`contracts/server-messages.ts`).
 *
 * Пусто, если кода нет или он панели не знаком (сервер новее фронта): тогда
 * вызывающий показывает русский текст сервера как есть, а не пустое место.
 */
export function serverMessageText(
  messageCode: unknown,
  params?: ServerMessageParams,
  translate: (key: string, options?: ServerMessageParams) => string = (key, options) =>
    i18n.t(key, options),
): string | undefined {
  if (!isServerMessageCode(messageCode)) return undefined;
  return translate(`serverMessages.${messageCode}`, params);
}

/** То же для тела ответа об ошибке: `{ messageCode, params }`. */
export function serverMessageFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { messageCode, params } = payload as { messageCode?: unknown; params?: unknown };
  const safeParams =
    typeof params === 'object' && params !== null ? (params as ServerMessageParams) : undefined;
  return serverMessageText(messageCode, safeParams);
}
