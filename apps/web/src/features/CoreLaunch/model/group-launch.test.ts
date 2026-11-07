import { describe, expect, it } from 'vitest';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import { type GroupLaunchDeps, groupStepOf, launchGroup } from './groupLaunch';
import type { LaunchCommand } from './launch.types';

/**
 * Запуск группы (этап 11, W3-18): кнопка запускает КАЖДУЮ задачу группы той же командой, что у
 * одиночной; отказ одной назван и не держит остальные; повтор после частичного отказа шлёт только
 * незапущенным, неизвестный исход — тем же `cmdId`.
 */

type View = Pick<TaskView, 'state' | 'split'>;
type SplitState = 'proposed' | 'accepted' | 'edited' | 'approved' | 'refused';
const SPLIT = (splitId: string, state: SplitState): View['split'] =>
  ({ splitId, seq: 1, by: 'core', state, units: [] }) as unknown as View['split'];
/** Ждёт запуска: деление принято проверкой, человек его ещё не утвердил. */
const waiting = (splitId: string): View => ({
  state: 'awaiting-launch',
  split: SPLIT(splitId, 'accepted'),
});

interface Sent {
  taskId: string;
  command: LaunchCommand;
  cmdId: string;
}

/** Ядро-двойник: вид задачи меняет только применённая команда, повтор `cmdId` — сохранённый исход. */
function fakeCore(views: Record<string, View | null>, refuse: Record<string, string | 'network'>) {
  const sent: Sent[] = [];
  const outcomes = new Map<string, boolean>();
  let n = 0;
  const deps: GroupLaunchDeps = {
    view: async (id) => views[id] ?? null,
    send: async (taskId, command, cmdId) => {
      sent.push({ taskId, command, cmdId });
      const known = outcomes.get(cmdId);
      if (known !== undefined)
        return known ? { ok: true } : { ok: false, reason: 'x', keep: false };
      const why = refuse[taskId];
      if (why === 'network') return { ok: false, reason: 'network down', keep: true };
      if (why) {
        outcomes.set(cmdId, false);
        return { ok: false, reason: why, keep: false };
      }
      outcomes.set(cmdId, true);
      views[taskId] = { state: 'running', split: SPLIT('s', 'approved') };
      return { ok: true };
    },
    newId: () => `cmd-${(n += 1)}`,
  };
  return { deps, sent };
}

describe('group launch starts every task of the group (W3-18)', () => {
  it('every waiting task gets approve-split with its own split', async () => {
    const { deps, sent } = fakeCore(
      { t0: waiting('s0'), t1: waiting('s1'), t2: waiting('s2') },
      {},
    );
    const rows = await launchGroup(['t0', 't1', 't2'], deps, new Map());
    expect(rows.map((r) => r.status)).toEqual(['started', 'started', 'started']);
    expect(sent.map((s) => [s.taskId, s.command])).toEqual([
      ['t0', { kind: 'approve-split', fields: { splitId: 's0' } }],
      ['t1', { kind: 'approve-split', fields: { splitId: 's1' } }],
      ['t2', { kind: 'approve-split', fields: { splitId: 's2' } }],
    ]);
  });

  it('a refused task is named, the others still start', async () => {
    const { deps } = fakeCore(
      { t0: waiting('s0'), t1: waiting('s1'), t2: waiting('s2') },
      { t1: 'preflight: roads failed' },
    );
    const rows = await launchGroup(['t0', 't1', 't2'], deps, new Map());
    expect(rows).toEqual([
      { taskId: 't0', status: 'started' },
      { taskId: 't1', status: 'refused', why: null, reason: 'preflight: roads failed' },
      { taskId: 't2', status: 'started' },
    ]);
  });

  it('a retry after a partial failure sends only to the tasks not started, unknown outcome keeps its cmdId', async () => {
    const views = { t0: waiting('s0'), t1: waiting('s1'), t2: waiting('s2') };
    const refuse: Record<string, string | 'network'> = { t2: 'network' };
    const { deps, sent } = fakeCore(views, refuse);
    const cmdIds = new Map<string, string>();
    const first = await launchGroup(['t0', 't1', 't2'], deps, cmdIds);
    expect(first.map((r) => r.status)).toEqual(['started', 'started', 'refused']);
    const lost = sent.find((s) => s.taskId === 't2')?.cmdId;
    delete refuse.t2;
    sent.length = 0;
    const again = await launchGroup(['t0', 't1', 't2'], deps, cmdIds);
    expect(again.map((r) => r.status)).toEqual(['started', 'started', 'started']);
    expect(sent.map((s) => s.taskId)).toEqual(['t2']);
    expect(sent[0]?.cmdId).toBe(lost);
  });

  it('a core refusal drops the key: the next press is a new command, not the same refusal', async () => {
    const refuse: Record<string, string | 'network'> = { t0: 'state-conflict' };
    const { deps, sent } = fakeCore({ t0: waiting('s0') }, refuse);
    const cmdIds = new Map<string, string>();
    await launchGroup(['t0'], deps, cmdIds);
    delete refuse.t0;
    const again = await launchGroup(['t0'], deps, cmdIds);
    expect(again).toEqual([{ taskId: 't0', status: 'started' }]);
    expect(sent[0]?.cmdId).not.toBe(sent[1]?.cmdId);
  });

  it('a task that cannot be launched yet is named by its reason without a command', async () => {
    const { deps, sent } = fakeCore(
      { t0: { state: 'estimating', split: null }, t1: null, t2: { state: 'failed', split: null } },
      {},
    );
    const rows = await launchGroup(['t0', 't1', 't2'], deps, new Map());
    expect(rows.map((r) => (r.status === 'refused' ? r.why : r.status))).toEqual([
      'awaiting-split',
      'no-view',
      'ended',
    ]);
    expect(sent).toEqual([]);
  });

  it('a split the check has not decided yet is not launchable; an edited one is approved', () => {
    expect(groupStepOf({ state: 'awaiting-launch', split: SPLIT('s', 'proposed') })).toEqual({
      kind: 'not-ready',
      why: 'awaiting-split',
    });
    expect(groupStepOf({ state: 'awaiting-launch', split: SPLIT('s', 'edited') })).toEqual({
      kind: 'command',
      command: { kind: 'approve-split', fields: { splitId: 's' } },
    });
  });

  it('an approved split whose launch failed is relaunched with launch, not a second approval', () => {
    expect(groupStepOf({ state: 'awaiting-launch', split: SPLIT('s', 'approved') })).toEqual({
      kind: 'command',
      command: { kind: 'launch', fields: {} },
    });
  });
});
