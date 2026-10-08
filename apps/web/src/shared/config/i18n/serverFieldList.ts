import type {
  ServerMessageParams,
  ServerMessageNestedParams,
} from '@agentdeck/contracts/server-messages';
import { serverMessageText } from './server-message';

/**
 * Список строк сервера на языке интерфейса: `notes` + `notesCodes` (по коду на
 * строку, `null` — строка кодом не читается). Так приезжают заметки, которые
 * сервер собирает списком: места для кода рядом с каждой строкой нет, и код
 * едет соседним массивом той же длины.
 */
export function serverFieldList<F extends string>(
  record: Partial<Record<F, unknown>> & object,
  field: F,
  translate?: (key: string, options?: ServerMessageParams) => string,
): string[] {
  const source = record as Record<string, unknown>;
  const raw = Array.isArray(source[field]) ? (source[field] as unknown[]) : [];
  const codes = Array.isArray(source[`${field}Codes`])
    ? (source[`${field}Codes`] as unknown[])
    : [];
  return raw.map((item, index) => {
    const entry = codes[index];
    if (typeof entry === 'object' && entry !== null) {
      const { messageCode, params } = entry as { messageCode?: unknown; params?: unknown };
      const translated = serverMessageText(
        messageCode,
        typeof params === 'object' && params !== null
          ? (params as ServerMessageNestedParams)
          : undefined,
        translate,
      );
      if (translated) return translated;
    }
    return typeof item === 'string' ? item : '';
  });
}
