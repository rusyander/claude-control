/**
 * Кэш входа в расходе ответа: сколько прочитано, сколько записано и сколько из
 * записанного — на час. Отдельно от моста диалектов, потому что читают его и
 * мост, и разбор потока (`frames.ts`), и цельный ответ конвейера.
 *
 * Откуда числа. Контур тело модели не переписывает, и OpenAI-совместимый
 * апстрим кладёт прочитанное в `prompt_tokens_details.cached_tokens`. LiteLLM
 * внутри платформы компании у моделей Anthropic отдаёт в ПОТОКЕ ещё и запись:
 * `cache_creation_input_tokens` верхним полем и
 * `prompt_tokens_details.{cache_write_tokens,cache_creation_token_details}` —
 * замер 22.10.2026 на haiku: `prompt_tokens` = свежий вход + прочитанное +
 * записанное. Без записи транскрипт CLI считал её свежим входом, а срок кэша
 * (час или пять минут) не знал никто — и поддержание кэша, и сторож групп
 * отказывались от сессии как от «срок неизвестен».
 */

/** Кэш входа одного ответа. */
export interface CacheTokens {
  /** Прочитано из кэша. */
  read: number;
  /** Записано в кэш этим вызовом. */
  write: number;
  /** Из записанного — со сроком в час. */
  write1h: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Кэш из расхода в форме OpenAI (с полями LiteLLM, когда они есть). */
export function cacheTokensOf(usage: unknown): CacheTokens {
  if (!isRecord(usage)) return { read: 0, write: 0, write1h: 0 };
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const split = isRecord(details.cache_creation_token_details)
    ? details.cache_creation_token_details
    : isRecord(usage.cache_creation)
      ? usage.cache_creation
      : {};
  const read = numberOf(details.cached_tokens) || numberOf(usage.cache_read_input_tokens);
  // Верхнее поле первым: его пишет сам вендор, а поля `prompt_tokens_details` —
  // пересказ LiteLLM. Совпадают они у всех замеров; расходятся — верим вендору.
  const write =
    numberOf(usage.cache_creation_input_tokens) ||
    numberOf(details.cache_write_tokens) ||
    numberOf(details.cache_creation_tokens);
  return { read, write, write1h: Math.min(write, numberOf(split.ephemeral_1h_input_tokens)) };
}

/** Сколько входа модель прочла из кэша — прежнее имя для тех, кому нужно одно число. */
export function cachedTokensOf(usage: unknown): number {
  return cacheTokensOf(usage).read;
}

function cacheOf(cache: number | CacheTokens): CacheTokens {
  return typeof cache === 'number' ? { read: cache, write: 0, write1h: 0 } : cache;
}

/**
 * Расход в форме Anthropic. Там `input_tokens` кэша НЕ включает — ни
 * прочитанного, ни записанного, — а у OpenAI `prompt_tokens` включает оба:
 * перенос одним числом записывал в транскрипт CLI весь вход свежим.
 *
 * Запись идёт двумя полями, как у самого Anthropic: числом и разбивкой по
 * сроку (`cache_creation`). Разбивку читают поддержание кэша и сторож групп —
 * по ней они узнают, часовой ли кэш у сессии.
 */
export function anthropicUsage(
  prompt: number,
  completion: number,
  cache: number | CacheTokens,
): Record<string, unknown> {
  const own = cacheOf(cache);
  const read = Math.min(own.read, prompt);
  const write = Math.min(own.write, prompt - read);
  const write1h = Math.min(own.write1h, write);
  return {
    input_tokens: prompt - read - write,
    ...(write > 0 ? { cache_creation_input_tokens: write } : {}),
    ...(read > 0 ? { cache_read_input_tokens: read } : {}),
    output_tokens: completion,
    ...(write > 0
      ? {
          cache_creation: {
            ephemeral_5m_input_tokens: write - write1h,
            ephemeral_1h_input_tokens: write1h,
          },
        }
      : {}),
  };
}

/**
 * Расход в форме OpenAI; кэш — только когда он был, как отдаёт сам OpenAI.
 * Запись — полями LiteLLM (`cache_write_tokens` + разбивка): в диалекте OpenAI
 * своего поля у неё нет, а цельный ответ клиенту Anthropic собирается именно из
 * этой формы, и без них запись терялась бы на пути «не поток».
 */
export function openAiUsage(
  prompt: number,
  completion: number,
  total: number,
  cache: number | CacheTokens,
): Record<string, unknown> {
  const own = cacheOf(cache);
  const details = {
    ...(own.read > 0 ? { cached_tokens: own.read } : {}),
    ...(own.write > 0
      ? {
          cache_write_tokens: own.write,
          cache_creation_token_details: {
            ephemeral_5m_input_tokens: own.write - own.write1h,
            ephemeral_1h_input_tokens: own.write1h,
          },
        }
      : {}),
  };
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    ...(Object.keys(details).length > 0 ? { prompt_tokens_details: details } : {}),
  };
}
