import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../../lib/ids/uuidv7.ts';
import { createLivenessProbe, identityOfPid } from '../../../platform/process-identity.ts';
import { createCheckQueue } from '../queue.ts';

/**
 * Соперник стресса очереди (P55 образец, P38 «cross-build»): отдельный процесс со своей
 * «сборкой» берёт слот общей очереди `rounds` раз, держит его `holdMs` и отпускает. Каждое
 * удержание — строка JSON `{start,end,pid}` в stdout; тест сверяет, что удержаний одновременно
 * не больше слотов. Аргументы: dir build rounds holdMs slots [key]. С ключом каждый круг сначала
 * берёт ключ «в полёте» (P68): второй процесс того же ключа ждёт, а не бежит вторым.
 */

const [dirArg, buildArg, roundsArg, holdArg, slotsArg, key] = process.argv.slice(2);
if (!dirArg || !buildArg)
  throw new Error('usage: contender.ts dir build rounds holdMs slots [key]');
const dir: string = dirArg;
const build: string = buildArg;
const rounds = Number(roundsArg ?? '3');
const holdMs = Number(holdArg ?? '30');
const slots = Number(slotsArg ?? '1');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const me = await identityOfPid(process.pid);
  if (!('value' in me)) throw new Error('own identity unreadable');
  const probe = createLivenessProbe();
  const queue = createCheckQueue({
    dir,
    config: () => ({ slots, shareCap: 1, agingMs: 60_000, beatMs: 2_000 }),
    holder: { pid: process.pid, start: me.value.start, bootId: 'stress' },
    build,
    now: Date.now,
    newId,
    isAlive: (id) => probe.isAlive(id),
  });
  for (let round = 0; round < rounds; round += 1) {
    const runId = newId();
    if (key) {
      for (;;) {
        const claim = await queue.claimInflight('p', key, runId);
        if (claim.claimed) break;
        await sleep(5);
      }
    }
    const ticket = queue.enqueue({
      class: 'work',
      project: `p-${build}`,
      taskId: runId,
      key: null,
    });
    for (;;) {
      const got = await queue.acquire(ticket.ticketId);
      if ('granted' in got) {
        const start = Date.now();
        await sleep(holdMs);
        const end = Date.now();
        process.stdout.write(`${JSON.stringify({ start, end, pid: process.pid })}\n`);
        queue.release(got.granted.leaseId);
        break;
      }
      if ('gone' in got) throw new Error(got.gone);
      queue.beatTicket(ticket.ticketId);
      await sleep(5);
    }
    if (key) queue.releaseInflight('p', key, runId);
  }
  writeFileSync(join(dir, `done-${process.pid}`), 'ok');
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  },
);
