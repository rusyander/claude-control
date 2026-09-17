import {
  formatServerMessage,
  isServerMessageCode,
  type ServerMessageParams,
} from '@agentdeck/contracts/server-messages';
import { dict } from '../config/i18n';

/**
 * Текст сервера на языке телефона по коду (`contracts/server-messages.ts`).
 * Пусто — кода нет или сервер новее приложения: тогда показывается его текст.
 */
export function serverMessage(code: unknown, params?: ServerMessageParams): string | undefined {
  if (!isServerMessageCode(code)) return undefined;
  return formatServerMessage(dict().serverMessages[code], params);
}
