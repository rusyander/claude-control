import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCaseCodePaths } from '../../platform/tests-store.ts';
import { casesByFile, coverageMap, coveredFact, pathCovers } from './index.ts';

/**
 * Карта покрытия кейсами (G18) на настоящем каталоге блока тестов: `codePaths` — файл или каталог
 * над файлом; архивный кейс не в счёт; нет каталога или битая группа — `unknown` с причиной,
 * никогда «покрыто».
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function project(groups: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'core-cov-'));
  roots.push(root);
  if (Object.keys(groups).length === 0) return root;
  mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
  for (const [name, body] of Object.entries(groups))
    writeFileSync(
      join(root, '.agent', 'tests', `${name}.tests.json`),
      typeof body === 'string' ? body : JSON.stringify(body),
    );
  return root;
}

const CHANGED = ['src/a.ts', 'src/ab.ts', 'lib/b.ts', 'docs/x.md'];

describe('case coverage map', () => {
  it('pathCovers: the file itself or a directory above it, never a name prefix', () => {
    expect(pathCovers('src/a.ts', 'src/a.ts')).toBe(true);
    expect(pathCovers('src', 'src/a.ts')).toBe(true);
    expect(pathCovers('./src/', 'src/a.ts')).toBe(true);
    expect(pathCovers('src\\a.ts', 'src/a.ts')).toBe(true);
    expect(pathCovers('src/a', 'src/ab.ts')).toBe(false);
    expect(pathCovers('', 'src/a.ts')).toBe(false);
  });

  it('cases of every group map to the changed files they name; archived cases do not count', () => {
    const root = project({
      core: {
        cases: [
          { id: 'core-001', codePaths: ['src/a.ts'] },
          { id: 'core-002', codePaths: ['lib'], archived: true },
        ],
      },
      web: { cases: [{ id: 'web-001', codePaths: ['src'] }, { id: 'web-002' }] },
    });
    const store = readCaseCodePaths(root);
    expect(store).toEqual({
      value: [
        { groupId: 'core', caseId: 'core-001', codePaths: ['src/a.ts'] },
        { groupId: 'web', caseId: 'web-001', codePaths: ['src'] },
        { groupId: 'web', caseId: 'web-002', codePaths: [] },
      ],
    });
    if (!('value' in store)) throw new Error('store');
    expect(casesByFile(CHANGED, store.value)).toEqual({
      'src/a.ts': ['core:core-001', 'web:web-001'],
      'src/ab.ts': ['web:web-001'],
    });
    expect(coveredFact(CHANGED, store, 'r1')).toEqual({ value: ['src/a.ts', 'src/ab.ts'] });
  });

  it('no tests block → unknown naming the project, never covered', () => {
    const store = readCaseCodePaths(project({}));
    expect(store).toEqual({ absent: true });
    expect(coveredFact(CHANGED, store, 'r1')).toEqual({
      unknown: 'no tests block in r1 (.agent/tests absent)',
    });
    expect(coverageMap(CHANGED, store, 'r1')).toEqual({
      unknown: 'no tests block in r1 (.agent/tests absent)',
    });
  });

  it('a broken group file → unknown naming the file, not a partial map', () => {
    const root = project({ good: { cases: [{ id: 'g-1', codePaths: ['src'] }] }, zbad: '{nope' });
    const store = readCaseCodePaths(root);
    expect(store).toEqual({ unknown: expect.stringContaining('zbad.tests.json') });
    expect(coveredFact(CHANGED, store, 'r1')).toEqual({
      unknown: expect.stringContaining('tests block of r1: zbad.tests.json'),
    });
    const noList = readCaseCodePaths(project({ odd: { version: 1 } }));
    expect(noList).toEqual({ unknown: 'odd.tests.json: no cases list' });
  });
});
