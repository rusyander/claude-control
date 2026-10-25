import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SIEVES,
  judgeSieves,
  staleSieveIds,
  touchesSieve,
  type SieveDef,
  type SieveReportRow,
} from '@agentdeck/contracts/sieves';

/**
 * Строка `project-checks` утверждает: все проверки проекта, тесты тоже, прошли на последнем
 * коммите. Правка ТЕСТА после строки делает это неправдой — строку надо сдать заново (решение
 * 25.10). Данные фикстур, доки, `.agent/` и прочее, что строку держало, держат её и дальше;
 * остальные сита тестовой правкой не открываются.
 */

const sieve = (id: string): SieveDef => BUILTIN_SIEVES.find((item) => item.id === id)!;
const checks = sieve('project-checks');
const row = (id: string): SieveReportRow => ({
  id,
  status: 'pass',
  evidence: 'pnpm lint → 0 problems; pnpm test → 214 passed',
  at: '2026-10-24T21:00:00Z',
});

/** Тестовые пути, которые открывают строку проверок проекта. */
const TEST_EDITS = [
  'inst-chat-ui/src/components/Chat.test.tsx',
  'inst-chat-ui/src/components/Chat.spec.ts',
  'apps/web/src/__tests__/a.ts',
  'inst-docs-ui/e2e/login.spec.ts',
  'e2e/smoke.ts',
  'api/handlers/user_test.go',
  'api/tests/test_user.py',
];
/** Что строку держит сегодня — держит и после. */
const KEEPS = [
  '.agent/tmp/notes.md',
  '.agent/tests/a.test.ts',
  'inst-docs-ui/docs/guide.mdx',
  'README.md',
  'inst-docs-ui/e2e/fixtures/api.json',
  'e2e/fixtures/users.ts',
  'apps/web/src/__tests__/__fixtures__/user.ts',
  'tests/fixtures/data.json',
  'e2e/README.md',
  'tests/snapshots/a.snap',
];
/** Код открывает строку, как и раньше. */
const CODE = ['inst-chat-ui/src/components/Chat.tsx', 'scripts/check_frontend.mjs', 'api/user.go'];

describe('сито project-checks: правка теста после строки открывает её заново', () => {
  it('тестовые пути и код — открывают; доки, .agent, фикстуры и данные — нет', () => {
    for (const path of TEST_EDITS) expect(touchesSieve(checks, [path]), path).toEqual([path]);
    for (const path of CODE) expect(touchesSieve(checks, [path]), path).toEqual([path]);
    for (const path of KEEPS) expect(touchesSieve(checks, [path]), path).toEqual([]);
  });

  it('судья: правка теста после строки — пробел «устарела», правка доков — строка в силе', () => {
    const applicable = [checks];
    const rows = [row('project-checks')];
    const stale = judgeSieves({
      applicable,
      rows,
      mechanics: {},
      proof: { changedAfterRow: { 'project-checks': ['src/a.test.ts', 'README.md'] } },
    });
    expect(stale).toEqual([
      { code: 'sieve-gap-stale', params: { sieve: 'project-checks', files: 'src/a.test.ts' } },
    ]);
    const kept = judgeSieves({
      applicable,
      rows,
      mechanics: {},
      proof: { changedAfterRow: { 'project-checks': ['README.md', 'e2e/fixtures/api.json'] } },
    });
    expect(kept).toEqual([]);
    expect(staleSieveIds(applicable, { 'project-checks': ['e2e/login.spec.ts'] })).toEqual([
      'project-checks',
    ]);
  });

  it('другие сита тестовой правкой не открываются (browser-focus, tests-alongside)', () => {
    for (const id of ['browser-focus', 'tests-alongside', 'boundary-negative']) {
      expect(touchesSieve(sieve(id), ['src/a.test.ts', 'e2e/login.spec.ts']), id).toEqual([]);
    }
  });
});
