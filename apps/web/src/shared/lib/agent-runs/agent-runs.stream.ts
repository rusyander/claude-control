import { apiClient } from '@shared/api/client';
import { applyEvent } from './agent-runs.events';
import { parseSseFrame } from './agent-runs.sse';
import { lastSeqs, runs, setRun } from './agent-runs.state';
import type { ChatEvent, SendOutcome, StartInput } from './agent-runs.types';

/**
 * Прочитать SSE-поток прогона в стор. Пинг-комментарии (`: ping`) пропускаем.
 * Возвращает, как поток завершился: `clean` — пришло терминальное событие
 * (done/error); `gone` — сервер сообщил, что прогона больше нет; `dirty` —
 * поток оборвался без терминала (повод переподключиться).
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

  for (;;) {
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
  if (mode === 'send') {
    response = await fetch(`${apiClient.defaults.baseURL}/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
  } else {
    const from = lastSeqs.get(id) ?? 0;
    // Прогон мог быть заведён на сервере под другим ключом (см. serverRunId).
    const target = runs.get(id)?.serverRunId ?? id;
    response = await fetch(`${apiClient.defaults.baseURL}/chat/${target}/stream?from=${from}`, {
      method: 'GET',
      signal: controller.signal,
    });
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
  return pumpStream(id, response, controller);
}
