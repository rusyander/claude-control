import { LOCAL_REPLY_RESERVE_TOKENS } from '@agentdeck/contracts/local-models';
import { nativeErrorFrame } from '../anthropic-native.ts';
import type { TextLanguage } from '../../../../lib/server-texts/server-texts.ts';

/**
 * Окно локальной модели на пути шлюза: отказ «prompt is too long» вместо тихой
 * обрезки и срок ожидания первого байта под обработку длинного промпта.
 *
 * Почему это нужно шлюзу, а не одной настройке окна у Claude Code. Ollama, когда
 * запрос не лезет в окно сервера, не отказывает: обрезает начало промпта (вместе
 * с системным) либо останавливает ответ по «length», а Claude Code читает это как
 * «ответ превысил 32000 токенов» (живой разбор 13.10: входы 134–173 тысячи токенов
 * при окне 131072, `truncated = 1` в журнале сервера). Сжатие истории по окну
 * (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`) срабатывает по ЕГО счёту токенов, а он
 * для чужой модели приблизителен, — шлюз ловит то, что просочилось.
 *
 * Текст отказа — не наш, а тот, по которому Claude Code узнаёт переполнение
 * (бинарь 2.1.286: статус 400 и «prompt is too long» в сообщении, числа берутся
 * регуляркой `N tokens > M`): по нему он сжимает историю и повторяет запрос сам.
 * Поэтому английский и без перевода — перевод сломал бы узнавание.
 */

/** Окно и скорость обработки промпта у локального собеседника шлюза. */
export interface LocalUpstreamInfo {
  /** Окно сервера моделей, токенов: настоящее, из записи о запущенном сервере. */
  context: number;
  /** Замеренная скорость обработки промпта, ток/с; нет замера — берётся осторожная. */
  promptTokensPerSecond?: number;
  /**
   * Что сделать перед передачей запроса серверу моделей. Получает разговор,
   * которому запрос принадлежит (`sessionOf`): панель сбрасывает кеш слота, когда
   * разговор сменился, чтобы чужой префикс не достался новому чату. Сбой — не повод
   * отказывать запросу: вызов обязан не бросать.
   */
  prepare?: (session: string | undefined) => Promise<void>;
  /**
   * Сервер не принял соединение: просит панель поднять его заново (присмотр за сервером).
   * `restarted` и `alive` — можно повторить запрос сразу; остальное — сервер недоступен
   * сейчас (`busy` — панель сама его перезапускает, `capped`/`failed` — подъём не удался).
   */
  revive?: () => Promise<'restarted' | 'failed' | 'capped' | 'busy' | 'none' | 'alive'>;
  /** Сообщение присмотра, когда сервер не поднялся: уходит текстом ошибки. */
  notice?: () => string | undefined;
  /**
   * Присмотр за запросом в пути (L6): панель опрашивает сервер и, если ничего не
   * двигается, обрывает запрос сигналом — причина в `signal.reason`. `done` — запрос
   * кончился любым путём; `failed` / `succeeded` — чем ответил сервер (чат показывает отказ).
   */
  watch?: (promptTokens: number) => {
    signal: AbortSignal;
    failed?(status: number, message: string): void;
    succeeded?(): void;
    done(): void;
  };
  /**
   * Сколько токенов запроса — слой (системный промпт и описания инструментов): панель
   * сравнивает его с окном сервера и показывает человеку, когда он не влезает (L6). Зовётся
   * только для запросов с инструментами — служебные (заголовок чата) слоя не несут.
   */
  layer?: (tokens: number) => void;
  /**
   * Шаблон чата идущего сервера знает пометку отложенного инструмента (`DEFERRED_TOOL_MARK`):
   * подгруженный через `ToolSearch` инструмент не печатается в шапке, и начало промпта не
   * сдвигается. Нет — инструмент идёт в шапку как есть (L7, `deferred-tools.ts`).
   */
  deferredInline?: boolean;
}

/**
 * Доля слоя в запросе, переведённая в токены: символы системного промпта и описаний
 * инструментов против символов всего тела, умноженные на счёт токенов запроса. Слой у
 * Anthropic — `system` и `tools`, у OpenAI-совместимых — сообщения `system` и `tools`. Без
 * инструментов — `undefined`: такой запрос (заголовок чата, сжатие) слоя прогона не несёт.
 */
export function layerTokensOf(
  body: unknown,
  bodyChars: number,
  promptTokens: number,
): number | undefined {
  if (typeof body !== 'object' || body === null || bodyChars <= 0 || promptTokens <= 0)
    return undefined;
  const record = body as { system?: unknown; tools?: unknown; messages?: unknown };
  if (!Array.isArray(record.tools) || record.tools.length === 0) return undefined;
  const systemMessages = Array.isArray(record.messages)
    ? record.messages.filter(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          (message as { role?: unknown }).role === 'system',
      )
    : [];
  const chars =
    JSON.stringify(record.tools).length +
    (record.system === undefined ? 0 : JSON.stringify(record.system).length) +
    (systemMessages.length > 0 ? JSON.stringify(systemMessages).length : 0);
  return Math.round((promptTokens * Math.min(chars, bodyChars)) / bodyChars);
}

/** Текст обрыва по тишине: причина сигнала присмотра или пусто, если сигнал не сработал. */
export function stallReasonOf(signal: AbortSignal | undefined): string | undefined {
  if (!signal?.aborted) return undefined;
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Разговор, которому принадлежит запрос Claude Code: `metadata.user_id` несёт
 * `session_id` (замер 14.10, claude 2.1.286: JSON-строка
 * `{"device_id":…,"account_uuid":…,"session_id":…}`; в прежних версиях —
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
  const legacy = /_session_([A-Za-z0-9-]+)/.exec(raw);
  return legacy?.[1];
}

// Запас под ответ — общий со страницей локальных моделей: она по нему считает, влезает ли слой.
export { LOCAL_REPLY_RESERVE_TOKENS };

/** Меньше этого ждать первый байт у локальной модели нельзя: холодная загрузка и полный промпт. */
export const LOCAL_FIRST_TOKEN_FLOOR_MS = 300_000;

/** Скорость обработки промпта, когда замера нет: заведомо ниже видеокарты, выше процессора. */
const FALLBACK_PROMPT_TPS = 150;

/** Запас сверх расчётного времени: обрабатывающий промпт сервер делит GPU с остальным. */
const FIRST_TOKEN_SLACK = 1.5;

/** Символов на токен, пока ответов этой модели не видели: ниже, чем у кода и английского. */
const DEFAULT_CHARS_PER_TOKEN = 3;
const MIN_CHARS_PER_TOKEN = 1.5;
const MAX_CHARS_PER_TOKEN = 6;

/**
 * Отказ в виде, который Claude Code узнаёт. `tokens` — сколько у запроса, `limit` —
 * сколько отведено ему (окно за вычетом запаса под ответ): их разность он режет.
 */
export function promptTooLongMessage(tokens: number, limit: number): string {
  return `prompt is too long: ${Math.round(tokens)} tokens > ${Math.round(limit)} maximum`;
}

/**
 * Доля окна, выше которой оценке токенов не верят: плотный вывод (код, JSON, base64)
 * даёт 3 символа на токен и меньше, и промах оценки на 30 тысяч токенов — это
 * переполнение, после которого ход умирал. Выше этой доли шлюз спрашивает у сервера
 * точный счёт (замер: ~36 мс).
 */
export const LOCAL_PRECOUNT_SHARE = 0.75;

/** Нужен ли точный счёт вместо оценки. */
export function needsPrecount(estimate: number, context: number): boolean {
  return estimate + LOCAL_REPLY_RESERVE_TOKENS > context * LOCAL_PRECOUNT_SHARE;
}

/**
 * Отказ llama-server «запрос не влезает в окно» → числа. Его тело
 * (`type: exceed_context_size_error`, `n_prompt_tokens`, `n_ctx`; текст «request (N tokens)
 * exceeds the available context size (M tokens)») Claude Code не узнаёт, и 400 убивал ход.
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
  if (fields.type === 'exceed_context_size_error' && tokens > 0 && context > 0) {
    return { tokens, context };
  }
  const message = typeof fields.message === 'string' ? fields.message : '';
  const text =
    /request \((\d+) tokens?\) exceeds the available context size \((\d+) tokens?\)/i.exec(message);
  if (text?.[1] && text[2]) return { tokens: Number(text[1]), context: Number(text[2]) };
  return undefined;
}

/**
 * Вход влезает, а вход плюс `max_tokens` — нет: отказ в тексте, который Claude Code
 * разбирает сам (бинарь 2.1.286: «input length and `max_tokens` exceed context limit:
 * X + Y > Z»; он ставит `max_tokens = Z − X − 1000`, не меньше 3000, и повторяет). Без
 * него ответ шёл бы до предела окна минуты и резался фильтром. Условие
 * `вход + запас ≤ окно` — гарантия, что после поправки останется не меньше 3000 токенов.
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
  const input = Math.round(promptTokens);
  return `input length and \`max_tokens\` exceed context limit: ${input} + ${reply} > ${context}`;
}

/** Сколько токенов отведено промпту при этом окне. */
export function promptLimitOf(context: number): number {
  return Math.max(0, context - LOCAL_REPLY_RESERVE_TOKENS);
}

/**
 * Срок ожидания первого байта: расчётное время обработки промпта с запасом, но
 * не меньше пяти минут. Фиксированные 60 с (потолок для облачного контура)
 * обрывали законный разбор: 130 тысяч токенов при 360 ток/с — шесть минут.
 */
export function firstTokenTimeoutMs(promptTokens: number, info: LocalUpstreamInfo): number {
  const speed =
    info.promptTokensPerSecond && info.promptTokensPerSecond > 0
      ? info.promptTokensPerSecond
      : FALLBACK_PROMPT_TPS;
  const processing = (promptTokens / speed) * 1_000 * FIRST_TOKEN_SLACK;
  return Math.max(LOCAL_FIRST_TOKEN_FLOOR_MS, Math.ceil(processing));
}

/**
 * Счёт токенов запроса без токенайзера модели: символы тела, поделённые на
 * «символов на токен», который шлюз выучивает по настоящим ответам (`learn`).
 * Приблизительный — зато без похода на сервер: у Ollama ручки счёта токенов нет,
 * а лишний круг по сети на каждый запрос дороже погрешности.
 */
export class PromptCounter {
  readonly #ratio = new Map<string, number>();

  #key(platformId: string, model: string): string {
    return `${platformId}\u0000${model}`;
  }

  estimate(platformId: string, model: string, bodyChars: number): number {
    const ratio = this.#ratio.get(this.#key(platformId, model)) ?? DEFAULT_CHARS_PER_TOKEN;
    return Math.ceil(bodyChars / ratio);
  }

  /** Настоящий ответ сервера: сколько токенов он насчитал в теле такого размера. */
  learn(platformId: string, model: string, bodyChars: number, promptTokens: number): void {
    if (bodyChars <= 0 || promptTokens <= 0) return;
    const ratio = Math.min(
      MAX_CHARS_PER_TOKEN,
      Math.max(MIN_CHARS_PER_TOKEN, bodyChars / promptTokens),
    );
    this.#ratio.set(this.#key(platformId, model), ratio);
  }
}

/**
 * Ответ, оборвавшийся на пределе окна, заменяется отказом переполнения.
 *
 * Ollama при нехватке окна заканчивает ответ `stop_reason: max_tokens`, а Claude
 * Code по нему говорит «превышен предел выходных токенов» и сжимать историю не
 * начинает. Признак переполнения — вход плюс выход вплотную к окну: настоящий
 * `max_tokens` на маленьком ответе до него не дотягивает. Работает по целым
 * кадрам потока и пропускает остальные как есть.
 */
export class ContextCutFilter {
  #buffer = '';
  #input = 0;
  #output = 0;
  #cut = false;
  #cutAt = 0;
  readonly #context: number;
  readonly #language: TextLanguage;

  constructor(context: number, language: TextLanguage) {
    this.#context = context;
    this.#language = language;
  }

  /** Поток подменён отказом — сколько токенов насчитано к этому моменту; 0 — не подменялся. */
  get cutAt(): number {
    return this.#cutAt;
  }

  push(chunk: string): string {
    this.#buffer += chunk;
    const parts = this.#buffer.split(/\r?\n\r?\n/);
    this.#buffer = parts.pop() ?? '';
    return parts.map((frame) => this.#frame(frame)).join('');
  }

  /** Недосказанный хвост — как есть: резать нечего, кадра не вышло. */
  end(): string {
    const rest = this.#buffer;
    this.#buffer = '';
    return this.#cut ? '' : rest;
  }

  #frame(raw: string): string {
    if (this.#cut) return '';
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    const original = `${raw}\n\n`;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return original;
    }
    if (!payload || typeof payload !== 'object') return original;
    const frame = payload as {
      type?: unknown;
      message?: { usage?: Record<string, unknown> };
      usage?: Record<string, unknown>;
      delta?: { stop_reason?: unknown };
    };
    if (frame.type === 'message_start') {
      this.#input = tokensOf(frame.message?.usage);
      return original;
    }
    if (frame.type !== 'message_delta') return original;
    const input = tokensOf(frame.usage);
    if (input > 0) this.#input = input;
    const output = Number(frame.usage?.output_tokens ?? 0);
    if (Number.isFinite(output) && output > 0) this.#output = output;
    if (frame.delta?.stop_reason !== 'max_tokens') return original;
    // Вплотную к окну: сервер останавливается на `окно - 1`, остальное — запас на счёт.
    const used = this.#input + this.#output;
    if (used < this.#context - Math.max(128, Math.floor(this.#context * 0.01))) return original;
    this.#cut = true;
    this.#cutAt = used;
    return nativeErrorFrame(
      promptTooLongMessage(used, promptLimitOf(this.#context)),
      'invalid_request_error',
      this.#language,
    );
  }
}

/** Вход запроса: `input_tokens` и оба кеша — столько токенов сервер насчитал в промпте. */
function tokensOf(usage: Record<string, unknown> | undefined): number {
  if (!usage) return 0;
  const fields = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
  let sum = 0;
  for (const field of fields) {
    const value = Number(usage[field] ?? 0);
    if (Number.isFinite(value) && value > 0) sum += value;
  }
  return sum;
}
