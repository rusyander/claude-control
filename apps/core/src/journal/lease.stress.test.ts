import { spawn } from 'node:child_process';
import { openSync, closeSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CREATED, openFresh, tempDir } from './__fixtures__/journal-harness.ts';
import { readJournalLines } from './read-lines.ts';
import { snapshotPath } from './snapshot.ts';
import { TASK_FILES } from './journal.types.ts';

const FIXTURES = join(import.meta.dirname, '__fixtures__');
const READERS = 16;
const APPENDS = 150;

/** Ждать условия по событию, с щедрым сроком: время здесь — только защита от зависания. */
async function waitFor(ok: () => boolean, ms = 40_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error('condition not reached before the deadline');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Дочерний процесс на TS под тем же node; ответ — строки JSON из stdout. */
function runChild(script: string, args: string[]): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', join(FIXTURES, script), ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${script} exit ${code}: ${err}`));
      else
        resolve(
          out
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as unknown),
        );
    });
  });
}

describe('lease under contention', () => {
  it('P55 P74 8 processes take over one stale lease at once → exactly one owner', async () => {
    const dir = tempDir('lease-');
    writeFileSync(
      join(dir, TASK_FILES.owner),
      JSON.stringify({
        leaseId: '0190a000-0000-7000-8000-00000000dead',
        pid: 999_999,
        pidStart: 'gone',
        bootId: 'old',
        build: 'old',
        acquiredAt: Date.now() - 60_000,
      }),
    );
    const startAt = String(Date.now() + 2_500);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => runChild('lease-contender.ts', [dir, startAt, '1500'])),
    );
    const firsts = results.map((r) => r[0] as { ok: boolean; pid: number });
    const winners = firsts.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const owner = JSON.parse(readFileSync(join(dir, TASK_FILES.owner), 'utf8')) as { pid: number };
    expect(owner.pid).toBe(winners[0]?.pid);
    const held = results
      .flat()
      .filter((r) => typeof r === 'object' && r !== null && 'stillHolds' in r);
    expect(held).toEqual([{ stillHolds: true }]);
  }, 60_000);

  it('P55 append + snapshot replace under 16 reader processes and a held handle → no torn line, no half snapshot', async () => {
    const { task, dir, taskId } = await openFresh();
    task.append({ kind: 'task.created', actor: 'core', data: CREATED });
    expect(task.snapshotNow()).toEqual({ written: true });
    const startSeq = task.state.seq;
    // Объём работы постоянный, а не «сколько успеем за 5 с»: под тремя параллельными наборами
    // порог скорости краснел (30 записей вместо 100), хотя свойство — целость под читателями —
    // не нарушалось. Перекрытие гарантирует рукопожатие (см. journal-reader.ts), не скорость.
    const ctl = tempDir('ctl-');
    const deadline = Date.now() + 50_000;
    const readers = Array.from({ length: READERS }, () =>
      runChild('journal-reader.ts', [dir, taskId, ctl, String(deadline)]),
    );
    await waitFor(() => readdirSync(ctl).filter((f) => f.startsWith('ready-')).length === READERS);
    let appended = 0;
    let held: number | undefined;
    const snapshots = { written: 0, refused: [] as string[] };
    while (appended < APPENDS) {
      // Вторая половина: чужой дескриптор держит снимок (антивирус, индексатор) — запись идёт.
      if (held === undefined && appended >= APPENDS / 2) held = openSync(snapshotPath(dir), 'r');
      task.append({
        kind: 'error',
        actor: 'core',
        data: { code: `c${appended}`, detail: 'x'.repeat(200) },
      });
      appended += 1;
      if (appended % 25 === 0) {
        const outcome = task.snapshotNow();
        if (outcome.written) snapshots.written += 1;
        else snapshots.refused.push(outcome.reason);
      }
      if (appended % 50 === 0) await new Promise((r) => setTimeout(r, 1));
    }
    writeFileSync(join(ctl, 'stop'), '');
    const reports = (await Promise.all(readers)).map(
      (r) =>
        r[0] as {
          reads: number;
          firstSeq: number;
          lastSeq: number;
          stopped: boolean;
          errorCount: number;
          errors: string[];
        },
    );
    if (held !== undefined) closeSync(held);
    expect(task.snapshotNow()).toEqual({ written: true });
    task.close();
    // Каждая попытка снимка — либо замена, либо названный отказ, ни одной молчаливой.
    expect(snapshots.written + snapshots.refused.length).toBe(APPENDS / 25);
    // Windows не даёт заменить файл, открытый другим процессом, — а 16 читателей держат снимок
    // почти всё время, так что под общей нагрузкой отказом может кончиться любая попытка
    // (замер: 1 замена из 6). Отказ назван кодом ОС; на POSIX замена не ждёт читателей.
    for (const reason of snapshots.refused) expect(reason).toMatch(/EPERM|EBUSY|EACCES/);
    if (process.platform !== 'win32') expect(snapshots.refused).toEqual([]);
    for (const report of reports) {
      expect({ errors: report.errors, count: report.errorCount }).toEqual({ errors: [], count: 0 });
      // Каждый читатель жил всю запись: видел состояние до первой строки и после последней.
      expect(report).toMatchObject({
        stopped: true,
        firstSeq: startSeq,
        lastSeq: startSeq + APPENDS,
      });
    }
    expect(readJournalLines(dir, taskId).lines.length).toBe(appended + 3);
    const snap = JSON.parse(readFileSync(snapshotPath(dir), 'utf8')) as { seq: number };
    expect(snap.seq).toBe(appended + 3);
  }, 60_000);
});
