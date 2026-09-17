import type { PanelAgentRunEvent, PanelAgentRunRequest } from '@agentdeck/contracts/panel-agent';
import { splitRunFrames } from '@agentdeck/contracts/panel-agent-feed';
import { apiClient } from '@shared/api/client';
import { serverMessageFromPayload } from '@shared/config/i18n';

export type PanelAgentRunOutcome =
  { ok: true } | { ok: false; code?: string; message: string; aborted?: boolean };

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
      const chunk = await reader.read();
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
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (failure !== undefined) return { ok: false, message: failure };
  // Поток закрылся без итогового кадра — ход оборвался, молчать об этом нельзя.
  if (!finished) return { ok: false, message: 'Поток оборвался без итога' };
  return { ok: true };
}
