import type { PanelAgentRunEvent } from '@agentdeck/contracts/panel-agent';

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
