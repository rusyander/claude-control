import { fetch as streamingFetch } from 'expo/fetch';
import type { PanelAgentRunEvent, PanelAgentRunRequest } from '@agentdeck/contracts/panel-agent';
import type { ServerMessageNestedParams } from '@agentdeck/contracts/server-messages';
import { apiUrl, authHeaders } from '../../shared/api/client';
import { serverMessage } from '../../shared/api/server-message';

export type PanelAgentRunOutcome =
  | { ok: true }
  | {
      ok: false;
      code?: string;
      status?: number;
      message: string;
      aborted?: boolean;
      /** Сервер прислал код текста (`messageCode`): `message` уже на языке телефона. */
      localized?: boolean;
    };

/**
 * Сколько поток хода может молчать — как у окна на компьютере. Сервер шлёт
 * `: ping` каждые 10 с, так что тишина втрое дольше — не раздумья модели, а
 * пропавшая связь (панель перезапустилась, соединение повисло без кадров).
 * Без этого телефон стоял в «Агент думает…», пока экран не открыть заново.
 */
export const STREAM_SILENCE_MS = 30_000;

/**
 * Код исхода «связь пропала посреди хода»: поток замолчал, закрылся без
 * итогового кадра или порвался. Ход на сервере запечатан (или ещё идёт) —
 * экран перечитывает разговор с сервера, а не додумывает ленту.
 */
export const STREAM_LOST = 'stream_lost';

const SILENT = Symbol('silent');

/** Кусок потока — или `SILENT`, если он не пришёл за `ms`. */
function within<T>(read: Promise<T>, ms: number): Promise<T | typeof SILENT> {
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
function readWithin<T>(
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

/** Кадр хода; `seq` — номер кадра, если сервер ведёт ход с возвратом (`detach`). */
export interface SeqFrame {
  seq?: number;
  event: PanelAgentRunEvent;
}

/**
 * Разрезать буфер SSE на кадры с номерами. Разбор `data:` — как у общего
 * `splitRunFrames`, плюс строка `id:`: по ней телефон возвращается к ходу после
 * обрыва. Сервер без возврата номеров не шлёт — кадры приходят без `seq`.
 */
export function splitSeqFrames(buffer: string): { frames: SeqFrame[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const frames: SeqFrame[] = [];
  for (const part of parts) {
    const lines = part.split('\n');
    const data = lines.find((line) => line.startsWith('data:'));
    if (!data) continue;
    const id = lines.find((line) => line.startsWith('id:'));
    const seq = id ? Number(id.slice(3).trim()) : NaN;
    try {
      frames.push({
        event: JSON.parse(data.slice(5)) as PanelAgentRunEvent,
        ...(Number.isFinite(seq) ? { seq } : {}),
      });
    } catch {
      // неразборный кадр — пропускаем
    }
  }
  return { frames, rest };
}

/** Получатель кадров хода: событие и его номер, если сервер его дал. */
export type RunEventSink = (event: PanelAgentRunEvent, seq?: number) => void;

/** Ответ сервера с потоком хода → исход: отказ, обрыв, ошибка или конец. */
async function readRun(
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

async function open(
  path: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<{ response: Response } | PanelAgentRunOutcome> {
  try {
    // Ответ `expo/fetch` — не глобальный Response: отличаем обёрткой, а не instanceof.
    const response = (await streamingFetch(apiUrl(path), {
      ...init,
      signal,
    } as unknown as Parameters<typeof streamingFetch>[1])) as unknown as Response;
    return { response };
  } catch (error) {
    if (signal.aborted) return { ok: false, message: 'aborted', aborted: true };
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Один ход агента панели: `POST /api/agent/run`, как у окна на компьютере.
 * Штатный `fetch` React Native тело потоком не читает — отсюда `expo/fetch`.
 *
 * Ход просит `detach`: Android 15+ режет сеть фоновому приложению через
 * секунды, и ход, живущий пока открыт запрос, умирал с уходом в фон (F-101,
 * D3). Сервер с возвратом обрыв переживает и нумерует кадры — телефон потом
 * догоняет ход `attachPanelAgent`. Сервер без возврата флаг не знает: для него
 * это прежний ход, обрыв его снимает, и экран перечитывает разговор из файла.
 */
export async function runPanelAgent(
  body: PanelAgentRunRequest,
  onEvent: RunEventSink,
  signal: AbortSignal,
  silenceMs: number = STREAM_SILENCE_MS,
): Promise<PanelAgentRunOutcome> {
  const opened = await open(
    '/agent/run',
    {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, detach: true }),
    },
    signal,
  );
  if (!('response' in opened)) return opened;
  return readRun(opened.response, onEvent, signal, silenceMs);
}

/**
 * Вернуться к ходу после обрыва: кадры после `fromSeq`, дальше вживую.
 * `not_running` (404) — хода на сервере нет: кончился давно, снят обрывом или
 * сервер возврата не умеет; `gone` (410) — начало уже вытеснено. В обоих
 * случаях правда — в файле разговора.
 */
export async function attachPanelAgent(
  conversationId: string,
  fromSeq: number,
  onEvent: RunEventSink,
  signal: AbortSignal,
  silenceMs: number = STREAM_SILENCE_MS,
): Promise<PanelAgentRunOutcome> {
  const opened = await open(
    `/agent/run/${encodeURIComponent(conversationId)}/stream?fromSeq=${fromSeq}`,
    { method: 'GET', headers: authHeaders() },
    signal,
  );
  // Сеть не ответила (телефон ещё просыпается) — тот же обрыв: попробуем снова.
  if (!('response' in opened))
    return opened.ok || opened.aborted ? opened : { ...opened, code: STREAM_LOST };
  const outcome = await readRun(opened.response, onEvent, signal, silenceMs);
  if (!outcome.ok && outcome.status === 404 && !outcome.code) {
    // Сервер без маршрута возврата отвечает своим 404 без кода.
    return { ...outcome, code: 'not_running' };
  }
  return outcome;
}

/**
 * «Стоп» хода с возвратом: обрыв запроса его больше не снимает. Сервер без
 * возврата маршрута не знает (404) — ему хватает оборванного запроса.
 */
export async function stopPanelAgent(conversationId: string): Promise<void> {
  try {
    await streamingFetch(apiUrl(`/agent/run/${encodeURIComponent(conversationId)}/stop`), {
      method: 'POST',
      headers: authHeaders(),
    });
  } catch {
    // Связи нет — сервер снимет отцепленный ход сам по сроку.
  }
}

/** Сколько раз телефон пробует вернуться к ходу после обрыва и с какой паузой. */
export const REATTACH = { attempts: 5, waitMs: 2_000 } as const;

/** Обрыв связи, а не отказ, не ошибка агента и не «Стоп». */
function lostTurn(outcome: PanelAgentRunOutcome): boolean {
  return !outcome.ok && !outcome.aborted && outcome.code === STREAM_LOST;
}

/**
 * Ход, который переживает обрыв (F-101, D3): `runPanelAgent`, а после обрыва —
 * возврат к ходу по номеру последнего кадра, несколько попыток с паузой (телефон
 * мог только что проснуться, и сеть поднимается не сразу). Кадры без номеров —
 * сервер без возврата, он ход уже снял: исход остаётся обрывом, экран
 * перечитывает разговор, как прежде. 404/410 на возврате — хода больше нет,
 * тоже обрыв и перечитка.
 */
export async function runResumablePanelAgent(
  body: PanelAgentRunRequest,
  onEvent: RunEventSink,
  signal: AbortSignal,
  options: {
    attempts?: number;
    waitMs?: number;
    silenceMs?: number;
    /**
     * Дождаться, пока приложение снова на экране. В фоне сеть закрыта (Android
     * 15+), и попытки, сделанные там, сгорали за секунды — ход не догонялся
     * никогда (прогон d3, 28.09). Без него — сразу.
     */
    ready?: () => Promise<void>;
  } = {},
): Promise<PanelAgentRunOutcome> {
  const attempts = options.attempts ?? REATTACH.attempts;
  const waitMs = options.waitMs ?? REATTACH.waitMs;
  const silenceMs = options.silenceMs ?? STREAM_SILENCE_MS;
  let conversationId = body.conversationId;
  let lastSeq = 0;
  const sink: RunEventSink = (event, seq) => {
    if (event.kind === 'start') conversationId = event.conversationId;
    if (seq !== undefined) lastSeq = seq;
    onEvent(event, seq);
  };

  let outcome = await runPanelAgent(body, sink, signal, silenceMs);
  for (let attempt = 0; attempt < attempts && lostTurn(outcome); attempt += 1) {
    if (!conversationId || lastSeq === 0) break;
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    await options.ready?.();
    if (signal.aborted) return { ok: false, message: 'aborted', aborted: true };
    const resumed = await attachPanelAgent(conversationId, lastSeq, sink, signal, silenceMs);
    if (!resumed.ok && (resumed.code === 'not_running' || resumed.code === 'gone')) break;
    outcome = resumed;
  }
  return outcome;
}
