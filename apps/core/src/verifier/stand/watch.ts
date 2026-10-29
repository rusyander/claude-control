import type { Fact } from '@agentdeck/contracts/core/facts';
import { readFact } from '../../lib/facts/read-fact.ts';
import { httpStatus } from '../../platform/net-probe.ts';
import type { StandState, StandWatch, StandWatchOptions } from './stand.types.ts';

/**
 * Наблюдение за стендом (04:75-77): адрес здоровья читается классом `stand.health`
 * (`onUnknown: refuse` — нет ответа = нездоров, никогда «здоров»). Эпоха растёт на каждом
 * переходе здоров ↔ нездоров и на смене личности процесса стенда: прогон, во время которого
 * эпоха сдвинулась, получает `no-verdict(stand)`, а не красный (зона C сравнивает до/после).
 */

export async function readHealth(
  url: string,
  options: Pick<StandWatchOptions, 'setTimer'> = {},
): Promise<Fact<number>> {
  return readFact<number>(
    'stand.health',
    () => httpStatus(url, 4_000),
    options.setTimer ? { setTimer: options.setTimer } : {},
  );
}

function up(fact: Fact<number>): { healthy: boolean; reason: string } {
  if ('value' in fact) {
    const ok = fact.value >= 200 && fact.value < 400;
    return { healthy: ok, reason: `status ${fact.value}` };
  }
  if ('absent' in fact) return { healthy: false, reason: 'absent' };
  return { healthy: false, reason: fact.unknown };
}

export function createStandWatch(options: StandWatchOptions): StandWatch {
  const read = options.read ?? ((url: string) => readHealth(url, options));
  let current: StandState = { epoch: 0, healthy: null, lastReason: 'not read' };
  let identity: string | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<StandState> | undefined;

  // Бросок читателя — `unknown`, не отказ промиса: таймер иначе сыпал бы необработанными
  // отказами, а Node по умолчанию на них роняет процесс ядра.
  const guarded = async <T>(fn: () => Promise<Fact<T>>): Promise<Fact<T>> => {
    try {
      return await fn();
    } catch (error) {
      return { unknown: `reader threw: ${error instanceof Error ? error.message : String(error)}` };
    }
  };

  const once = async (): Promise<StandState> => {
    const health = up(await guarded(() => read(options.health)));
    let epoch = current.epoch;
    if (current.healthy !== null && current.healthy !== health.healthy) epoch += 1;
    if (options.identity) {
      const identityOf = options.identity;
      const id = await guarded(() => identityOf());
      const now = 'value' in id ? id.value : null;
      // Личность прочиталась и другая — перезапуск, даже если оба чтения здоровья «здоров».
      if (identity !== null && now !== null && now !== identity) epoch += 1;
      if (now !== null) identity = now;
    }
    current = { epoch, healthy: health.healthy, lastReason: health.reason };
    return current;
  };

  return {
    tick: () => {
      // Одно чтение за раз: таймер и прогон, спросивший сам, не считают переход дважды.
      inFlight ??= once().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    state: () => current,
    start() {
      if (timer) return;
      timer = setInterval(
        () => void this.tick().catch(() => undefined),
        options.intervalMs ?? 2_000,
      );
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
