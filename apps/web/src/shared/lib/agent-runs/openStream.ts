import { serverMessageFromPayload } from '@shared/config/i18n';
import { runs } from './agent-runs.state.constants';
import { setRun } from './setRun';
import { emit } from './emit';
import { markStalled } from './markStalled';
import { STREAM_STALL_MS, STREAM_CONNECT_MS } from './agent-runs.constants';
import { parseSseFrame } from './parseSseFrame';
import { lastSeqs } from './agent-runs.state';
import { applyEvent } from './agent-runs.events';
import type { ChatEvent, StartInput, SendOutcome } from './agent-runs.types';
import { CONNECT_TIMEOUT } from './agent-runs.stream.constants';
import { apiClient } from '@shared/api/client';
import { sendInit } from './agent-runs.stream';

/** Разобрать тело отказа сервера: код и текст, ничего не выковыривая из строки. */
export async function readRefusal(response: Response): Promise<{
  code?: string;
  message: string;
  files?: string[];
  runId?: string;
}> {
  try {
    const body = (await response.json()) as {
      code?: string;
      message?: string;
      files?: string[];
      runId?: string;
    };
    return {
      code: body.code,
      message:
        serverMessageFromPayload(body) || body.message || `Сервер ответил ${response.status}`,
      files: body.files,
      runId: body.runId,
    };
  } catch {
    // Не JSON (прокси, падение) — кода нет, показываем статус.
    return { message: `Сервер ответил ${response.status}` };
  }
}

/**
 * Связь восстановлена: поток открыт заново и сейчас догонит пропущенное с
 * последнего `seq`. Снимаем метку — пузырь снова наш, а история снова прячет
 * этот ход, чтобы он не показался дважды.
 */
export function markLive(id: string): void {
  if (!runs.get(id)?.stalled) return;
  setRun(id, { stalled: undefined, dropped: undefined });
  emit();
}

/**
 * Прочитать SSE-поток прогона в стор. Пинг-комментарии (`: ping`) пропускаем —
 * но не молча: сам факт их прихода означает, что сокет жив, и сбрасывает сторож
 * простоя. Возвращает, как поток завершился: `clean` — пришло терминальное
 * событие (done/error); `gone` — сервер сообщил, что прогона больше нет;
 * `dirty` — поток оборвался или замолчал без терминала (повод переподключиться).
 */
export async function pumpStream(
  id: string,
  response: Response,
  controller: AbortController,
): Promise<'clean' | 'dirty' | 'gone'> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawTerminal = false;

  // Сторож простоя. Отсчёт ведём от последнего БАЙТА, а не от последнего
  // события: между шагами агента событий нет минутами, а пульс идёт всегда.
  // Сработал — отменяем читателя, и ожидающее чтение завершается «концом
  // потока»: наверх это уходит как `dirty`, то есть обычный повод
  // переподключиться. Прогон при этом не трогаем — он живёт на сервере.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armStall = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      markStalled(id);
      void reader.cancel().catch(() => undefined);
    }, STREAM_STALL_MS);
  };

  try {
    for (;;) {
      armStall();
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        // Прерывание кнопкой — наверх; сетевой обрыв — переподключаемся.
        if (controller.signal.aborted) throw error;
        return 'dirty';
      }
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const parsed = parseSseFrame(part);
        if (!parsed) continue; // пинг-комментарий или неразборный фрейм
        if (typeof parsed.seq === 'number') lastSeqs.set(id, parsed.seq);
        if (parsed.kind === 'gone') return 'gone';
        if (parsed.kind === 'done' || parsed.kind === 'error') sawTerminal = true;
        applyEvent(id, parsed as unknown as ChatEvent);
      }
    }
    return sawTerminal ? 'clean' : 'dirty';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Запрос потока со сроком на ОТВЕТ (не на весь поток).
 *
 * Таймер снимается, как только пришли заголовки: дальше поток живёт сколько
 * нужно — агент работает часами. Отдельный контроллер нужен именно поэтому:
 * повесив срок на общий, мы бы рвали и сам ответ на середине.
 */
export async function openResponse(
  url: string,
  init: RequestInit,
  controller: AbortController,
): Promise<Response> {
  const connect = new AbortController();
  // Прерывание кнопкой обязано доходить до запроса и после снятия таймера,
  // поэтому подписку не снимаем: контроллер живёт ровно столько же, сколько поток.
  if (controller.signal.aborted) connect.abort(controller.signal.reason);
  else
    controller.signal.addEventListener('abort', () => connect.abort(controller.signal.reason), {
      once: true,
    });

  const timer = setTimeout(
    () => connect.abort(new DOMException('Сервер не ответил на запрос потока', CONNECT_TIMEOUT)),
    STREAM_CONNECT_MS,
  );
  try {
    return await fetch(url, { ...init, signal: connect.signal });
  } finally {
    clearTimeout(timer);
  }
}

export const isConnectTimeout = (error: unknown): boolean =>
  error instanceof DOMException && error.name === CONNECT_TIMEOUT;

/** Открыть один поток: `send` стартует прогон (POST), `attach` подключается (GET). */
export async function openStream(
  id: string,
  input: StartInput,
  controller: AbortController,
  mode: 'send' | 'attach',
  settle?: (outcome: SendOutcome) => void,
): Promise<'clean' | 'dirty' | 'gone' | 'refused'> {
  let response: Response;
  try {
    if (mode === 'send') {
      response = await openResponse(
        `${apiClient.defaults.baseURL}/chat/send`,
        sendInit(JSON.stringify(input)),
        controller,
      );
    } else {
      const from = lastSeqs.get(id) ?? 0;
      // Прогон мог быть заведён на сервере под другим ключом (см. serverRunId).
      const target = runs.get(id)?.serverRunId ?? id;
      response = await openResponse(
        `${apiClient.defaults.baseURL}/chat/${target}/stream?from=${from}`,
        { method: 'GET' },
        controller,
      );
    }
  } catch (error) {
    // Срок ожидания вышел. Переподключению это обычный повод попробовать ещё
    // раз; отправке — нет: сообщение не принято, и молчать об этом нельзя.
    if (!isConnectTimeout(error)) throw error;
    if (mode !== 'send') return 'dirty';
    markStalled(id);
    throw error;
  }

  if (!response.ok) {
    if (mode !== 'send') return 'dirty';
    // Отказ до запуска агента: статус + код. Ни переподключаться, ни ретраить
    // тут нечего — сообщение просто не принято, и об этом надо сказать прямо.
    const refusal = await readRefusal(response);
    setRun(id, {
      error: refusal.message,
      errorCode: refusal.code,
      // 5xx — сбой самой панели, а не отказ: такое перезапустить можно.
      errorRetriable: response.status >= 500,
      serverRunId: refusal.runId ?? runs.get(id)?.serverRunId,
    });
    settle?.({ ok: false, code: refusal.code, message: refusal.message, files: refusal.files });
    return 'refused';
  }
  // 202 — разговор занят, сообщение встало в очередь сервера (`queueIfBusy`)
  // или уже передано агенту на ходу (`steer`).
  // Потока этого сообщения ещё нет: подключаемся к ИДУЩЕМУ прогону по его
  // ключу (`dirty` — обычный повод переподключиться), а новый ход вкладки
  // подхватят опросом идущих, когда сервер его запустит.
  if (mode === 'send' && response.status === 202) {
    const queued = (await response.json().catch(() => ({}))) as {
      runId?: string;
      steered?: boolean;
    };
    setRun(id, { serverRunId: queued.runId ?? runs.get(id)?.serverRunId });
    // `steered` — сообщение уже у агента посреди хода (`steer`), не в очереди.
    settle?.({ ok: true, queued: queued.steered !== true });
    return 'dirty';
  }
  if (!response.body) {
    if (mode === 'send') throw new Error('Пустой ответ сервера');
    return 'dirty';
  }
  // Поток пошёл — сообщение принято, поле ввода можно очищать.
  if (mode === 'send') settle?.({ ok: true });
  markLive(id);
  return pumpStream(id, response, controller);
}
