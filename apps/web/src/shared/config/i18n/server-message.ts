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
