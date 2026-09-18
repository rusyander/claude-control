import { describe, expect, it } from 'vitest';
import type { ProjectWorktree, ProjectWorktreesInfo } from '@agentdeck/contracts';
import { ru } from '../../shared/config/i18n/ru';
import { copyFacts, visibleCopies } from './copy-facts';

/**
 * Копии в кармане. Проверяется то, ради чего они там вообще появились: человек
 * получает в чат отказ «копия неполная» и должен прочитать на телефоне, ЧЕГО
 * не хватает, а не гадать, сломалась ли панель.
 */
const main: ProjectWorktree = {
  path: 'C:/work/repo',
  branch: 'main',
  head: 'a1b2c3d',
  isMain: true,
  detached: false,
  locked: false,
  prunable: false,
};

const copy: ProjectWorktree = {
  path: 'C:/work/repo-worktrees/feature-x',
  branch: 'feature/x',
  head: 'e4f5a6b',
  isMain: false,
  detached: false,
  locked: false,
  prunable: false,
  copy: { ready: true, gaps: [], access: 'ok' },
};

function info(worktrees: ProjectWorktree[]): ProjectWorktreesInfo {
  return { isRepo: true, worktrees };
}

describe('visibleCopies', () => {
  it('основная копия в список не идёт — её состояние показывает пульт git', () => {
    expect(visibleCopies(info([main, copy])).map((item) => item.path)).toEqual([copy.path]);
  });

  it('не репозиторий и пустой ответ — раздела нет вовсе', () => {
    expect(visibleCopies(info([main]))).toEqual([]);
    expect(visibleCopies({ isRepo: false, worktrees: [main, copy] })).toEqual([]);
    expect(visibleCopies(undefined)).toEqual([]);
  });
});

describe('copyFacts', () => {
  it('полная копия: коммит и запись доступа', () => {
    expect(copyFacts(copy, ru)).toEqual(['e4f5a6b', 'доступ есть']);
  });

  it('три состояния доступа различимы — «не сверялось» не выдаётся за «нет»', () => {
    const missing = { ...copy, copy: { ready: false, gaps: [], access: 'missing' as const } };
    const unknown = { ...copy, copy: { ready: false, gaps: [], access: 'unknown' as const } };
    expect(copyFacts(missing, ru)).toContain('нет записи доступа');
    expect(copyFacts(unknown, ru)).toContain('доступ не сверялся');
    expect(copyFacts(unknown, ru)).not.toContain('нет записи доступа');
  });

  it('запертая копия и пропавший каталог названы', () => {
    const stuck = { ...copy, locked: true, prunable: true };
    expect(copyFacts(stuck, ru)).toEqual(['e4f5a6b', 'заперта', 'каталога нет', 'доступ есть']);
  });

  it('основная копия без сверки не врёт про доступ', () => {
    expect(copyFacts(main, ru)).toEqual(['a1b2c3d']);
  });
});
