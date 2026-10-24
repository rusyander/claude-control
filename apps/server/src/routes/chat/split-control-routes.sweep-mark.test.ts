import { describe, expect, it, vi } from 'vitest';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import {
  groupRunProfile,
  TESTS_RUNS_AT_DELIVERY_ENV,
} from '../../domains/chat/group-profile/group-profile.ts';

const calls: unknown[][] = [];
vi.mock('../../lib/process-tree/path-sweep.ts', async (load) => {
  const real = await load<typeof import('../../lib/process-tree/path-sweep.ts')>();
  return {
    ...real,
    sweepPathsProcesses: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve([]);
    },
  };
});

const { sweepGroupCopies } = await import('./split-control-routes.ts');

/**
 * RF-BGCD-09: добор после паузы дерева доказывает «процесс группы» меткой в
 * окружении (Linux) — той, что профиль группы кладёт в окружение CLI. Метка в
 * вызове добора и метка профиля — одна переменная; разойдутся — сирота группы
 * у субжнеца снова уцелеет. Подменён только снимок процессов (граница ОС).
 */
describe('sweepGroupCopies: метка группы доезжает до добора (RF-BGCD-09)', () => {
  it('добор по умолчанию несёт ту метку, что профиль группы кладёт в окружение', async () => {
    const record = {
      projectPath: '/p/main',
      groups: [{ index: 0, path: '/p/copies/g0' }],
    } as unknown as SplitPlanRecord;
    const store = {
      getChatLink: (key: string) =>
        key === 'chat-0' ? { parentChatId: 'parent', groupIndex: 0 } : undefined,
      getSplitPlan: (parent: string) => (parent === 'parent' ? record : undefined),
    } as unknown as Parameters<typeof sweepGroupCopies>[0];
    await sweepGroupCopies(store, ['chat-0']);
    expect(calls).toEqual([[['/p/copies/g0'], { mark: TESTS_RUNS_AT_DELIVERY_ENV }]]);
    const env = groupRunProfile({ entries: [], tasksText: '', extra: [] }).env;
    expect(env[TESTS_RUNS_AT_DELIVERY_ENV]).toBe('1');
  });
});
