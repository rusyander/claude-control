import type {
  ServerMessageParams,
  ServerMessageNestedParams,
} from '@agentdeck/contracts/server-messages';
import { serverMessageText } from './server-message';

/**
 * Поле записи сервера на языке интерфейса: `detail` + `detailCode` +
 * `detailParams` (и так для любого поля — `reason`, `hint`, `title`…). Без кода
 * или с незнакомым кодом — русский текст поля как есть.
 */
export function serverFieldText<F extends string>(
  record: Partial<Record<F, unknown>> & object,
  field: F,
  translate?: (key: string, options?: ServerMessageParams) => string,
): string {
  const source = record as Record<string, unknown>;
  // У текста отказа (`message`/`error`) код лежит в общих `messageCode` + `params` —
  // так же, как в теле ответа об ошибке.
  const isMessage = field === 'message' || field === 'error';
  const params = source[`${field}Params`] ?? (isMessage ? source.params : undefined);
  const translated = serverMessageText(
    source[`${field}Code`] ?? (isMessage ? source.messageCode : undefined),
    typeof params === 'object' && params !== null
      ? (params as ServerMessageNestedParams)
      : undefined,
    translate,
  );
  if (translated) return translated;
  const raw = source[field];
  return typeof raw === 'string' ? raw : '';
}
