import type { PanelAgentRunRequest } from '@agentdeck/contracts/panel-agent';
import type { RunEventSink, PanelAgentRunOutcome } from './run.types';
import { STREAM_SILENCE_MS } from './run.constants';
import { open } from './open';
import { readRun } from './readRun';
import { authHeaders } from '../../shared/api/authHeaders';

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
