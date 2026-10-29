import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { OpenAction } from '../conductor/reconcile.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { closedSleepers, settle } from '../platform/__fixtures__/closed-sleeper.ts';
import { actionReaders } from './action-readers.ts';

/**
 * Сверка `process-start` на настоящем /proc (C5 на Linux, 28.10): закрытый свой процесс СТАРШЕ
 * записи `action.started` (ssh-agent) метку действия нести не может — процесс запускается после
 * записи; сверка не уходит в «неизвестно» и не спрашивает человека. Младший закрытый — сомнение.
 * `.alone`: закрытый процесс виден любому соседнему поиску — файл идёт отдельным проходом.
 */

const isLinux = process.platform === 'linux';
const MARK = 'AGENTDECK_ACTION_MARK';
const sleepers = closedSleepers('action-unread-');
afterEach(() => sleepers.killAll());
afterAll(() => sleepers.dispose());

function processStart(value: string, startedAt: number): OpenAction {
  return {
    actionId: newId(),
    kind: 'process-start',
    target: 'sleeper',
    idempotencyHint: `${MARK}=${value}`,
    startedAt,
    startedSeq: 1,
  };
}

const read = (action: OpenAction) => actionReaders()['process-start'](action)();

describe.runIf(isLinux)(
  'process-start reconcile beside an own process with a closed environ',
  () => {
    it('a closed own process older than the action record → the process reads absent, not unknown', async () => {
      await sleepers.start();
      await settle(1_300);
      expect(await read(processStart(`older-${process.pid}-${Date.now()}`, Date.now()))).toEqual({
        absent: true,
      });
    }, 30_000);

    it('a closed own process born after the action record (could carry its marker) → unknown', async () => {
      const value = `younger-${process.pid}-${Date.now()}`;
      const action = processStart(value, Date.now());
      await settle(1_300);
      const closed = await sleepers.start({ [MARK]: value });
      await expect(read(action)).rejects.toThrow(
        new RegExp(`unreadable environ \\(pid [^)]*\\b${closed}\\b`),
      );
    }, 30_000);
  },
);
