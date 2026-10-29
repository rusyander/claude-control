import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../platform/safe-io/atomic-write.ts';
import { readBytesSync } from '../platform/safe-io/files.ts';
import { TASK_FILES } from './journal.types.ts';
import { REDUCER_VERSION, type TaskFoldState } from './reduce/reduce.types.ts';

/**
 * Снимок — производное от журнала (01 §State): `{reducer, seq, h, state}`. Пишется каждые 200
 * событий и в каждой безопасной точке. Открытие доверяет снимку, только если его `h` совпал с
 * цепочкой журнала на том же `seq` и версия свёртки та же; иначе — полный проход по журналу.
 * Снимок никогда не источник правды: удалить его можно в любой момент.
 */

export const SNAPSHOT_EVERY = 200;

const snapshotSchema = z.strictObject({
  reducer: z.number().int(),
  seq: z.number().int().nonnegative(),
  h: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.record(z.string(), z.unknown()),
});

export interface Snapshot {
  reducer: number;
  seq: number;
  h: string;
  state: TaskFoldState;
}

export function snapshotPath(dir: string): string {
  return join(dir, TASK_FILES.snapshot);
}

export function writeSnapshot(dir: string, state: TaskFoldState, h: string): void {
  const snapshot: Snapshot = { reducer: REDUCER_VERSION, seq: state.seq, h, state };
  writeFileAtomic(snapshotPath(dir), `${JSON.stringify(snapshot)}\n`);
}

/**
 * Снимок, годный для этого журнала: версия свёртки совпала и `h` равен цепочке на его `seq`.
 * Негодный (битый, чужой, устаревший формат) — `undefined`, и открытие идёт полным проходом.
 */
export function usableSnapshot(dir: string, hashes: readonly string[]): Snapshot | undefined {
  const read = readBytesSync(snapshotPath(dir));
  if (!('value' in read)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.value.toString('utf8'));
  } catch {
    // Битый снимок — не авария: он производный, журнал пересоберёт состояние.
    return undefined;
  }
  const shape = snapshotSchema.safeParse(parsed);
  if (!shape.success) return undefined;
  const { reducer, seq, h } = shape.data;
  if (reducer !== REDUCER_VERSION) return undefined;
  if (seq === 0 || seq > hashes.length) return undefined;
  if (hashes[seq - 1] !== h) return undefined;
  return shape.data as unknown as Snapshot;
}
