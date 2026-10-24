import { describe, expect, it } from 'vitest';
import { groupLine, launchLines, sourceLine } from './askSource';

describe('askSource', () => {
  it('строка источника: CLI, приложение, фоновый ход', () => {
    expect(sourceLine({ app: 'agentdeck', cli: 'Claude Code' }, 'ru')).toBe('Claude Code · панель');
    expect(sourceLine({ app: 'outside', cli: 'Claude Code', background: true }, 'en')).toBe(
      'Claude Code · outside the panel · background turn',
    );
    expect(sourceLine(undefined, 'ru')).toBeUndefined();
  });

  it('группа со стадией и родителем', () => {
    expect(
      groupLine(
        {
          app: 'agentdeck',
          cli: 'Claude Code',
          group: { index: 2, title: 'Тесты', stage: 'review', parentTitle: 'Задача' },
        },
        'ru',
      ),
    ).toBe('Группа 2 «Тесты» · стадия «ревью» · из «Задача»');
    expect(groupLine({ app: 'agentdeck', cli: 'Claude Code', group: { index: 1 } }, 'en')).toBe(
      'Group 1',
    );
    expect(groupLine({ app: 'agentdeck', cli: 'Claude Code' }, 'ru')).toBeUndefined();
  });

  it('запуск агента: что, каким агентом, модель, усилие, фон', () => {
    expect(
      launchLines(
        {
          description: 'проверить тесты',
          subagentType: 'reviewer',
          model: 'opus',
          effort: 'high',
          background: true,
        },
        'ru',
      ),
    ).toEqual({
      title: 'Запуск агента',
      description: 'проверить тесты',
      how: 'агент reviewer · модель opus · усилие high · в фоне',
    });
    expect(launchLines({}, 'en')).toEqual({ title: 'Agent launch' });
    expect(launchLines(undefined, 'en')).toBeUndefined();
  });
});
