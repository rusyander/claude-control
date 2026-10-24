import { describe, expect, it } from 'vitest';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { sweepGroupCopies } from './split-control-routes.ts';

/**
 * Группа записи ищется по своему номеру, не по позиции (F-83): так её ищут конвейер и маршрут
 * «вернуть группу». Запись, где номер и позиция расходятся, — граница: снимок процессов подменён,
 * всё до него (связь разговора, запись плана, своя копия) настоящее.
 */
describe('sweepGroupCopies: группа по номеру, не по позиции (F-83)', () => {
  it('группа 1 на позиции 0 — снимается её копия, а не ничья', async () => {
    const record = {
      projectPath: '/p/main',
      copyRoot: '/p/shared',
      groups: [{ index: 1, path: '/p/copies/g1' }],
    } as unknown as SplitPlanRecord;
    const store = {
      getChatLink: (key: string) =>
        key === 'chat-1' ? { parentChatId: 'parent', groupIndex: 1 } : undefined,
      getSplitPlan: (parent: string) => (parent === 'parent' ? record : undefined),
    } as unknown as Parameters<typeof sweepGroupCopies>[0];
    const swept: string[][] = [];
    await sweepGroupCopies(store, ['chat-1'], async (dirs) => {
      swept.push([...dirs]);
      return [];
    });
    expect(swept).toEqual([['/p/copies/g1']]);
  });
});
