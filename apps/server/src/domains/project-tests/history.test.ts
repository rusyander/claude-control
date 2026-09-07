import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { historyOf } from './history.ts';
import { createGroup, upsertCase } from './store.ts';

/**
 * История файла кейсов из git. Проверяется то, ради чего она заведена вместо
 * своего механизма версий: коммиты видны в обратном порядке с автором и
 * объёмом правки, а проект без git отвечает пустотой, а не ошибкой.
 */
describe('project-tests/history', () => {
  let project = '';

  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: project, stdio: 'ignore' });
  };

  const commit = (message: string): void => {
    git('add', '-A');
    git('-c', 'user.email=qa@example.com', '-c', 'user.name=QA', 'commit', '-m', message);
  };

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'cc-tests-history-'));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('каталог без git — пустая история, а не ошибка', () => {
    createGroup(project, 'gui', 'GUI');

    expect(historyOf(project, 'gui')).toEqual([]);
  });

  it('коммиты файла группы читаются от новых к старым с автором и объёмом', () => {
    git('init', '-q', '-b', 'main');
    createGroup(project, 'gui', 'GUI');
    commit('кейсы: завели группу');
    upsertCase(project, 'gui', { title: 'Вход', steps: [] }, '2026-09-07T10:00:00.000Z');
    commit('кейсы: добавили вход');

    const entries = historyOf(project, 'gui');

    expect(entries.map((entry) => entry.subject)).toEqual([
      'кейсы: добавили вход',
      'кейсы: завели группу',
    ]);
    expect(entries[0]?.author).toBe('QA');
    expect(entries[0]?.hash).toHaveLength(8);
    expect(entries[0]?.added).toBeGreaterThan(0);
  });

  it('не закоммиченный файл истории не имеет', () => {
    git('init', '-q', '-b', 'main');
    createGroup(project, 'gui', 'GUI');

    expect(historyOf(project, 'gui')).toEqual([]);
  });
});
