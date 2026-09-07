import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changedFiles, gitContext, impactOf } from './impact.ts';
import { createGroup, readGroups, upsertCase } from './store.ts';

/**
 * Отбор по диффу: какие кейсы задеты тем, что лежит в рабочей копии.
 *
 * Проверяется главное свойство — НЕ ГАДАТЬ: не репозиторий или нет изменений
 * значит пустой список, а не «на всякий случай прогони всё». Иначе «прогнать
 * задетое» молча превращалось бы в часовой полный регресс.
 */
describe('project-tests/impact', () => {
  let project = '';

  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: project, stdio: 'ignore' });
  };

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'cc-tests-impact-'));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('каталог без git — пустой отбор, а не весь набор', () => {
    createGroup(project, 'gui', 'GUI');
    upsertCase(project, 'gui', { title: 'Вход', steps: [] }, '2026-09-07T10:00:00.000Z');

    expect(changedFiles(project)).toEqual([]);
    expect(impactOf(project, readGroups(project))).toEqual({ files: [], cases: [] });
    expect(gitContext(project)).toEqual({ branch: undefined, commit: undefined });
  });

  it('кейс отбирается по codePaths, а без них — по совпадению зоны', () => {
    git('init', '-q');
    createGroup(project, 'gui', 'GUI');
    upsertCase(
      project,
      'gui',
      { title: 'Отправка', steps: [], codePaths: ['src/pages/Chat'] },
      '2026-09-07T10:00:00.000Z',
    );
    upsertCase(
      project,
      'gui',
      { title: 'Аналитика', steps: [], area: 'analytics' },
      '2026-09-07T10:00:00.000Z',
    );
    upsertCase(project, 'gui', { title: 'Ничей', steps: [] }, '2026-09-07T10:00:00.000Z');

    mkdirSync(join(project, 'src', 'pages', 'Chat'), { recursive: true });
    writeFileSync(join(project, 'src', 'pages', 'Chat', 'ChatPage.tsx'), 'x');
    mkdirSync(join(project, 'src', 'analytics'), { recursive: true });
    writeFileSync(join(project, 'src', 'analytics', 'report.ts'), 'x');

    const impact = impactOf(project, readGroups(project));

    expect(impact.files.length).toBeGreaterThan(0);
    expect(impact.cases.map((item) => item.caseId).sort()).toEqual(['gui-001', 'gui-002']);
    // Причина видна человеку: прямая привязка и слабое совпадение зоны — разные вещи.
    expect(impact.cases.find((item) => item.caseId === 'gui-001')?.reason).toContain(
      'src/pages/Chat',
    );
    expect(impact.cases.find((item) => item.caseId === 'gui-002')?.reason).toContain('analytics');
  });

  it('правки самих кейсов отбор не считают изменением приложения', () => {
    git('init', '-q');
    createGroup(project, 'gui', 'GUI');
    upsertCase(
      project,
      'gui',
      { title: 'Вход', steps: [], codePaths: ['.agent/tests'] },
      '2026-09-07T10:00:00.000Z',
    );

    expect(impactOf(project, readGroups(project)).cases).toEqual([]);
  });
});
