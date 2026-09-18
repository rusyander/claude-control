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

/**
 * Поле записи сервера на языке телефона: `detail` + `detailCode` +
 * `detailParams` (и так для любого поля). Без кода — русский текст поля.
 */
export function serverField(record: object, field: string): string {
  const source = record as Record<string, unknown>;
  // У текста отказа (`message`/`error`) код лежит в общих `messageCode` + `params` —
  // так же, как в теле ответа об ошибке.
  const isMessage = field === 'message' || field === 'error';
  const params = source[`${field}Params`] ?? (isMessage ? source.params : undefined);
  const translated = serverMessage(
    source[`${field}Code`] ?? (isMessage ? source.messageCode : undefined),
    typeof params === 'object' && params !== null
      ? (params as ServerMessageNestedParams)
      : undefined,
  );
  if (translated) return translated;
  const raw = source[field];
  return typeof raw === 'string' ? raw : '';
}
