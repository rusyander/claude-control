import type { PanelAgentRunEvent } from '@agentdeck/contracts/panel-agent';

/** Кадр хода с номером: по нему отцепившийся клиент догоняет ход. */
export interface TurnFrame {
  seq: number;
  event: PanelAgentRunEvent;
}

type Listener = (frame: TurnFrame | 'end') => void;

/** Сколько кадров хода держать для догоняющего клиента. */
export const TURN_FEED_LIMIT = 5000;

/**
 * Кадры одного хода агента панели — для клиента, который отцепился и вернулся.
 *
 * Телефон на Android 15+ теряет сеть через секунды после ухода приложения в
 * фон (цепочка `APP_BACKGROUND`), поток рвётся, и ход, который жил ровно пока
 * открыт запрос, умирал вместе с ним (F-101, D3). Ход, начатый с `detach`,
 * переживает обрыв, а его кадры копятся здесь: вернувшийся клиент просит всё
 * после последнего увиденного номера — как чат догоняет прогон по `fromSeq`.
 */
export class TurnFeed {
  private readonly frames: TurnFrame[] = [];
  private readonly listeners = new Set<Listener>();
  private seq = 0;
  private finished = false;

  private readonly limit: number;

  constructor(limit = TURN_FEED_LIMIT) {
    this.limit = limit;
  }

  get ended(): boolean {
    return this.finished;
  }

  get subscribers(): number {
    return this.listeners.size;
  }

  push(event: PanelAgentRunEvent): TurnFrame {
    this.seq += 1;
    const frame = { seq: this.seq, event };
    this.frames.push(frame);
    if (this.frames.length > this.limit) this.frames.shift();
    for (const listener of this.listeners) listener(frame);
    return frame;
  }

  end(): void {
    if (this.finished) return;
    this.finished = true;
    for (const listener of this.listeners) listener('end');
    this.listeners.clear();
  }

  /**
   * Кадры после `fromSeq`. `undefined` — начало уже вытеснено: склеить ленту без
   * дыры нельзя, клиент перечитывает разговор из файла.
   */
  since(fromSeq: number): TurnFrame[] | undefined {
    const first = this.frames[0];
    if (first && fromSeq < first.seq - 1) return undefined;
    return this.frames.filter((frame) => frame.seq > fromSeq);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Кадр SSE с номером — `id:` после `data:`: читатели, ищущие строку `data:`, его не замечают. */
export function seqFrame(frame: TurnFrame): string {
  return `data: ${JSON.stringify(frame.event)}\nid: ${frame.seq}\n\n`;
}
