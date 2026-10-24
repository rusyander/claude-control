import { describe, it, expect, vi } from 'vitest';
import type { ProcessRow } from '../kill-tree.mjs';

/**
 * Один снимок процессов на пачку снятий (23.10): «Остановить всё» и пауза
 * дерева снимают N сессий подряд, а снимок Windows синхронный (~0,8 с). Здесь
 * подменён только сам снимок — он и есть граница; номера в нём заведомо
 * свободные, снятие по ним возвращает «gone».
 */

const FREE = 4_000_000;
const rows: ProcessRow[] = [
  { pid: FREE, ppid: 1, created: 1n },
  { pid: FREE + 1, ppid: FREE, created: 2n },
  { pid: FREE + 2, ppid: 1, created: 3n },
];
const reads = vi.hoisted(() => ({ count: 0 }));

vi.mock('../kill-tree.mjs', async (original) => {
  const actual = await original<typeof import('../kill-tree.mjs')>();
  const read = () => {
    reads.count += 1;
    return rows;
  };
  return { ...actual, readProcessTable: read, readPosixProcessTable: read };
});

const { killPidTree, withProcessSnapshot } = await import('./process-tree.ts');

describe('withProcessSnapshot', () => {
  it('N снятий внутри — один снимок; после пачки общий снимок не зовётся', () => {
    reads.count = 0;
    withProcessSnapshot(() => {
      killPidTree(FREE, { keepRoot: true });
      killPidTree(FREE + 2, { keepRoot: true });
      // Вложенный вызов живёт в снимке внешнего.
      withProcessSnapshot(() => killPidTree(FREE, { keepRoot: true }));
    });
    expect(reads.count).toBe(1);

    // Пачка кончилась — снимок не переживает её: снятие снаружи читает свой
    // (настоящий, не подменённый) снимок, общий больше не зовётся.
    killPidTree(FREE, { keepRoot: true });
    expect(reads.count).toBe(1);
  });

  it('сбой внутри пачки не оставляет снимок висеть', () => {
    reads.count = 0;
    expect(() =>
      withProcessSnapshot(() => {
        killPidTree(FREE, { keepRoot: true });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    withProcessSnapshot(() => killPidTree(FREE, { keepRoot: true }));
    expect(reads.count).toBe(2);
  });
});
