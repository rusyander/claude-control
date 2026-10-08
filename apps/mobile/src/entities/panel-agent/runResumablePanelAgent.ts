import type { PanelAgentRunOutcome, RunEventSink } from './run.types';
import { STREAM_LOST, STREAM_SILENCE_MS } from './run.constants';
import type { PanelAgentRunRequest } from '@agentdeck/contracts/panel-agent';
import { runPanelAgent } from './runPanelAgent';
import { attachPanelAgent } from './attachPanelAgent';

/** Сколько раз телефон пробует вернуться к ходу после обрыва и с какой паузой. */
export const REATTACH = { attempts: 5, waitMs: 2_000 } as const;

/** Обрыв связи, а не отказ, не ошибка агента и не «Стоп». */
export function lostTurn(outcome: PanelAgentRunOutcome): boolean {
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
