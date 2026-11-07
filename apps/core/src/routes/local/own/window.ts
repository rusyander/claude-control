import { LOCAL_REPLY_RESERVE_TOKENS } from '@agentdeck/contracts/local-models';

/**
 * Окно своей модели на постоянном адресе (этап 10, зона C4; перенесено со шлюза в панели
 * `gateway/local-window`). Запрос, не влезающий в окно сервера, получает отказ в том виде, который
 * клиент узнаёт, а не 400 llama-server («request exceeds the available context size»), который
 * Claude Code и Qwen Code не узнают и на котором ход умирал.
 *
 * Тексты отказов — не наши: по «prompt is too long: N tokens > M maximum» (статус 400) Claude Code
 * сжимает историю и повторяет сам, по «input length and `max_tokens` exceed context limit: X + Y > Z»
 * уменьшает `max_tokens` (бинарь 2.1.286). Поэтому английский и без перевода.
 */

export { LOCAL_REPLY_RESERVE_TOKENS };

/** Диалект запроса по пути: от него зависят форма отказа и что делать с `max_tokens`. */
export type WindowDialect = 'anthropic' | 'openai';

export function dialectOf(method: string | undefined, path: string): WindowDialect | undefined {
  if (method !== 'POST') return undefined;
  const clean = path.split('?')[0] ?? '';
  if (clean === '/v1/messages') return 'anthropic';
  if (clean === '/v1/chat/completions' || clean === '/chat/completions') return 'openai';
  return undefined;
}

/** Меньше этого ждать первый байт у локальной модели нельзя: холодная загрузка и полный промпт. */
export const LOCAL_FIRST_TOKEN_FLOOR_MS = 300_000;
/** Скорость обработки промпта, когда замера нет: заведомо ниже видеокарты, выше процессора. */
export const FALLBACK_PROMPT_TPS = 150;
/** Запас сверх расчётного времени: обрабатывающий промпт сервер делит карту с остальным. */
const FIRST_TOKEN_SLACK = 1.5;
/** Символов на токен без токенайзера модели: ниже, чем у кода и английского — оценка с запасом. */
const CHARS_PER_TOKEN = 3;
/** Доля окна, выше которой оценке не верят и спрашивают у сервера точный счёт (~36 мс). */
const PRECOUNT_SHARE = 0.75;
/** Запас под расхождение оценки и счёта сервера и под служебные токены шаблона. */
const CLAMP_MARGIN_TOKENS = 512;
/** Меньше этого ответу не оставляем: вход плюс резерв уже проверены. */
const MIN_REPLY_TOKENS = 1_024;

export function estimateTokens(bodyChars: number): number {
  return Math.ceil(bodyChars / CHARS_PER_TOKEN);
}

export function needsPrecount(estimate: number, context: number): boolean {
  return estimate + LOCAL_REPLY_RESERVE_TOKENS > context * PRECOUNT_SHARE;
}

export function promptLimitOf(context: number): number {
  return Math.max(0, context - LOCAL_REPLY_RESERVE_TOKENS);
}

export function promptTooLongMessage(tokens: number, limit: number): string {
  return `prompt is too long: ${Math.round(tokens)} tokens > ${Math.round(limit)} maximum`;
}

/**
 * Вход влезает, а вход плюс `max_tokens` — нет: текст, по которому Claude Code сам ставит
 * `max_tokens = Z − X − 1000` и повторяет. `вход + запас ≤ окно` гарантирует, что ему останется
 * не меньше 3000 токенов.
 */
export function maxTokensOverflowMessage(
  promptTokens: number,
  maxTokens: unknown,
  context: number,
): string | undefined {
  const reply =
    typeof maxTokens === 'number' && Number.isFinite(maxTokens) ? Math.floor(maxTokens) : 0;
  if (reply <= 0) return undefined;
  if (promptTokens + reply <= context) return undefined;
  if (promptTokens + LOCAL_REPLY_RESERVE_TOKENS > context) return undefined;
  return `input length and \`max_tokens\` exceed context limit: ${Math.round(promptTokens)} + ${reply} > ${context}`;
}

/**
 * Клиенты OpenAI-диалекта (Qwen Code, Codex) `max_tokens` по отказу не уменьшают: ответ урезается
 * здесь до остатка окна с запасом, чтобы сервер не вёл генерацию до предела и не обрывал её «длиной».
 * Нет поля или остаток шире запроса — тело как есть (`undefined`).
 */
export function clampReplyTokens(
  body: Record<string, unknown>,
  promptTokens: number,
  context: number,
): Record<string, unknown> | undefined {
  const room = Math.max(MIN_REPLY_TOKENS, context - Math.ceil(promptTokens) - CLAMP_MARGIN_TOKENS);
  let out: Record<string, unknown> | undefined;
  for (const field of ['max_tokens', 'max_completion_tokens']) {
    const asked = body[field];
    if (typeof asked === 'number' && Number.isFinite(asked) && asked > room) {
      out = { ...(out ?? body), [field]: room };
    }
  }
  return out;
}

/**
 * Срок первого байта: расчётное время разбора промпта с запасом, но не меньше пяти минут.
 * Фиксированный срок обрывал законный разбор: 130 тысяч токенов при 360 ток/с — шесть минут.
 */
export function firstTokenTimeoutMs(
  promptTokens: number,
  promptTokensPerSecond: number | undefined,
  floorMs: number = LOCAL_FIRST_TOKEN_FLOOR_MS,
): number {
  const speed =
    promptTokensPerSecond && promptTokensPerSecond > 0
      ? promptTokensPerSecond
      : FALLBACK_PROMPT_TPS;
  return Math.max(floorMs, Math.ceil((promptTokens / speed) * 1_000 * FIRST_TOKEN_SLACK));
}

/**
 * Отказ llama-server «не влезает в окно» → числа (`exceed_context_size_error`, `n_prompt_tokens`,
 * `n_ctx`, либо текст «request (N tokens) exceeds the available context size (M tokens)»).
 */
export function overflowOfUpstream(
  status: number,
  body: unknown,
): { tokens: number; context: number } | undefined {
  if (status !== 400 || typeof body !== 'object' || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const fields = error as {
    type?: unknown;
    message?: unknown;
    n_prompt_tokens?: unknown;
    n_ctx?: unknown;
  };
  const tokens = Number(fields.n_prompt_tokens);
  const context = Number(fields.n_ctx);
  if (fields.type === 'exceed_context_size_error' && tokens > 0 && context > 0)
    return { tokens, context };
  const message = typeof fields.message === 'string' ? fields.message : '';
  const text =
    /request \((\d+) tokens?\) exceeds the available context size \((\d+) tokens?\)/i.exec(message);
  if (text?.[1] && text[2]) return { tokens: Number(text[1]), context: Number(text[2]) };
  return undefined;
}

/**
 * Тело отказа в диалекте клиента. Anthropic: `{type:'error', error:{type, message}}` — его читает
 * Claude Code; OpenAI: `{error:{message, type, code}}` — `context_length_exceeded` узнают клиенты OpenAI.
 */
export function refusalBody(
  dialect: WindowDialect,
  type: string,
  message: string,
  code?: string,
): string {
  if (dialect === 'anthropic') return JSON.stringify({ type: 'error', error: { type, message } });
  return JSON.stringify({ error: { message, type, code: code ?? null } });
}

/**
 * Разговор, которому принадлежит запрос Claude Code: `metadata.user_id` несёт `session_id`
 * (claude 2.1.286: JSON-строка `{"device_id":…,"session_id":…}`; прежние версии —
 * `user_<хеш>_account__session_<uuid>`). Нет метки — нет и разговора.
 */
export function sessionOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const metadata = (body as { metadata?: unknown }).metadata;
  const raw =
    typeof metadata === 'object' && metadata !== null
      ? (metadata as { user_id?: unknown }).user_id
      : undefined;
  if (typeof raw !== 'string') return undefined;
  const json = /"session_id"\s*:\s*"([^"]+)"/.exec(raw);
  if (json?.[1]) return json[1];
  return /_session_([A-Za-z0-9-]+)/.exec(raw)?.[1];
}
