import { fetch as streamingFetch } from 'expo/fetch';
import { splitRunFrames } from '@agentdeck/contracts/panel-agent-feed';
import type { PanelAgentRunEvent, PanelAgentRunRequest } from '@agentdeck/contracts/panel-agent';
import { apiUrl, authHeaders } from '../../shared/api/client';

export type PanelAgentRunOutcome =
  { ok: true } | { ok: false; code?: string; status?: number; message: string; aborted?: boolean };

/**
 * Один ход агента панели: `POST /api/agent/run`, как у окна на компьютере.
 * Штатный `fetch` React Native тело потоком не читает — отсюда `expo/fetch`.
 *
 * Ход живёт, пока открыт запрос: обрыв (Стоп, уход приложения в фон, сеть)
 * останавливает агента на сервере, и его ждущая карточка снимается сама.
 * Переподключения к ходу у сервера нет — сказанное до обрыва остаётся в файле
 * разговора и читается из истории.
 */
export async function runPanelAgent(
  body: PanelAgentRunRequest,
  onEvent: (event: PanelAgentRunEvent) => void,
  signal: AbortSignal,
): Promise<PanelAgentRunOutcome> {
  let response: Response;
  try {
    response = (await streamingFetch(apiUrl('/agent/run'), {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })) as unknown as Response;
  } catch (error) {
    if (signal.aborted) return { ok: false, message: 'aborted', aborted: true };
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  if (!response.ok) {
    let code: string | undefined;
    let message = '';
    try {
      const refusal = (await response.json()) as { error?: string; message?: string };
      code = refusal.error;
      message = refusal.message ?? '';
    } catch {
      // Тело не JSON — остаётся статус.
    }
    return { ok: false, code, status: response.status, message };
  }
  if (!response.body) return { ok: false, message: '' };

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
  if (!finished) return { ok: false, code: 'cut', message: '' };
  return { ok: true };
}
