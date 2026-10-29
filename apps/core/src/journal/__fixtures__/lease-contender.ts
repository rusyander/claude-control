import { acquireTaskLease } from '../lease.ts';

/**
 * Претендент на устаревшую аренду (P55): отдельный процесс, ждёт общего момента старта и
 * пробует взять аренду. Прежний владелец (pid 999999) мёртв, все прочие претенденты живы.
 * Печатает `{ok, pid}`; победитель держит аренду до конца прогона.
 */
const [dir = '', startAt = '0', holdMs = '1500'] = process.argv.slice(2);
const DEAD_PID = 999_999;

while (Date.now() < Number(startAt)) {
  // Общий старт: все претенденты бьют по заявке в одну миллисекунду.
}
const got = await acquireTaskLease(
  dir,
  { build: 'contender', pid: process.pid, pidStart: `start-${process.pid}`, bootId: 'b' },
  {
    isAlive: async ({ pid }) => (pid === DEAD_PID ? 'dead' : 'alive'),
    now: Date.now,
  },
);
process.stdout.write(`${JSON.stringify({ ok: got.ok, pid: process.pid })}\n`);
if (got.ok) {
  await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
  process.stdout.write(`${JSON.stringify({ stillHolds: got.lease.holds() })}\n`);
}
