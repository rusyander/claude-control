import { describe, expect, it } from 'vitest';
import { matchesAny, matchesGlob } from './glob.ts';

/**
 * Маска в духе `.gitignore` (06 §grantRequired, core-s2 F-06): маска без `/` — имя на любой
 * глубине, ведущий `/` — привязка к корню, `**` — любые каталоги. Свои пути единицы — от корня
 * копии (`rooted`): `src` не означает чужой `pkg/src`.
 */

describe('matchesGlob — .gitignore semantics', () => {
  it.each([
    ['*.sql', 'db/x.sql', true],
    ['*.sql', 'x.sql', true],
    ['.env', 'apps/a/.env', true],
    ['.env', '.env', true],
    ['.env', 'apps/a/.env/inner', true],
    ['secrets', 'deep/secrets/key.pem', true],
    ['/migrations', 'migrations/1.sql', true],
    ['/migrations', 'db/migrations/1.sql', false],
    ['/*.sql', 'x.sql', true],
    ['/*.sql', 'db/x.sql', false],
    ['migrations/**', 'migrations/1.sql', true],
    ['migrations/**', 'db/migrations/1.sql', false],
    ['db/*.sql', 'db/x.sql', true],
    ['db/*.sql', 'a/db/x.sql', false],
    ['**/db/*.sql', 'a/db/x.sql', true],
    ['config/', 'config/app.yml', true],
    ['x[0-9].sql', 'a/x7.sql', true],
    ['x[!0-9].sql', 'a/x7.sql', false],
    ['*.sql', 'db/x.sqlite', false],
  ])('%s vs %s → %s', (glob, path, want) => {
    expect(matchesGlob(path, glob)).toBe(want);
  });

  it('folds case only when asked', () => {
    expect(matchesGlob('DB/X.SQL', '*.sql', true)).toBe(true);
    expect(matchesGlob('DB/X.SQL', '*.sql')).toBe(false);
  });

  it('rooted lists keep the copy-root anchor', () => {
    expect(matchesAny('src/a.ts', ['src'], false, 'rooted')).toBe(true);
    expect(matchesAny('pkg/src/a.ts', ['src'], false, 'rooted')).toBe(false);
    expect(matchesAny('pkg/src/a.ts', ['src'])).toBe(true);
  });
});
