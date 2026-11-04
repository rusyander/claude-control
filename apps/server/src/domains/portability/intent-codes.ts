import type {
  NestedServerMessage,
  ServerMessageCode,
  ServerMessageNestedParams,
} from '@agentdeck/contracts/server-messages';

/**
 * Фраза записи паспорта (`intent`) с кодом перевода. Русская строка остаётся
 * запасной — её показывает клиент, которому код незнаком, — а интерфейс
 * переводит по коду. Обе половины собираются рядом, в одном вызове сборщика:
 * `intent-codes.test.ts` сверяет, что русский показ по коду дословно равен строке
 * сервера и что под en кириллицы нет.
 */
export interface CodedIntent {
  intent: string;
  intentCode: ServerMessageCode;
  intentParams?: ServerMessageNestedParams;
}

export function codedIntent(
  intent: string,
  intentCode: ServerMessageCode,
  intentParams?: ServerMessageNestedParams,
): CodedIntent {
  return intentParams ? { intent, intentCode, intentParams } : { intent, intentCode };
}

/** Вложенный код без подстановок — необязательный хвост фразы или «без описания». */
export const nested = (
  messageCode: ServerMessageCode,
  params?: Record<string, string | number>,
): NestedServerMessage => (params ? { messageCode, params } : { messageCode });

/** Пустое описание: русская подстановка и вложенный код того же «без описания». */
export function describedOr(description: string): {
  ru: string;
  param: string | NestedServerMessage;
} {
  return description
    ? { ru: description, param: description }
    : { ru: 'без описания', param: nested('portability-intent-no-description') };
}
