import type { FetchLike } from './download.ts';

/**
 * Разговор с НАШИМ `llama-server` по его HTTP API.
 *
 * Только то, что разделу нужно: жив ли и готов ли (`/health`), что за сборка и
 * какое окно (`/props`), точный счёт токенов (`/v1/messages/count_tokens`) и
 * замер скорости. Транспорт — подставляемый `fetch`: проверки гоняют весь путь
 * на заглушке сервера, а не на гигабайтах настоящих моделей.
 */

export type { FetchLike } from './download.ts';

/** `ok` — слушает и модель загружена; `loading` — слушает, модель ещё грузится (503). */
export type Health = 'ok' | 'loading';

export interface ServerProps {
  /** `b11583-9880…` — сборка и коммит. */
  buildInfo: string;
  /** Окно слота, токенов. */
  nCtx: number;
  /** Имя модели, как его просят запросы (`--alias`). */
  alias: string;
  /** Модель выгружена по простою (`--sleep-idle-seconds`): память свободна, первый запрос загрузит её заново. */
  sleeping: boolean;
}

/**
 * Слот за работой (`GET /slots`, сборка b11583): `filled` — сколько токенов промпта уже в кеше
 * слота (растёт на каждом пакете разбора), `decoded` — сколько токенов ответа выдано.
 */
export interface SlotState {
  processing: boolean;
  filled: number;
  decoded: number;
}

/**
 * Сколько ждать ответа на опрос слота. `/slots` проходит через очередь задач сервера и отвечается
 * между пакетами разбора: на видеокарте — сразу, на процессоре пакет идёт минуту. Не ответил —
 * присмотр считает это тишиной (`activity.ts`), а не пропускает шаг.
 */
export const SLOT_TIMEOUT_MS = 1_500;

export interface BenchResult {
  evalCount: number;
  evalDurationNs: number;
  promptCount: number;
  promptDurationNs: number;
}

/** Ответ сервера с ошибкой — с его же текстом, иначе человеку нечего прочесть. */
export class LlamaError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function failure(response: Response): Promise<LlamaError> {
  let text = '';
  try {
    const body = (await response.json()) as { error?: { message?: string } | string };
    text = typeof body.error === 'string' ? body.error : (body.error?.message ?? '');
  } catch {
    // Тело не JSON — остаётся статус ответа.
  }
  return new LlamaError(text || `HTTP ${response.status}`, response.status);
}

/**
 * Промпт замера — один и тот же каждый раз: скорость разных моделей и разных
 * машин сравнима, только если они отвечали на одно.
 */
export const BENCH_PROMPT =
  'Write a TypeScript function that merges two sorted arrays into one sorted array. Return only the code.';

/** Сколько ждать сброса кеша слота. */
export const ERASE_TIMEOUT_MS = 3_000;

export interface LlamaClient {
  health(): Promise<Health | undefined>;
  props(): Promise<ServerProps>;
  countTokens(body: unknown): Promise<number>;
  /** Сбросить кеш слота (`POST /slots/N?action=erase`); сколько токенов стёрто. Спящий сервер этим будят — звать только бодрствующий. */
  eraseSlot(slot?: number): Promise<number>;
  /** Что делает слот. Спящий сервер этим будят — звать, только пока запрос в пути. */
  slot(id?: number): Promise<SlotState | undefined>;
  /**
   * Кеш слота — в файл каталога `--slot-save-path` (`POST /slots/0?action=save`); сколько
   * токенов записано. Спящий сервер этим будят.
   */
  saveSlot(filename: string, timeoutMs: number): Promise<number>;
  /** Кеш слота — из файла (`action=restore`); сколько токенов восстановлено. Будит спящий. */
  restoreSlot(filename: string, timeoutMs: number): Promise<number>;
  bench(model: string, signal?: AbortSignal): Promise<BenchResult>;
}

export function llamaClient(baseUrl: string, fetchImpl: FetchLike = fetch): LlamaClient {
  const get = async (path: string, init?: RequestInit): Promise<Response> => {
    const response = await fetchImpl(`${baseUrl}${path}`, init);
    if (!response.ok) throw await failure(response);
    return response;
  };
  return {
    async health() {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        try {
          const response = await fetchImpl(`${baseUrl}/health`, { signal: controller.signal });
          if (response.ok) return 'ok';
          return response.status === 503 ? 'loading' : undefined;
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return undefined;
      }
    },

    async props() {
      const body = (await (await get('/props')).json()) as {
        build_info?: string;
        model_alias?: string;
        is_sleeping?: boolean;
        default_generation_settings?: { n_ctx?: number };
      };
      return {
        buildInfo: body.build_info ?? '',
        nCtx: body.default_generation_settings?.n_ctx ?? 0,
        alias: body.model_alias ?? '',
        sleeping: body.is_sleeping === true,
      };
    },

    async eraseSlot(slot = 0) {
      // Не дольше трёх секунд: запрос человека ждёт этого сброса и из-за зависшего сервера стоять не должен.
      const response = await get(`/slots/${slot}?action=erase`, {
        method: 'POST',
        signal: AbortSignal.timeout(ERASE_TIMEOUT_MS),
      });
      return ((await response.json()) as { n_erased?: number }).n_erased ?? 0;
    },

    async saveSlot(filename, timeoutMs) {
      const response = await get('/slots/0?action=save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return ((await response.json()) as { n_saved?: number }).n_saved ?? 0;
    },

    async restoreSlot(filename, timeoutMs) {
      const response = await get('/slots/0?action=restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return ((await response.json()) as { n_restored?: number }).n_restored ?? 0;
    },

    async slot(id = 0) {
      const response = await fetchImpl(`${baseUrl}/slots`, {
        signal: AbortSignal.timeout(SLOT_TIMEOUT_MS),
      });
      if (!response.ok) return undefined;
      const slots = (await response.json()) as {
        id?: number;
        is_processing?: boolean;
        n_prompt_tokens?: number;
        next_token?: { n_decoded?: number }[];
      }[];
      const slot = Array.isArray(slots) ? slots.find((item) => item.id === id) : undefined;
      if (!slot) return undefined;
      return {
        processing: slot.is_processing === true,
        filled: slot.n_prompt_tokens ?? 0,
        decoded: slot.next_token?.[0]?.n_decoded ?? 0,
      };
    },

    async countTokens(body) {
      const response = await get('/v1/messages/count_tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return ((await response.json()) as { input_tokens?: number }).input_tokens ?? 0;
    },

    async bench(model, signal) {
      // Без размышлений: замер скорости, а не качества ответа, и «думающая» модель
      // тратила бы лимит токенов на рассуждение вместо кода.
      const response = await get('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: BENCH_PROMPT }],
          max_tokens: 256,
          temperature: 0,
          chat_template_kwargs: { enable_thinking: false },
        }),
        ...(signal ? { signal } : {}),
      });
      const body = (await response.json()) as {
        timings?: {
          prompt_n?: number;
          prompt_ms?: number;
          predicted_n?: number;
          predicted_ms?: number;
        };
      };
      const timings = body.timings ?? {};
      return {
        evalCount: timings.predicted_n ?? 0,
        evalDurationNs: Math.round((timings.predicted_ms ?? 0) * 1e6),
        promptCount: timings.prompt_n ?? 0,
        promptDurationNs: Math.round((timings.prompt_ms ?? 0) * 1e6),
      };
    },
  };
}
