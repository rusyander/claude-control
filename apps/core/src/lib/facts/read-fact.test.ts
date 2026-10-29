import { describe, expect, it } from 'vitest';
import type { ActionKind } from '@agentdeck/contracts/core/journal';
import { ACTION_READ_CLASS, decideReconcile, type OpenAction } from '../../conductor/reconcile.ts';
import { READ_CLASS_NAMES } from './read-classes.ts';
import { absent, ABSENT, readFact } from './read-fact.ts';

/** Таймер, который срабатывает сразу: таймаут класса без ожидания реального срока. */
const fireNow = (fn: () => void): { cancel(): void } => {
  queueMicrotask(fn);
  return { cancel: () => undefined };
};
const never = (): Promise<string> => new Promise<string>(() => undefined);
const fsError = (code: string): Error => Object.assign(new Error(`${code}: op 'x'`), { code });

const FAULTS = {
  timeout: () => readFactOf(never, { setTimer: fireNow }),
  ENOENT: () =>
    readFactOf(() => {
      throw fsError('ENOENT');
    }),
  EPERM: () =>
    readFactOf(() => {
      throw fsError('EPERM');
    }),
  garbage: () => readFactOf(() => 'not-a-sha', { validate: (v) => /^[0-9a-f]{40}$/.test(v) }),
};
let currentClass: (typeof READ_CLASS_NAMES)[number] = 'core.file';
function readFactOf(
  reader: () => string | Promise<string>,
  options: Parameters<typeof readFact<string>>[2] = {},
) {
  return readFact<string>(currentClass, reader, options);
}

const ACTION_KINDS = Object.keys(ACTION_READ_CLASS) as ActionKind[];
const action = (kind: ActionKind): OpenAction => ({
  actionId: '0190a000-0000-7000-8000-000000000001',
  kind,
  target: 't',
  idempotencyHint: 'h',
  startedAt: 0,
  startedSeq: 1,
});

describe('read facts', () => {
  it('P44 fault at every read class (timeout, ENOENT thrown, EPERM, garbage) → unknown, never absent', async () => {
    for (const name of READ_CLASS_NAMES) {
      currentClass = name;
      for (const [fault, run] of Object.entries(FAULTS)) {
        const fact = await run();
        expect({ name, fault, kind: 'unknown' in fact ? 'unknown' : 'other' }).toEqual({
          name,
          fault,
          kind: 'unknown',
        });
      }
    }
    currentClass = 'core.file';
    expect(await readFact('core.file', () => absent())).toBe(ABSENT);
  });

  it('P44 every action kind: a faulted fact leads to a decision different from the absent decision', async () => {
    for (const kind of ACTION_KINDS) {
      currentClass = ACTION_READ_CLASS[kind];
      for (const [fault, run] of Object.entries(FAULTS)) {
        const faulted = decideReconcile(action(kind), await run(), 0, 0);
        const onAbsent = decideReconcile(action(kind), ABSENT, 0, 0);
        expect({ kind, fault, same: faulted.verdict === onAbsent.verdict }).toEqual({
          kind,
          fault,
          same: false,
        });
        expect(['retry', 'ask']).toContain(faulted.verdict);
      }
    }
  });
});
