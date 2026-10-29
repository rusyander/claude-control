import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  RouteDecisionRecord,
  RouteLease,
  RouteRecorder,
} from '@agentdeck/contracts/core/routes';
import { hasValue, type Fact } from '../platform/os-kind.ts';
import {
  createLivenessProbe,
  identityOfPid,
  type ProcessIdentity,
  type ProcessTableSource,
} from '../platform/process-identity.ts';
import { osProcessTable } from '../platform/process-table.ts';
import { ownDir, ownOptions } from './local/own/__fixtures__/own-options.ts';
import { createOwnRoute } from './local/own/own.ts';
import { createSlotQueue } from './local/own/slot.ts';
import { createStubRoute } from './stub/stub.ts';

/**
 * Адрес выдаётся по снимку, начатому ПОСЛЕ вопроса: «жив» из кэша такта живости — не ответ
 * для `endpoint`. Сервер, умерший внутри такта, пока его порт ещё отвечает, иначе получил бы
 * адрес. Процессы и порты настоящие; подставлена только граница ОС — таблица процессов, где
 * названный номер «исчез» (сервер на самом деле жив и отвечает: так видно, что решает живость,
 * а не проба порта). Такт живости растянут до минуты, чтобы кэш точно был тёплым.
 */

const base = mkdtempSync(join(tmpdir(), 'endpoint-fresh-'));
const started: Promise<Fact<ProcessIdentity>>[] = [];
const track = (pid: number): void => void started.push(identityOfPid(pid));
afterAll(async () => {
  const probe = createLivenessProbe();
  // Только тот же процесс (pid + старт): номер мог уже уйти процессу соседнего набора.
  for (const read of await Promise.all(started))
    if (hasValue(read) && (await probe.isAlive(read.value)) === 'alive')
      process.kill(read.value.pid);
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    // Windows держит каталог мгновение — временный каталог ОС уберёт сама.
  }
});

/** Настоящая таблица ОС, из которой названные номера вычеркнуты («процесс завершился»). */
function tableWithout(gone: Set<number>): ProcessTableSource {
  const real = osProcessTable();
  return {
    async read() {
      const fact = await real.read();
      return hasValue(fact) ? { value: fact.value.filter((row) => !gone.has(row.pid)) } : fact;
    },
  };
}

function rec() {
  const decisions: RouteDecisionRecord[] = [];
  const record: RouteRecorder = {
    decision: (d) => void decisions.push(d),
    created: () => undefined,
    verified: () => undefined,
    leak: () => undefined,
  };
  return { record, decisions };
}

const stubPid = (lease: RouteLease): number =>
  Number(
    new URL(
      lease.resources.find((r) => r.kind === 'stub-server')?.ref ?? 'http://x',
    ).searchParams.get('pid'),
  );
const ownPid = (lease: RouteLease): number =>
  Number(
    /^pid (\d+) /.exec(lease.resources.find((r) => r.kind === 'model-server')?.ref ?? '')?.[1],
  );

const deadRefusal = () =>
  expect.objectContaining({
    class: 'endpoint',
    facts: [{ readClass: 'process.alive', kind: 'value' }],
    reasons: expect.arrayContaining([expect.stringMatching(/dead by identity/)]),
    output: expect.objectContaining({ kind: 'refuse' }),
  });

describe('endpoint reads liveness fresh — a server dead inside the tick gets no address', () => {
  it('stub: alive cached in the tick, then gone from the table while its port answers → null + dead refusal', async () => {
    const gone = new Set<number>();
    const probe = createLivenessProbe(tableWithout(gone), 60_000);
    const route = createStubRoute({ name: 'ep-fresh', script: ['x'], probe });
    const r = rec();
    const lease = await route.acquire({ taskId: 't', model: 'stub-model' }, r.record);
    const pid = stubPid(lease);
    track(pid);
    expect((await route.endpoint(lease, r.record))?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(r.decisions).toEqual([]);
    gone.add(pid);
    try {
      expect(await route.endpoint(lease, r.record)).toBeNull();
      expect(r.decisions).toEqual([deadRefusal()]);
    } finally {
      gone.clear();
    }
    expect((await route.release(lease, rec().record)).leaks).toEqual([]);
  }, 60_000);

  it('local:own: alive cached in the tick, then the keeper gone from the table while /health answers → null + dead refusal', async () => {
    const layout = ownDir(mkdtempSync(join(base, 'own-')));
    const gone = new Set<number>();
    const probe = createLivenessProbe(tableWithout(gone), 60_000);
    const route = createOwnRoute({ ...ownOptions(layout), probe, slots: createSlotQueue() });
    const r = rec();
    const lease = await route.acquire({ taskId: 't', model: 'tiny-model' }, r.record);
    const pid = ownPid(lease);
    track(pid);
    expect((await route.endpoint(lease, r.record))?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(r.decisions.filter((d) => d.class === 'endpoint')).toEqual([]);
    gone.add(pid);
    try {
      expect(await route.endpoint(lease, r.record)).toBeNull();
      expect(r.decisions.filter((d) => d.class === 'endpoint')).toEqual([deadRefusal()]);
    } finally {
      gone.clear();
    }
    await route.release(lease, rec().record);
  }, 120_000);
});
