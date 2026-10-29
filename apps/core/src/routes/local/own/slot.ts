import type { AbortLike } from '@agentdeck/contracts/core/routes';
import { RouteAborted } from '../../lease.ts';

/**
 * Слот карты (11 R:PR-04): одна модель на карту, вторая загрузка ЖДЁТ аренду слота в порядке
 * очереди, никогда не вытесняет первую. Ожидание прерываемо: снятый ждущий уходит из очереди,
 * не занимая слот.
 *
 * Порядок — по месту (`rank`, меньше — раньше; равные — в порядке прихода). Место по умолчанию —
 * время постановки, поэтому место, сохранённое до перезапуска ядра, сравнимо с новыми: ждущий,
 * вернувшийся со своим старым местом, проходит раньше пришедших после него.
 */

export interface SlotHold {
  readonly key: string;
  /** Отдать слот следующему; повторный вызов — без действия. */
  release(): void;
}

export interface SlotQueue {
  acquire(key: string, signal?: AbortLike, rank?: number): Promise<SlotHold>;
  /**
   * Занять слот за держателем, пережившим перезапуск ядра (его сервер идёт): сразу, никогда не
   * ожидая (F-67). Сервер уже в памяти карты — очередь его не остановит, а ожидание освобождения,
   * которое делает только release того же маршрута, вешало возврат навсегда. Занят — держатели
   * делят слот: ждущий получает его, когда отпустят все.
   */
  adopt(key: string): SlotHold;
  /**
   * Держать место ждущего прошлого ядра, пока он не вернулся: на его месте в очереди, а дошла
   * очередь — слот ждёт его, не уходя дальше. Вернулся — `claim`; не вернётся — `cancel`.
   */
  reserve(key: string, rank: number): SlotReservation;
  /** Сколько ждут слот за текущим держателем (места прошлого ядра — тоже). */
  waiting(key: string): number;
  held(key: string): boolean;
}

export interface SlotReservation {
  readonly rank: number;
  /** Очередь дошла: слот держится за этим местом. */
  readonly granted: boolean;
  /** Вернувшийся ждущий занимает своё место: слот уже его — сразу, иначе ждёт на этом месте. */
  claim(signal?: AbortLike): Promise<SlotHold>;
  /** Место снято: держался слот — уходит следующему. Повторный вызов и после `claim` — без действия. */
  cancel(): void;
}

interface Waiter {
  rank: number;
  grant: (hold: SlotHold) => void;
}

export function createSlotQueue(now: () => number = Date.now): SlotQueue {
  const holders = new Set<string>();
  /** Сверх первого держателя: принятые серверы, делящие слот (`adopt` при занятом). */
  const extra = new Map<string, number>();
  const queues = new Map<string, Waiter[]>();

  const makeHold = (key: string): SlotHold => {
    let released = false;
    return {
      key,
      release: () => {
        if (released) return;
        released = true;
        const shared = extra.get(key) ?? 0;
        if (shared > 0) {
          // Слот держит ещё кто-то: отпускает один из делящих, дальше не уходит.
          if (shared === 1) extra.delete(key);
          else extra.set(key, shared - 1);
          return;
        }
        const next = queues.get(key)?.shift();
        if (next) {
          // Слот переходит из рук в руки без окна, в которое влез бы третий.
          next.grant(makeHold(key));
          return;
        }
        holders.delete(key);
      },
    };
  };

  // За всеми с местом не дальше своего: равные — в порядке прихода.
  const enqueue = (key: string, waiter: Waiter): void => {
    const queue = queues.get(key) ?? [];
    queues.set(key, queue);
    const at = queue.findIndex((other) => other.rank > waiter.rank);
    queue.splice(at < 0 ? queue.length : at, 0, waiter);
  };
  const dequeue = (key: string, waiter: Waiter): void => {
    const queue = queues.get(key);
    const at = queue?.indexOf(waiter) ?? -1;
    if (queue && at >= 0) queue.splice(at, 1);
  };

  const acquire = (key: string, signal?: AbortLike, rank = now()): Promise<SlotHold> => {
    if (signal?.aborted) return Promise.reject(new RouteAborted('slot wait'));
    if (!holders.has(key)) {
      holders.add(key);
      return Promise.resolve(makeHold(key));
    }
    return new Promise<SlotHold>((resolve, reject) => {
      const onAbort = (): void => {
        dequeue(key, waiter);
        reject(new RouteAborted('slot wait'));
      };
      const waiter: Waiter = {
        rank,
        grant: (hold) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(hold);
        },
      };
      enqueue(key, waiter);
      signal?.addEventListener('abort', onAbort);
    });
  };

  const reserve = (key: string, rank: number): SlotReservation => {
    let hold: SlotHold | undefined;
    let settled = false;
    let claimant: ((hold: SlotHold) => void) | undefined;
    const waiter: Waiter = {
      rank,
      grant: (granted) => {
        const take = claimant;
        claimant = undefined;
        if (take) take(granted);
        else hold = granted;
      },
    };
    if (holders.has(key)) enqueue(key, waiter);
    else {
      holders.add(key);
      hold = makeHold(key);
    }
    return {
      rank,
      get granted() {
        return hold !== undefined;
      },
      claim: (signal) => {
        if (settled) return Promise.reject(new Error('slot place already claimed or cancelled'));
        settled = true;
        const ready = hold;
        hold = undefined;
        if (ready) return Promise.resolve(ready);
        if (signal?.aborted) {
          dequeue(key, waiter);
          return Promise.reject(new RouteAborted('slot wait'));
        }
        return new Promise<SlotHold>((resolve, reject) => {
          const onAbort = (): void => {
            claimant = undefined;
            dequeue(key, waiter);
            reject(new RouteAborted('slot wait'));
          };
          claimant = (granted) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(granted);
          };
          signal?.addEventListener('abort', onAbort);
        });
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        const ready = hold;
        hold = undefined;
        if (ready) ready.release();
        else dequeue(key, waiter);
      },
    };
  };

  return {
    acquire,
    reserve,
    adopt: (key) => {
      if (holders.has(key)) extra.set(key, (extra.get(key) ?? 0) + 1);
      else holders.add(key);
      return makeHold(key);
    },
    waiting: (key) => queues.get(key)?.length ?? 0,
    held: (key) => holders.has(key),
  };
}
