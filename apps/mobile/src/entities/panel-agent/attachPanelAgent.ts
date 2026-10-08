import type { RunEventSink, PanelAgentRunOutcome } from './run.types';
import { STREAM_SILENCE_MS, STREAM_LOST } from './run.constants';
import { open } from './open';
import { readRun } from './readRun';
import { authHeaders } from '../../shared/api/authHeaders';

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
