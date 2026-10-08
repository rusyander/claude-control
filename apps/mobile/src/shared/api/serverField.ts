import type { ServerMessageNestedParams } from '@agentdeck/contracts/server-messages';
import { serverMessage } from './server-message';

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
