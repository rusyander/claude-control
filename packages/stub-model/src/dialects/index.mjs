/**
 * Реестр протоколов провода. Сервер перебирает реестр, а не имена: протокол —
 * модуль с одной формой (`matches`, `inspect`, `head`/`body`/`failFrames` для
 * потока, `json`, `errorBody`, необязательные `windowHeaders` и `utility`). `inspect`
 * получает тело и путь: у Google модель и поток — в пути.
 *
 * Новый протокол — ещё один модуль той же формы в этот список; сервер, сценарии, след и
 * набор проверок его подхватят, а клиент-разборщик в тестах пакета обязателен (тест покрытия
 * возможностей краснеет без него). Нет `windowHeaders` — шаг с `window` отказ сценария.
 */
import { anthropicMessages } from './anthropic-messages.mjs';
import { googleGenai } from './google-genai.mjs';
import { openaiChat } from './openai-chat.mjs';
import { openaiResponses } from './openai-responses.mjs';

export const DIALECTS = Object.freeze([
  anthropicMessages,
  openaiChat,
  openaiResponses,
  googleGenai,
]);

export const DIALECT_IDS = Object.freeze(DIALECTS.map((dialect) => dialect.id));

/** Протокол запроса по методу и пути (без строки запроса); `undefined` — не модельный путь. */
export const detectDialect = (method, path) =>
  DIALECTS.find((dialect) => dialect.matches(method, path));
