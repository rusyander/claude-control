import type { PanelAgentRunEvent, PanelAgentRunRequest } from '@agentdeck/contracts/panel-agent';
import { splitRunFrames } from '@agentdeck/contracts/panel-agent-feed';
import { apiClient } from '@shared/api/client';
import { serverMessageFromPayload } from '@shared/config/i18n';

export type PanelAgentRunOutcome =
  { ok: true } | { ok: false; code?: string; message: string; aborted?: boolean };

/**
 * Сколько поток хода может молчать. Сервер шлёт `: ping` каждые 10 с, так что
 * тишина втрое дольше — не раздумья модели, а пропавшая связь: панель
 * перезапустилась за прокси Vite, и соединение осталось висеть без кадров.
 * Окно без этого стояло в «Агент думает…» до F5.
 */
export const STREAM_SILENCE_MS = 30_000;

/**
 * Код исхода «связь пропала посреди хода»: поток замолчал, закрылся без
 * итогового кадра или порвался. Ход на сервере запечатан (или ещё идёт) —
 * окно перечитывает разговор с сервера, а не додумывает ленту.
 */
export const STREAM_LOST = 'stream_lost';

const SILENT = Symbol('silent');

/** Следующий кусок потока — или `SILENT`, если он не пришёл за `ms`. */
function readWithin<T>(
  reader: ReadableStreamDefaultReader<T>,
  ms: number,
): Promise<ReadableStreamReadResult<T> | typeof SILENT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(SILENT), ms);
    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

// Разбор кадров общий с телефоном — в контрактах.
export { splitRunFrames };

async function readRefusal(response: Response): Promise<{ code?: string; message: string }> {
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    return {
      code: body.error,
      message:
        serverMessageFromPayload(body) || body.message || `Сервер ответил ${response.status}`,
    };
  } catch {
    return { message: `Сервер ответил ${response.status}` };
  }
}

/**
 * Один ход агента панели: `POST /api/agent/run`. Отказ до запуска приходит
 * JSON с кодом, дальше — SSE-кадры. Обрыв запроса (`signal`) останавливает
 * агента на сервере: ждущая карточка при этом снимается сама.
 */
export async function runPanelAgent(
  body: PanelAgentRunRequest,
  onEvent: (event: PanelAgentRunEvent) => void,
  signal: AbortSignal,
  silenceMs: number = STREAM_SILENCE_MS,
): Promise<PanelAgentRunOutcome> {
  let response: Response;
  try {
    response = await fetch(`${apiClient.defaults.baseURL}/agent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) return { ok: false, message: 'aborted', aborted: true };
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) return { ok: false, ...(await readRefusal(response)) };
  if (!response.body) return { ok: false, message: 'Пустой ответ сервера' };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let failure: string | undefined;
  let finished = false;
  try {
    for (;;) {
      const chunk = await readWithin(reader, silenceMs);
      if (chunk === SILENT) {
        // Обрываем сами: сервер, если он ещё жив, увидит закрытие и остановит ход.
        void reader.cancel().catch(() => undefined);
        return { ok: false, code: STREAM_LOST, message: 'Поток хода замолчал' };
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const { events, rest } = splitRunFrames(buffer);
      buffer = rest;
      for (const event of events) {
        if (event.kind === 'error') failure = event.message;
        if (event.kind === 'done' || event.kind === 'error') finished = true;
        onEvent(event);
      }
    }
  } catch (error) {
    if (signal.aborted) return { ok: false, message: 'aborted', aborted: true };
    return {
      ok: false,
      code: STREAM_LOST,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (failure !== undefined) return { ok: false, message: failure };
  // Поток закрылся без итогового кадра — ход оборвался, молчать об этом нельзя.
  if (!finished) return { ok: false, code: STREAM_LOST, message: 'Поток оборвался без итога' };
  return { ok: true };
}
