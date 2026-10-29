/**
 * Реестр протоколов провода. Сервер перебирает реестр, а не имена: протокол —
 * модуль с одной формой (`matches`, `inspect`, `head`/`body`/`failFrames` для
 * потока, `json`, `errorBody`, `windowHeaders`, необязательный `utility`).
 *
 * Шов под Google (`google-genai`, фаза 10): ещё один модуль той же формы в этот
 * список — `:streamGenerateContent?alt=sse` / `:generateContent`; сервер, сценарии,
 * след и набор проверок его подхватят, а клиент-разборщик в тестах пакета будет
 * обязателен (тест покрытия возможностей покраснеет без него).
 */
import { anthropicMessages } from './anthropic-messages.mjs';
import { openaiChat } from './openai-chat.mjs';
import { openaiResponses } from './openai-responses.mjs';

export const DIALECTS = Object.freeze([anthropicMessages, openaiChat, openaiResponses]);

export const DIALECT_IDS = Object.freeze(DIALECTS.map((dialect) => dialect.id));

/** Протокол запроса по методу и пути (без строки запроса); `undefined` — не модельный путь. */
export const detectDialect = (method, path) =>
  DIALECTS.find((dialect) => dialect.matches(method, path));
