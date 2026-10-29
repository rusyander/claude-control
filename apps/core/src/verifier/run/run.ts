import { join } from 'node:path';
import type { CheckLeaseEnv } from '@agentdeck/contracts/core/records';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { identityOfPid, type ProcessIdentity } from '../../platform/process-identity.ts';
import { ensureDir } from '../../platform/safe-io/files.ts';
import { removeVerified } from '../../platform/safe-io/remove.ts';
import { spawnResolved } from '../../platform/spawn.ts';
import { stopTree } from '../../platform/tree-stop.ts';
import { parseFailing, passingOf } from './failing.ts';
import type { RunDeps, RunEnd, RunLease, RunResult, RunSpec } from './run.types.ts';
import { failedCountOf } from './verdict.ts';

/**
 * Прогон одной проверки под арендой слота (04:15, D§3.8). Окружение — пин профиля целиком,
 * плюс метка `AGENTDECK_CHECK_LEASE=<leaseId>`: дети прогона не захватываются второй раз
 * (03:126), и по той же метке снимается всё дерево. Свой временный каталог на прогон —
 * снимается и перечитывается после (P40). Срок — learned p95 × 3; вышел, сняли извне, аренду
 * отобрали — дерево снимается, вердикт не «красный» (04:63: aborted ≠ red). Эпоха стенда до и
 * после: сменилась — `standMoved` (04:76). Вывод — голова + хвост до 2 МБ.
 */

export const CHECK_LEASE_ENV: CheckLeaseEnv = 'AGENTDECK_CHECK_LEASE';
export const LOG_CAP_BYTES = 2 * 1024 * 1024;

/** Голова + хвост вывода (archived store.cjs LOG_CAP): начало объясняет запуск, конец — исход. */
export class CappedLog {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  total = 0;
  private readonly half: number;
  constructor(cap = LOG_CAP_BYTES) {
    this.half = Math.floor(cap / 2);
  }
  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.headBytes < this.half) {
      const take = chunk.subarray(0, this.half - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      chunk = chunk.subarray(take.length);
      if (chunk.length === 0) return;
    }
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tailBytes > this.half && this.tail.length > 0) {
      const first = this.tail[0]!;
      const over = this.tailBytes - this.half;
      if (first.length <= over) {
        this.tail.shift();
        this.tailBytes -= first.length;
      } else {
        this.tail[0] = first.subarray(over);
        this.tailBytes -= over;
      }
    }
  }
  get truncated(): boolean {
    return this.total > this.headBytes + this.tailBytes;
  }
  text(): string {
    const head = Buffer.concat(this.head).toString('utf8');
    const tail = Buffer.concat(this.tail).toString('utf8');
    if (!this.truncated) return head + tail;
    const cut = this.total - this.headBytes - this.tailBytes;
    return `${head}\n[… ${cut} bytes cut …]\n${tail}`;
  }
}

async function epochOf(deps: RunDeps, taskId: string): Promise<number | null> {
  try {
    return await deps.standEpoch(taskId);
  } catch {
    // Эпоха не прочиталась — сравнивать не с чем; `null` до и после не даёт «стенд сдвинулся».
    return null;
  }
}

export async function runCheck(spec: RunSpec, lease: RunLease, deps: RunDeps): Promise<RunResult> {
  const temp = join(spec.tempRoot, spec.checkRunId);
  ensureDir(temp);
  const env = {
    ...spec.env,
    [CHECK_LEASE_ENV]: lease.leaseId,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
  };
  const epochBefore = await epochOf(deps, spec.taskId);
  const started = deps.now();
  const log = new CappedLog();
  const finish = async (
    end: RunEnd,
    exit: number | null,
    signal: string | null,
    extra: Partial<RunResult> = {},
  ): Promise<RunResult> => {
    const ms = deps.now() - started;
    const epochAfter = await epochOf(deps, spec.taskId);
    const removed = removeVerified(temp);
    const text = log.text();
    const failedCount = failedCountOf(end, spec.entry.filter?.kind, text);
    return {
      end,
      exit,
      signal,
      ms,
      log: text,
      logBytes: log.total,
      truncated: log.truncated,
      failing: end === 'exit' && exit !== 0 ? parseFailing(spec.entry.filter?.kind, text) : [],
      ...passingOf(end, spec.entry.filter?.kind, text),
      ...(failedCount !== undefined ? { failedCount } : {}),
      standEpoch: epochAfter,
      standMoved: epochBefore !== null && epochAfter !== null && epochBefore !== epochAfter,
      temp: removed.removed ? { removed: true } : { removed: false, reason: removed.reason },
      ...extra,
    };
  };

  const [command, ...args] = spec.argv;
  if (!command) return finish('spawn-failed', null, null, { reason: 'empty argv' });
  // Запуск синхронный, слушатели — сразу: быстрый прогон успевает выйти, пока читается личность,
  // и `close`, пропущенный до подписки, повесил бы прогон до срока.
  const launched = spawnResolved({ command, args, cwd: spec.cwd, env, ownGroup: true });
  if (!launched.ok) {
    // Причина — и в журнал записи: модель и человек читают лог, а `reason` прогона дальше не идёт.
    log.push(Buffer.from(`[agentdeck] not started: ${launched.reason}\n`));
    return finish('spawn-failed', null, null, { reason: launched.reason });
  }
  const child = launched.child;
  child.stdout?.on('data', (d: Buffer) => log.push(d));
  child.stderr?.on('data', (d: Buffer) => log.push(d));
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', () => resolve({ code: null, signal: null }));
  });
  const known =
    child.pid === undefined
      ? null
      : await identityOfPid(child.pid).catch((): Fact<ProcessIdentity> => ({ unknown: 'read' }));
  const identity: ProcessIdentity | null = known && 'value' in known ? known.value : null;

  let stopping: RunEnd | null = null;
  let stopped: Promise<void> = Promise.resolve();
  let residual: string | undefined;
  const sweep = async (): Promise<void> => {
    if (!identity) {
      // Личность не прочиталась — снимаем хотя бы корень по номеру; остаток назван.
      child.kill();
      residual = 'root identity unknown: tree not swept';
      return;
    }
    const report = await stopTree(identity, {
      marker: { name: CHECK_LEASE_ENV, value: lease.leaseId },
      group: true,
      ...(deps.graceMs !== undefined ? { graceMs: deps.graceMs } : {}),
    });
    if (report.residual.length > 0 || report.unknown)
      residual = [
        report.residual.length > 0
          ? `residual pids ${report.residual.map((r) => r.pid).join(',')}`
          : '',
        report.unknown ?? '',
      ]
        .filter(Boolean)
        .join('; ');
  };
  const stop = (why: RunEnd): void => {
    if (stopping) return;
    stopping = why;
    stopped = sweep();
  };

  const deadline = setTimeout(() => stop('deadline'), spec.deadlineMs);
  const beat = setInterval(() => {
    let answer: ReturnType<RunLease['heartbeat']>;
    try {
      answer = lease.heartbeat();
    } catch (error) {
      // Брошенное из таймера — необработанное исключение процесса: умерло бы всё ядро со всеми
      // задачами. Удар, который бросил, — непрочитанный удар (F25): следующий попробует снова.
      answer = { unknown: error instanceof Error ? error.message : String(error) };
    }
    // Аренду отобрали (снята как устаревшая) — слот уже чужой: прогон снимается. Непрочитанная
    // аренда — не «отобрали» (F25): следующий удар прочтёт снова.
    if (answer === 'lost') stop('lease-lost');
  }, lease.beatMs);
  const onAbort = (): void => stop('aborted');
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  if (deps.signal?.aborted) onAbort();

  const exit = await closed;
  clearTimeout(deadline);
  clearInterval(beat);
  deps.signal?.removeEventListener('abort', onAbort);
  // Корень вышел раньше, чем остановка дошла до конца дерева: ждём её отчёт об остатке.
  await stopped;
  const end: RunEnd = stopping ?? 'exit';
  return finish(end, exit.code, exit.signal, residual ? { residual } : {});
}
