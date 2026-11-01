import { describe, expect, it } from 'vitest';
import { grantConfirmations } from './grants.ts';

/**
 * 06:110-111 «спрашивает один раз до запуска»: записи `grantRequired` репозиториев задачи, чьи
 * маски пересекают свои пути единиц. Регистр — по правилу тома: Windows/macOS свёрнуты, Linux
 * точен. Пути репозиториев здесь не существуют — правило тома берётся из ОС (`foldsCaseAt`), так
 * тест одинаков на любой машине; настоящий Linux — в контейнере (`tools/core-linux.mjs`).
 */

const MIGRATIONS = { globs: ['migrations/**'], ops: ['edit' as const] };

describe('grant confirmations up front', () => {
  it('lists only rows of the task repos whose globs meet an owned path, with the owned paths matched', () => {
    const repos = [{ repoKey: 'app', path: '/nowhere/w/app' }];
    const got = grantConfirmations(
      [
        { project: '/nowhere/w/app', ...MIGRATIONS },
        { project: '/nowhere/w/app', globs: ['infra/**'], ops: ['exec-db'] },
        { project: '/nowhere/w/other', ...MIGRATIONS },
      ],
      repos,
      ['src/**', 'migrations/2026', 'docs/readme.md'],
      'linux',
    );
    expect(got).toEqual([
      {
        repoKey: 'app',
        globs: ['migrations/**'],
        ops: ['edit'],
        matchedOwnedPaths: ['migrations/2026'],
      },
    ]);
  });

  it('an owned "**" meets every glob; an anywhere glob (*.sql) meets every owned directory; a literal file outside does not', () => {
    const repos = [{ repoKey: 'app', path: '/nowhere/app' }];
    const rows = [{ project: '/nowhere/app', globs: ['*.sql'], ops: ['edit' as const] }];
    expect(grantConfirmations(rows, repos, ['**'], 'linux')[0]?.matchedOwnedPaths).toEqual(['**']);
    expect(
      grantConfirmations(rows, repos, ['db', 'src/a.sql'], 'linux')[0]?.matchedOwnedPaths,
    ).toEqual(['db', 'src/a.sql']);
    const claude = [{ project: '/nowhere/app', globs: ['.claude/**'], ops: ['edit' as const] }];
    expect(grantConfirmations(claude, repos, ['src/**', 'README.md'], 'linux')).toEqual([]);
    expect(grantConfirmations(claude, repos, ['.claude/settings.json'], 'linux')).toHaveLength(1);
    expect(grantConfirmations(claude, repos, ['.claude'], 'linux')).toHaveLength(1);
  });

  it('R7 case: Windows folds the glob and the project path, Linux matches exactly', () => {
    const owned = ['.claude/settings.json'];
    const rowWin = [{ project: 'C:\\Nowhere\\App', globs: ['.Claude/**'], ops: ['edit' as const] }];
    expect(
      grantConfirmations(rowWin, [{ repoKey: 'app', path: 'C:\\nowhere\\app' }], owned, 'win32'),
    ).toEqual([{ repoKey: 'app', globs: ['.Claude/**'], ops: ['edit'], matchedOwnedPaths: owned }]);
    const rowLinux = [{ project: '/nowhere/app', globs: ['.Claude/**'], ops: ['edit' as const] }];
    expect(
      grantConfirmations(rowLinux, [{ repoKey: 'app', path: '/nowhere/app' }], owned, 'linux'),
    ).toEqual([]);
  });

  // Путь проекта сворачивает `pathKey` по настоящему тому: на Windows `/` — это `C:\`, и
  // «Linux» там не изобразить — только в контейнере.
  it.runIf(process.platform === 'linux')(
    'R7 on a real case-sensitive Linux volume a project path differing in case is another repository',
    () => {
      expect(
        grantConfirmations(
          [{ project: '/Nowhere/App', globs: ['.claude/**'], ops: ['edit'] }],
          [{ repoKey: 'app', path: '/nowhere/app' }],
          ['.claude/settings.json'],
        ),
      ).toEqual([]);
    },
  );
});
