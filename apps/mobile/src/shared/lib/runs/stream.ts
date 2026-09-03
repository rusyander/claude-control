import { fetch as streamingFetch } from 'expo/fetch';
import { apiUrl, authHeaders } from '../../api/client';
import { dict } from '../../config/i18n';
import { applyEvent, lastSeqs, runs, setRun } from './store';
import type { ChatEvent, SendOutcome, StartInput } from './types';

/**
 * Транспорт прогона. Штатный `fetch` React Native тело потоком читать не умеет
 * — он отдаёт его целиком по завершении, а ответ агента идёт минутами. Поэтому
 * `expo/fetch`: у него настоящий `ReadableStream`, и разбор кадров получается
 * тем же, что в браузере.
 *
 * Прогон на сервере живёт сам по себе, поэтому обрыв здесь ничего не убивает:
 * экран гаснет, поток отваливается, а работа идёт. При возвращении подключаемся
 * заново с последнего `seq` и догоняем пропущенное.
 */

type StreamOutcome = 'clean' | 'dirty' | 'gone' | 'refused';

/** Разбор кадра SSE: строка `data: {...}` либо комментарий-пинг. */
function parseFrame(part: string): (ChatEvent & { seq?: number }) | undefined {
  const line = part.split('\n').find((item) => item.startsWith('data:'));
  if (!line) return undefined;
  try {
    return JSON.parse(line.slice('data:'.length).trim()) as ChatEvent & { seq?: number };
  } catch {
    return undefined;
  }
}

async function pump(
  id: string,
  response: Response,
  controller: AbortController,
): Promise<StreamOutcome> {
  const body = response.body;
  if (!body) return 'dirty';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawTerminal = false;

  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      return 'dirty';
    }
    if (chunk.done) break;

    buffer += decoder.decode(chunk.value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const parsed = parseFrame(part);
      if (!parsed) continue;
      if (typeof parsed.seq === 'number') lastSeqs.set(id, parsed.seq);
      if ((parsed as { kind: string }).kind === 'gone') return 'gone';
      if (parsed.kind === 'done' || parsed.kind === 'error') sawTerminal = true;
      applyEvent(id, parsed);
    }
  }
  return sawTerminal ? 'clean' : 'dirty';
}

/** Отказ сервера на отправку: структурный код, текст для человека и ключ живого прогона. */
interface Refusal {
  code?: string;
  message: string;
  runId?: string;
}

/**
 * Текст отказа — по структурному `code`, а не по сообщению сервера: то написано
 * по-русски независимо от языка приложения, а имена файлов и путь приходят
 * отдельными полями, из которых строка собирается на своём языке. Гейт токена
 * отвечает `{error}`, а не `{message}`, — читаем оба.
 */
async function readRefusal(response: Response): Promise<Refusal> {
  const t = dict();
  let body: {
    code?: string;
    message?: string;
    error?: string;
    runId?: string;
    files?: string[];
    supported?: string[];
    cwd?: string;
  } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Тело не JSON — остаётся статус.
  }

  if (response.status === 401) return { code: 'unauthorized', message: t.api.tokenRejected };
  if (body.code === 'run_busy') {
    return { code: body.code, message: t.run.notSent.busy, runId: body.runId };
  }
  if (body.code === 'unsupported_upload') {
    return {
      code: body.code,
      message: t.run.notSent.files(
        (body.files ?? []).join(', '),
        (body.supported ?? []).join(', '),
      ),
    };
  }
  if (body.code === 'workspace_missing') {
    return { code: body.code, message: t.run.notSent.workspaceMissing(body.cwd ?? '') };
  }
  const detail = body.message || body.error || t.run.answered(response.status);
  return { code: body.code, message: t.run.notSent.other(detail), runId: body.runId };
}

/**
 * Открыть поток: `send` стартует прогон (POST), `attach` подключается к идущему
 * (GET с `from`). Оба возвращают, чем поток кончился, — решение о
 * переподключении принимает вызывающий.
 */
export async function openStream(
  id: string,
  input: StartInput,
  controller: AbortController,
  mode: 'send' | 'attach',
  settle?: (outcome: SendOutcome) => void,
): Promise<StreamOutcome> {
  let response: Response;
  if (mode === 'send') {
    response = (await streamingFetch(apiUrl('/chat/send'), {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal,
    })) as unknown as Response;
  } else {
    const from = lastSeqs.get(id) ?? 0;
    const target = runs.get(id)?.serverRunId ?? id;
    response = (await streamingFetch(
      apiUrl(`/chat/${encodeURIComponent(target)}/stream`, { from }),
      {
        method: 'GET',
        headers: authHeaders(),
        signal: controller.signal,
      },
    )) as unknown as Response;
  }

  if (!response.ok) {
    if (mode !== 'send') {
      // Токен отозван (панель сменила его) — переподключаться бессмысленно:
      // каждая попытка кончится тем же 401, а человеку нужно спарить телефон
      // заново. Обрыв же (любой другой статус) — повод догнать поток.
      if (response.status === 401) {
        setRun(id, { status: 'error', error: dict().api.tokenRejected, errorCode: 'unauthorized' });
        return 'refused';
      }
      return 'dirty';
    }
    const refusal = await readRefusal(response);
    setRun(id, {
      status: 'error',
      error: refusal.message,
      errorCode: refusal.code,
      errorRetriable: response.status >= 500,
      serverRunId: refusal.runId ?? runs.get(id)?.serverRunId,
    });
    settle?.({ ok: false, code: refusal.code, message: refusal.message });
    return 'refused';
  }

  if (mode === 'send') settle?.({ ok: true });
  return pump(id, response, controller);
}
