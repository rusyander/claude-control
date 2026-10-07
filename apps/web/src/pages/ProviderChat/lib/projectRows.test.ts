import { describe, it, expect } from 'vitest';
import type { ProviderChatProject } from '@agentdeck/contracts';
import { projectRows } from './projectRows';

const project = (over: Partial<ProviderChatProject>): ProviderChatProject => ({
  path: 'C:/work/app',
  name: 'work/app',
  lastActivity: '2026-10-05T10:00:00.000Z',
  providers: [
    { id: 'claude', name: 'Claude Code', chatCount: 3, lastActivity: '2026-10-05T10:00:00.000Z' },
  ],
  ...over,
});

describe('projectRows', () => {
  it('проект Claude виден в чате Kimi с бейджем Claude, активный провайдер отмечен', () => {
    const rows = projectRows(
      [
        project({
          providers: [
            {
              id: 'kimi',
              name: 'Kimi Code',
              chatCount: 1,
              lastActivity: '2026-10-06T10:00:00.000Z',
            },
            {
              id: 'claude',
              name: 'Claude Code',
              chatCount: 3,
              lastActivity: '2026-10-05T10:00:00.000Z',
            },
          ],
        }),
      ],
      'kimi',
      '',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.badges.map((badge) => [badge.id, badge.isActive])).toEqual([
      ['kimi', true],
      ['claude', false],
    ]);
    expect(rows[0]).not.toHaveProperty('problem');
  });

  it('каталог, где разговор не начать, остаётся строкой с причиной', () => {
    const rows = projectRows([project({ startProblem: 'missing' })], 'codex', '');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.problem).toBe('missing');
  });

  it('поиск идёт по имени и по пути без учёта регистра, порядок сервера сохраняется', () => {
    const projects = [
      project({ path: 'C:/work/Alpha', name: 'work/Alpha' }),
      project({ path: 'D:/repos/beta', name: 'repos/beta' }),
      project({ path: 'D:/repos/gamma', name: 'repos/gamma' }),
    ];

    expect(projectRows(projects, 'codex', 'ALPHA').map((row) => row.path)).toEqual([
      'C:/work/Alpha',
    ]);
    expect(projectRows(projects, 'codex', ' d:/repos ').map((row) => row.path)).toEqual([
      'D:/repos/beta',
      'D:/repos/gamma',
    ]);
    expect(projectRows(projects, 'codex', '')).toHaveLength(3);
  });
});
