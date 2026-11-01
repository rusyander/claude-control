import type { QueueClass } from '@agentdeck/contracts/core/records';
import type { CheckQueue } from '../../verifier/queue/queue.ts';
import { runCheck } from '../../verifier/run/run.ts';
import type { RunDeps, RunLease, RunResult, RunSpec } from '../../verifier/run/run.types.ts';
import { notRun, sleep } from '../checks/request/helpers.ts';

/**
 * Прогон ядра мимо `requestCheck`, но под той же арендой слота (D§3.8): «красный до» и прогон базы
 * итога (`grade: base`) — записи своего сорта, которых вход проверки не пишет, а слот машины у
 * них общий с остальными. Без аренды два таких прогона и прогон модели делили бы машину сверх
 * числа слотов. Слот не выдан до срока — прогон не начат: `aborted` с причиной, не тишина.
 */

export interface LeasedRunInput {
  queue: Pick<
    CheckQueue,
    'enqueue' | 'acquire' | 'beatTicket' | 'withdraw' | 'heartbeat' | 'release' | 'beatMs'
  >;
  class: QueueClass;
  project: string;
  taskId: string;
  runDeps: RunDeps;
  /** Исполнитель прогона (`CheckDeps.run` — с разводкой классов migration/contract). */
  run?: (spec: RunSpec, lease: RunLease, deps: RunDeps) => Promise<RunResult>;
  now(): number;
  /** Сколько ждать слот; по умолчанию 30 мин. */
  waitMs?: number;
  pollMs?: number;
}

/** Слот не выдан — не «окружение не готово» (`notRun`), а остановленный до старта прогон. */
export function notStarted(reason: string): RunResult {
  return { ...notRun(reason), end: 'aborted' };
}

export function leasedRun(input: LeasedRunInput): (spec: RunSpec) => Promise<RunResult> {
  const run = input.run ?? runCheck;
  const waitMs = input.waitMs ?? 30 * 60_000;
  const poll = input.pollMs ?? 250;
  return async (spec) => {
    const ticket = input.queue.enqueue({
      class: input.class,
      project: input.project,
      taskId: input.taskId,
      key: null,
    });
    const until = input.now() + waitMs;
    let leaseId: string | null = null;
    try {
      for (;;) {
        const got = await input.queue.acquire(ticket.ticketId);
        if ('granted' in got) {
          leaseId = got.granted.leaseId;
          break;
        }
        if ('gone' in got) return notStarted(`queue: ticket gone: ${got.gone}`);
        if (input.now() >= until)
          return notStarted(`queue: no slot within ${waitMs} ms: ${got.waiting} (${got.detail})`);
        input.queue.beatTicket(ticket.ticketId);
        await sleep(poll);
      }
      const id = leaseId;
      return await run(
        spec,
        { leaseId: id, beatMs: input.queue.beatMs(), heartbeat: () => input.queue.heartbeat(id) },
        input.runDeps,
      );
    } finally {
      // Билет без аренды снимается сам (F25), аренда — после прогона, при любом выходе.
      if (leaseId === null) input.queue.withdraw(ticket.ticketId);
      else input.queue.release(leaseId);
    }
  };
}
