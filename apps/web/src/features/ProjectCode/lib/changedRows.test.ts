import { describe, expect, it } from 'vitest';
import { changedRows, firstOpenable } from './changedRows';

/**
 * Список изменённых собирается из двух источников, и цена ошибки здесь — не
 * косметика: до правки окно показывало «изменений нет» над репозиторием с
 * двумя десятками правленых файлов.
 */
describe('changedRows: правки агента и рабочее дерево одним списком', () => {
  const agent = [
    { path: 'src/a.ts', added: 3, removed: 1, missing: false },
    { path: 'src/gone.ts', added: 0, removed: 0, missing: true },
  ];
  const git = [
    { path: 'src/a.ts', status: 'modified' as const, staged: true },
    { path: 'TASKS.md', status: 'modified' as const, staged: false },
    { path: 'new.md', status: 'untracked' as const, staged: false },
  ];

  it('сначала разговор, потом остальное рабочее дерево', () => {
    const rows = changedRows(agent, git);
    expect(rows.map((row) => row.path)).toEqual(['src/a.ts', 'src/gone.ts', 'TASKS.md', 'new.md']);
    expect(rows.map((row) => row.source)).toEqual(['agent', 'agent', 'git', 'git']);
  });

  it('один файл не двоится: строка агента забирает состояние git', () => {
    const rows = changedRows(agent, git);
    const both = rows.filter((row) => row.path === 'src/a.ts');
    expect(both).toHaveLength(1);
    expect(both[0]).toMatchObject({ source: 'agent', added: 3, removed: 1, status: 'modified' });
    expect(both[0]?.staged).toBe(true);
  });

  it('без правок агента остаётся чистый git — ради этого всё и делалось', () => {
    const rows = changedRows([], git);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.source === 'git')).toBe(true);
    // Строк у файла вне разговора нет: считать их не по чему.
    expect(rows[0]?.added).toBeUndefined();
  });

  it('без git остаётся прежнее поведение: только правки разговора', () => {
    const rows = changedRows(agent, undefined);
    expect(rows.map((row) => row.path)).toEqual(['src/a.ts', 'src/gone.ts']);
    expect(rows[1]?.missing).toBe(true);
  });

  it('оба источника пусты — список пуст, а не строка-призрак', () => {
    expect(changedRows(undefined, undefined)).toEqual([]);
  });
});

describe('firstOpenable: чем окно открывается само', () => {
  it('пропускает то, чего на диске нет', () => {
    const rows = changedRows(
      [{ path: 'src/gone.ts', added: 0, removed: 0, missing: true }],
      [{ path: 'src/a.ts', status: 'modified', staged: false }],
    );
    expect(firstOpenable(rows)).toBe('src/a.ts');
  });

  it('пропускает удалённый в git: открывать нечего', () => {
    const rows = changedRows(undefined, [
      { path: 'src/removed.ts', status: 'deleted', staged: true },
      { path: 'src/b.ts', status: 'modified', staged: false },
    ]);
    expect(firstOpenable(rows)).toBe('src/b.ts');
  });

  it('открывать нечего — undefined, а не первый попавшийся', () => {
    expect(firstOpenable([])).toBeUndefined();
  });
});
