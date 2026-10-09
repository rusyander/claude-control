/**
 * Шина событий `opencode serve` (`GET /event?directory=…`, SSE) на время одного
 * сообщения: куски ответа, пока он идёт, и причина, если сессия упала.
 *
 * ЗАЧЕМ. `POST /session/:id/message` отвечает только целиком — без шины ответ в
 * чате появлялся одним куском в конце, сколько бы модель ни писала. А упавший ход
 * (модели нет, провайдер отказал) отдаёт 500 с `UnknownError` без подробностей;
 * настоящая причина («Model not found: …») приходит ТОЛЬКО событием
 * `session.error`.
 *
 * ЧТО ВЗЯТО ИЗ СПЕЦИФИКАЦИИ (`GET /doc` у 1.18.35, схемы `Event*`) и живой пробы
 * на том же CLI:
 *  - `message.part.updated` `{ part: { id, sessionID, messageID, type } }` — часть
 *    появилась; кусками идут только части `type: 'text'` (рассуждения —
 *    `reasoning`, их в ответ не берём, как и в итоговом теле);
 *  - `message.part.delta` `{ sessionID, partID, field: 'text', delta }` — кусок;
 *  - `session.error` `{ sessionID, error: { name, data: { message } } }`.
 *
 * Шина общая на каталог: чужие сессии отсеиваются по `sessionID`. Шина не
 * поднялась — ничего не ломается: ответ придёт целиком из тела, как раньше.
 */

export interface OpencodeEventWatchOptions {
  url: string;
  sessionId: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

export interface OpencodeEventWatch {
  /** Подписка состоялась (заголовки пришли) или не сложилась — ждать больше нечего. */
  ready: Promise<void>;
  /** Хоть один кусок ответа ушёл наружу. */
  streamed: () => boolean;
  /** Причина падения сессии; событие могло ещё не дойти — ждём не дольше `ms`. */
  failure: (ms: number) => Promise<string | undefined>;
  stop: () => void;
}

const ERROR_LIMIT = 500;

/** Текст ошибки сессии: `data.message`, иначе имя ошибки. */
function errorText(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const { name, data } = error as { name?: unknown; data?: unknown };
  const message =
    data && typeof data === 'object' ? (data as { message?: unknown }).message : undefined;
  const text = typeof message === 'string' && message.trim() ? message : name;
  return typeof text === 'string' && text.trim() ? text.trim().slice(0, ERROR_LIMIT) : undefined;
}

export function watchOpencodeEvents(options: OpencodeEventWatchOptions): OpencodeEventWatch {
  const { sessionId, onDelta } = options;
  const controller = new AbortController();
  const textParts = new Set<string>();
  let streamed = false;
  let failure: string | undefined;
  let failureSeen: (() => void) | undefined;

  const handle = (event: unknown): void => {
    if (!event || typeof event !== 'object') return;
    const { type, properties } = event as { type?: unknown; properties?: unknown };
    if (!properties || typeof properties !== 'object') return;
    const props = properties as Record<string, unknown>;

    if (type === 'message.part.updated') {
      const part = props.part as Record<string, unknown> | undefined;
      if (part?.sessionID === sessionId && part.type === 'text' && typeof part.id === 'string')
        textParts.add(part.id);
      return;
    }
    if (type === 'message.part.delta') {
      if (props.sessionID !== sessionId || props.field !== 'text') return;
      if (typeof props.partID !== 'string' || !textParts.has(props.partID)) return;
      if (typeof props.delta !== 'string' || !props.delta) return;
      streamed = true;
      onDelta?.(props.delta);
      return;
    }
    if (type === 'session.error' && props.sessionID === sessionId) {
      failure = errorText(props.error) ?? failure;
      failureSeen?.();
    }
  };

  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => (markReady = resolve));

  void (async () => {
    try {
      const res = await options.fetchImpl(options.url, {
        method: 'GET',
        signal: options.signal
          ? AbortSignal.any([controller.signal, options.signal])
          : controller.signal,
      });
      if (!res.ok || !res.body) return;
      markReady();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
        let cut: number;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const data = buffer
            .slice(0, cut)
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          buffer = buffer.slice(cut + 2);
          if (!data) continue;
          try {
            handle(JSON.parse(data));
          } catch {
            // Неразборный кадр пропускаем: шина от этого рваться не должна.
          }
        }
      }
    } catch {
      // Снята нами или сервер ушёл — ответ всё равно придёт телом.
    } finally {
      markReady();
    }
  })();

  return {
    ready,
    streamed: () => streamed,
    failure: async (ms) => {
      if (failure) return failure;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        failureSeen = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      return failure;
    },
    stop: () => controller.abort(),
  };
}
