import {
  isServerMessageCode,
  resolveServerParams,
  type ServerMessageNestedParams,
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
  params?: ServerMessageNestedParams,
  translate: (key: string, options?: ServerMessageParams) => string = (key, options) =>
    i18n.t(key, options),
): string | undefined {
  if (!isServerMessageCode(messageCode)) return undefined;
  const resolved = resolveServerParams(params, (code, inner) =>
    translate(`serverMessages.${code}`, inner),
  );
  if (!resolved) return undefined;
  return translate(`serverMessages.${messageCode}`, resolved);
}
