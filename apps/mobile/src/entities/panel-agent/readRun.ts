import { SILENT, STREAM_LOST } from './run.constants';
import type { RunEventSink, PanelAgentRunOutcome } from './run.types';
import type { ServerMessageNestedParams } from '@agentdeck/contracts/server-messages';
import { serverMessage } from '../../shared/api/server-message';
import { splitSeqFrames } from './run';

/** Кусок потока — или `SILENT`, если он не пришёл за `ms`. */
export function within<T>(read: Promise<T>, ms: number): Promise<T | typeof SILENT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(SILENT), ms);
    read.then(
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

/**
 * Следующий кусок потока с порогом тишины, переживающий сон приложения.
 *
 * В фоне JS стоит, а кадры копятся в сокете; при возврате просроченный таймер
 * срабатывал раньше, чем читались накопленные кадры, и живой ход обрывался —
 * сервер видел закрытие и останавливал агента. Таймер, сработавший вдвое позже
 * срока, значит «спали», а не «молчали»: окно тишины начинается заново, и чтение
 * при этом то же самое — второе `read()` забрало бы кусок у первого.
 */
export function readWithin<T>(
  reader: ReadableStreamDefaultReader<T>,
  ms: number,
): Promise<ReadableStreamReadResult<T> | typeof SILENT> {
  const read = reader.read();
  const wait = async (): Promise<ReadableStreamReadResult<T> | typeof SILENT> => {
    const started = Date.now();
    const chunk = await within(read, ms);
    if (chunk === SILENT && Date.now() - started >= 2 * ms) return wait();
    return chunk;
  };
  return wait();
}

/** Ответ сервера с потоком хода → исход: отказ, обрыв, ошибка или конец. */
export async function readRun(
  response: Response,
  onEvent: RunEventSink,
  signal: AbortSignal,
  silenceMs: number,
): Promise<PanelAgentRunOutcome> {
  if (!response.ok) {
    let code: string | undefined;
    let message = '';
    let localized = '';
    try {
      const refusal = (await response.json()) as {
        error?: string;
        message?: string;
        messageCode?: unknown;
        params?: ServerMessageNestedParams;
      };
      code = refusal.error;
      localized = serverMessage(refusal.messageCode, refusal.params) ?? '';
      message = localized || refusal.message || '';
    } catch {
      // Тело не JSON — остаётся статус.
    }
    return {
      ok: false,
      code,
      status: response.status,
      message,
      ...(localized ? { localized: true } : {}),
    };
  }
  if (!response.body) return { ok: false, message: '' };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let failure: string | undefined;
  let finished = false;
  try {
    for (;;) {
      const chunk = await readWithin(reader, silenceMs);
      if (chunk === SILENT) {
        // Обрываем сами: сервер без возврата увидит закрытие и остановит ход,
        // сервер с возвратом подождёт, пока телефон придёт за кадрами.
        void reader.cancel().catch(() => undefined);
        return { ok: false, code: STREAM_LOST, message: '' };
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const { frames, rest } = splitSeqFrames(buffer);
      buffer = rest;
      for (const { event, seq } of frames) {
        if (event.kind === 'error') failure = event.message;
        if (event.kind === 'done' || event.kind === 'error') finished = true;
        onEvent(event, seq);
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
  if (!finished) return { ok: false, code: STREAM_LOST, message: '' };
  return { ok: true };
}
