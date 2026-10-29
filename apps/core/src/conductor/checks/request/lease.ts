import type { CheckKey, CheckRequest, QueueLease } from '@agentdeck/contracts/core/records';
import { quietBeat, quietly, sleep } from './helpers.ts';
import type { Held, ServiceState } from './request.types.ts';

/** Очередь: ожидание чужого прогона того же ключа (P68), аренда слота и её снятие. */

/** Ждать чужой прогон того же ключа: освободился, вышел срок решения или бюджет ответа. */
export async function waitFlight(
  s: ServiceState,
  req: CheckRequest,
  key: CheckKey,
  deadlineMs: number,
  answerBy: number,
): Promise<'released' | 'timeout' | 'budget'> {
  const { deps, poll } = s;
  for (;;) {
    const hold = deps.queue.inflight(req.project, key);
    if ('value' in hold && hold.value === null) return 'released';
    const now = deps.now();
    if (now >= deadlineMs) return 'timeout';
    if (now >= answerBy) return 'budget';
    await sleep(poll);
  }
}

/**
 * Аренда слота: ждём выдачи, держим билет и ключ живыми. `gone` — очередь сняла билет;
 * `budget` — слот не выдан до срока ответа (мост MCP рвёт вызов): билет снят, ответ — `defer`.
 */
export async function lease(
  s: ServiceState,
  req: CheckRequest,
  key: CheckKey | null,
  checkRunId: string,
  answerBy: number,
): Promise<{ lease: QueueLease } | { gone: string } | { budget: string }> {
  const { deps, poll } = s;
  const ticket = deps.queue.enqueue({
    class: req.class,
    project: req.project,
    taskId: req.taskId,
    key,
  });
  let granted = false;
  try {
    for (;;) {
      const got = await deps.queue.acquire(ticket.ticketId);
      if ('granted' in got) {
        granted = true;
        return { lease: got.granted };
      }
      if ('gone' in got) return got;
      if (deps.now() >= answerBy)
        return { budget: `no slot within the answer budget: ${got.waiting} (${got.detail})` };
      quietBeat(() => deps.queue.beatTicket(ticket.ticketId));
      if (key) quietBeat(() => deps.queue.beatInflight(req.project, key, checkRunId));
      await sleep(poll);
    }
  } finally {
    // Билет живого держателя очередь не снимет никогда (F25): любой выход без аренды — бюджет,
    // снятие очередью, исключение — снимает его сам, иначе он занял бы место в очереди навсегда.
    if (!granted) quietly(() => deps.queue.withdraw(ticket.ticketId));
  }
}

export function release(s: ServiceState, req: CheckRequest, held: Held): void {
  const { deps } = s;
  quietly(() => deps.queue.release(held.lease.leaseId));
  if (held.key)
    quietly(() => deps.queue.releaseInflight(req.project, held.key as CheckKey, held.claimRunId));
}
