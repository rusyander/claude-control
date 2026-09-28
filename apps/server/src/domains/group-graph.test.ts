import { describe, it, expect } from 'vitest';
import type { Group, GroupMember } from '@agentdeck/contracts';
import { collectLeafMembers, wouldCreateCycle } from './group-graph.ts';

/**
 * Граф групп: вложенная группа входит участником в другую. Обход обязан быть
 * конечным (циклы обрезаются) и давать плоский список листьев по всей ветке.
 */

const group = (id: string, members: GroupMember[]): Group => ({
  id,
  name: id,
  description: '',
  color: 'accent',
  icon: 'folder',
  members,
  env: {},
  isEnabled: true,
  order: 0,
});

describe('collectLeafMembers', () => {
  it('плоская группа отдаёт свои сущности в исходном порядке', () => {
    const groups = [
      group('A', [
        { kind: 'rule', id: 'r1' },
        { kind: 'skill', id: 's1' },
      ]),
    ];

    expect(collectLeafMembers(groups, groups[0]!.members)).toEqual([
      { kind: 'rule', id: 'r1' },
      { kind: 'skill', id: 's1' },
    ]);
  });

  it('разворачивает вложенную группу в её листья', () => {
    const groups = [
      group('A', [
        { kind: 'rule', id: 'r1' },
        { kind: 'group', id: 'B' },
      ]),
      group('B', [{ kind: 'skill', id: 's1' }]),
    ];

    expect(collectLeafMembers(groups, groups[0]!.members)).toEqual([
      { kind: 'rule', id: 'r1' },
      { kind: 'skill', id: 's1' },
    ]);
  });

  it('дедуплицирует лист, доступный через несколько ветвей', () => {
    const groups = [
      group('A', [
        { kind: 'group', id: 'B' },
        { kind: 'group', id: 'C' },
      ]),
      group('B', [{ kind: 'skill', id: 'shared' }]),
      group('C', [{ kind: 'skill', id: 'shared' }]),
    ];

    expect(collectLeafMembers(groups, groups[0]!.members)).toEqual([
      { kind: 'skill', id: 'shared' },
    ]);
  });

  it('цикл A→B→A не зацикливает обход', () => {
    const groups = [
      group('A', [
        { kind: 'rule', id: 'r1' },
        { kind: 'group', id: 'B' },
      ]),
      group('B', [
        { kind: 'skill', id: 's1' },
        { kind: 'group', id: 'A' },
      ]),
    ];

    expect(collectLeafMembers(groups, groups[0]!.members)).toEqual([
      { kind: 'rule', id: 'r1' },
      { kind: 'skill', id: 's1' },
    ]);
  });
});

// Ревью 28.09 (F-186): `byId` по голому id — проектная группа с тем же id,
// что у вложенной общей, заслоняла её, и листья общей подгруппы терялись.
describe('collectLeafMembers: тёзка по id в проекте', () => {
  it('общая подгруппа разворачивается, даже если проектная носит тот же id', () => {
    const global = group('x', [{ kind: 'skill', id: 's1' }]);
    const project = {
      ...group('x', [{ kind: 'skill', id: 'p1' }]),
      scope: {
        kind: 'project' as const,
        path: 'C:/p',
        provider: 'claude' as const,
      },
    };
    const root: GroupMember[] = [{ kind: 'group', id: 'x' }];
    expect(collectLeafMembers([global, project as Group], root)).toEqual([
      { kind: 'skill', id: 's1' },
    ]);
  });
});

describe('wouldCreateCycle', () => {
  it('прямая ссылка на себя — цикл', () => {
    expect(wouldCreateCycle([], 'A', [{ kind: 'group', id: 'A' }])).toBe(true);
  });

  it('косвенная петля A→B→A — цикл', () => {
    const groups = [group('B', [{ kind: 'group', id: 'A' }])];
    expect(wouldCreateCycle(groups, 'A', [{ kind: 'group', id: 'B' }])).toBe(true);
  });

  it('дерево без обратных рёбер — не цикл', () => {
    const groups = [group('B', [{ kind: 'skill', id: 's1' }])];
    expect(wouldCreateCycle(groups, 'A', [{ kind: 'group', id: 'B' }])).toBe(false);
  });

  it('состав без вложенных групп цикла не образует', () => {
    expect(wouldCreateCycle([], 'A', [{ kind: 'rule', id: 'r1' }])).toBe(false);
  });
});
