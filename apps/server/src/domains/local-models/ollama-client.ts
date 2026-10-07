/**
 * Разговор с НАШИМ сервером Ollama по его HTTP API.
 *
 * Только то, что разделу нужно: версия, список моделей, загруженные в память,
 * скачивание с прогрессом, удаление, выгрузка и замер скорости. Транспорт —
 * подставляемый `fetch`: проверки гоняют весь путь на заглушке сервера, а не на
 * гигабайтах настоящих моделей.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface OllamaClient {
  version(): Promise<string>;
  tags(): Promise<{ name: string; size: number; modified_at: string }[]>;
  ps(): Promise<{ name: string; size_vram: number; expires_at: string }[]>;
  pull(tag: string, onProgress: (event: PullEvent) => void, signal?: AbortSignal): Promise<void>;
  remove(tag: string): Promise<void>;
  unload(tag: string): Promise<void>;
  bench(tag: string, signal?: AbortSignal): Promise<BenchResult>;
}

/** Строка потока `/api/pull`: этап, слой и сколько его уже пришло. */
export interface PullEvent {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

export interface BenchResult {
  evalCount: number;
  evalDurationNs: number;
  promptCount: number;
  promptDurationNs: number;
}

/** Ответ сервера с ошибкой — с его же текстом, иначе человеку нечего прочесть. */
export class OllamaError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function failure(response: Response): Promise<OllamaError> {
  let text = '';
  try {
    const body = (await response.json()) as { error?: string };
    text = body.error ?? '';
  } catch {
    // Тело не JSON — остаётся статус ответа.
  }
  return new OllamaError(text || `HTTP ${response.status}`, response.status);
}

/**
 * Промпт замера — один и тот же каждый раз: скорость разных моделей и разных
 * машин сравнима, только если они отвечали на одно.
 */
export const BENCH_PROMPT =
  'Write a TypeScript function that parses an ISO 8601 duration like "P3DT4H5M" into seconds, ' +
  'with input validation and three unit tests. Code only.';
export const BENCH_TOKENS = 256;

export function ollamaClient(baseUrl: string, fetchImpl: FetchLike = fetch): OllamaClient {
  const url = (path: string): string => `${baseUrl.replace(/\/$/, '')}${path}`;
  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetchImpl(url(path), init);
    if (!response.ok) throw await failure(response);
    return (await response.json()) as T;
  };
  const post = (body: unknown, signal?: AbortSignal): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  return {
    async version() {
      return (await json<{ version: string }>('/api/version')).version;
    },
    async tags() {
      return (
        (
          await json<{ models?: { name: string; size: number; modified_at: string }[] }>(
            '/api/tags',
          )
        ).models ?? []
      );
    },
    async ps() {
      return (
        (
          await json<{ models?: { name: string; size_vram: number; expires_at: string }[] }>(
            '/api/ps',
          )
        ).models ?? []
      );
    },
    async pull(tag, onProgress, signal) {
      const response = await fetchImpl(
        url('/api/pull'),
        post({ model: tag, stream: true }, signal),
      );
      if (!response.ok || !response.body) throw await failure(response);
      // Поток — строки JSON. Ошибка посреди потока приходит строкой `{error}`, а
      // не кодом ответа: заголовки к тому моменту давно ушли.
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) handleLine(line, onProgress);
          newline = buffer.indexOf('\n');
        }
      }
      if (buffer.trim()) handleLine(buffer.trim(), onProgress);
    },
    async remove(tag) {
      const response = await fetchImpl(url('/api/delete'), {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: tag }),
      });
      if (!response.ok) throw await failure(response);
    },
    async unload(tag) {
      // `keep_alive: 0` без промпта — документированный способ выгрузить модель
      // из памяти видеокарты, не останавливая сервер.
      await json('/api/generate', post({ model: tag, keep_alive: 0 }));
    },
    async bench(tag, signal) {
      const body = await json<{
        eval_count?: number;
        eval_duration?: number;
        prompt_eval_count?: number;
        prompt_eval_duration?: number;
      }>(
        '/api/generate',
        post(
          {
            model: tag,
            prompt: BENCH_PROMPT,
            stream: false,
            think: false,
            options: { num_predict: BENCH_TOKENS, temperature: 0 },
          },
          signal,
        ),
      );
      return {
        evalCount: body.eval_count ?? 0,
        evalDurationNs: body.eval_duration ?? 0,
        promptCount: body.prompt_eval_count ?? 0,
        promptDurationNs: body.prompt_eval_duration ?? 0,
      };
    },
  };
}

function handleLine(line: string, onProgress: (event: PullEvent) => void): void {
  let event: PullEvent & { error?: string };
  try {
    event = JSON.parse(line) as PullEvent & { error?: string };
  } catch {
    return;
  }
  if (event.error) throw new OllamaError(event.error, 500);
  onProgress(event);
}
