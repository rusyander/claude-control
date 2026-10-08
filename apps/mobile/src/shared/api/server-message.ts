import {
  formatServerMessage,
  isServerMessageCode,
  resolveServerParams,
  type ServerMessageNestedParams,
} from '@agentdeck/contracts/server-messages';
import { dict } from '../config/i18n';

/**
 * Текст сервера на языке телефона по коду (`contracts/server-messages.ts`).
 * Пусто — кода нет или сервер новее приложения: тогда показывается его текст.
 */
export function serverMessage(
  code: unknown,
  params?: ServerMessageNestedParams,
): string | undefined {
  if (!isServerMessageCode(code)) return undefined;
  const resolved = resolveServerParams(params, (inner, innerParams) =>
    formatServerMessage(dict().serverMessages[inner], innerParams),
  );
  if (!resolved) return undefined;
  return formatServerMessage(dict().serverMessages[code], resolved);
}
