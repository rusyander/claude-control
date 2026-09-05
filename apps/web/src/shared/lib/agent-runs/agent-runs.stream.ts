import { apiClient } from '@shared/api/client';
import { STREAM_CONNECT_MS, STREAM_STALL_MS } from './agent-runs.constants';
import { applyEvent } from './agent-runs.events';
import { parseSseFrame } from './agent-runs.sse';
import { emit, lastSeqs, runs, setRun } from './agent-runs.state';
import type { ChatEvent, SendOutcome, StartInput } from './agent-runs.types';

/**
 * Имя отказа, которым помечен НАШ срок ожидания, — чтобы отличить его от
 * прерывания кнопкой. У обоих тип `AbortError`, и по одному типу «человек
 * остановил» и «сервер не ответил» неразличимы.
 */
const CONNECT_TIMEOUT = 'StreamConnectTimeout';

const isConnectTimeout = (error: unknown): boolean =>
  error instanceof DOMException && error.name === CONNECT_TIMEOUT;

/**
 * До какого размера тела отправка переживает вкладку (байт UTF-8).
 *
 * Браузер даёт таким запросам 64 КиБ на всю страницу разом, и запрос сверх
 * квоты отвергается на месте, а не уходит. Обычное сообщение — сотни байт, и
 * даже четыре одновременных не приблизятся к квоте; вложения едут в том же
 * теле и легко её превышают — они остаются обычным запросом.
 */
export const KEEPALIVE_BYTES = 16_000;

/**
 * Запрос отправки. Он обязан пережить вкладку: дописанное уходит из очереди в
 * момент запроса, и F5 в ту же секунду отменял запрос, ещё не ушедший с машины
 * (замерено 06.09 живым прогоном: `POST /chat/send` → `ERR_ABORTED` через 100
 * мс, второго хода на сервере нет). Из очереди вынуто, до сервера не дошло —
 * сообщение пропадало молча. `keepalive` велит браузеру дослать запрос уже без
 * страницы; ответ ей и не нужен — прогон после перезагрузки подхватится опросом.
 */
export function sendInit(body: string): RequestInit {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  };
  if (new TextEncoder().encode(body).length < KEEPALIVE_BYTES) init.keepalive = true;
  return init;
}

/**
 * Запрос потока со сроком на ОТВЕТ (не на весь поток).
 *
 * Таймер снимается, как только пришли заголовки: дальше поток живёт сколько
 * нужно — агент работает часами. Отдельный контроллер нужен именно поэтому:
 * повесив срок на общий, мы бы рвали и сам ответ на середине.
 */
async function openResponse(
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

/**
 * Прочитать SSE-поток прогона в стор. Пинг-комментарии (`: ping`) пропускаем —
 * но не молча: сам факт их прихода означает, что сокет жив, и сбрасывает сторож
 * простоя. Возвращает, как поток завершился: `clean` — пришло терминальное
 * событие (done/error); `gone` — сервер сообщил, что прогона больше нет;
 * `dirty` — поток оборвался или замолчал без терминала (повод переподключиться).
 */
async function pumpStream(
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
 * Пометить прогон замолчавшим. Метка нужна ленте: пока она стоит, потоковый
 * пузырь с оборванного хода не показывается, а история перестаёт прятать этот
 * ход — иначе ответ, уже дописанный в транскрипт, остаётся невидимым.
 */
function markStalled(id: string): void {
  if (!runs.get(id)) return;
  setRun(id, { stalled: true });
  emit();
}

/**
 * Связь восстановлена: поток открыт заново и сейчас догонит пропущенное с
 * последнего `seq`. Снимаем метку — пузырь снова наш, а история снова прячет
 * этот ход, чтобы он не показался дважды.
 */
function markLive(id: string): void {
  if (!runs.get(id)?.stalled) return;
  setRun(id, { stalled: undefined, dropped: undefined });
  emit();
}

/** Разобрать тело отказа сервера: код и текст, ничего не выковыривая из строки. */
async function readRefusal(response: Response): Promise<{
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
      message: body.message || `Сервер ответил ${response.status}`,
      files: body.files,
      runId: body.runId,
    };
  } catch {
    // Не JSON (прокси, падение) — кода нет, показываем статус.
    return { message: `Сервер ответил ${response.status}` };
  }
}

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
  if (!response.body) {
    if (mode === 'send') throw new Error('Пустой ответ сервера');
    return 'dirty';
  }
  // Поток пошёл — сообщение принято, поле ввода можно очищать.
  if (mode === 'send') settle?.({ ok: true });
  markLive(id);
  return pumpStream(id, response, controller);
}
