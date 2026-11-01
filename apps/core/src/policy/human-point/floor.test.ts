import { describe, expect, it } from 'vitest';
import { PLATFORM_HUMAN_FLOOR, withFloor } from './floor.ts';

/**
 * Пол политики человека (уровень 1): `.claude/**` — пункт 5 и правка только с грантом; конфиг
 * человека его только расширяет (объединение масок, классов, грантов); трекер и фордж — значение
 * конфига, без раздела — «спрашивать».
 */

describe('human point floor (level 1): config only widens it', () => {
  it('no config → the floor itself, tracker/forge writes ask', () => {
    expect(withFloor(null)).toEqual({
      actionClasses: [],
      pathGlobs: ['.claude/**'],
      grantRequired: [{ globs: ['.claude/**'], ops: ['edit'] }],
      trackerWrites: 'ask',
      forgeWrites: 'ask',
    });
    expect(withFloor(undefined)).toEqual(PLATFORM_HUMAN_FLOOR);
  });

  it('a config that omits the floor glob cannot drop it; its own entries are added', () => {
    const got = withFloor(
      {
        actionClasses: ['deploy'],
        pathGlobs: ['migrations/**'],
        trackerWrites: 'auto',
        forgeWrites: 'ask',
      },
      [
        { globs: ['db/**'], ops: ['exec-db'] },
        { globs: ['.claude/**'], ops: ['edit'] },
      ],
    );
    expect(got).toEqual({
      actionClasses: ['deploy'],
      pathGlobs: ['.claude/**', 'migrations/**'],
      grantRequired: [
        { globs: ['.claude/**'], ops: ['edit'] },
        { globs: ['db/**'], ops: ['exec-db'] },
      ],
      trackerWrites: 'auto',
      forgeWrites: 'ask',
    });
  });
});
