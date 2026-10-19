import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TASK_NOTEBOOK, seedTaskNotebook } from './task-notebook.ts';

/**
 * Тетрадь задачи (9.2) на настоящем git: путь к опасности — не файл, а то, что
 * доставка группы делает `git add -A` и что копию потом удаляют. Поэтому
 * проверяется сам git, а не содержимое `.gitignore`.
 */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout;
}

/** Репозиторий с одним коммитом и копией (worktree) группы. */
function repoWithCopy(): { repo: string; copy: string } {
  const root = mkdtempSync(join(tmpdir(), 'task-notebook-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const copy = join(root, 'copy');
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.email=x@y', '-c', 'user.name=x', 'commit', '-qm', 'init');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', copy);
  return { repo, copy };
}

describe('тетрадь задачи', () => {
  it('заводится с тем, что нашёл разбор, и не попадает в git add -A доставки', () => {
    const { copy } = repoWithCopy();

    expect(seedTaskNotebook(copy, 'Map of places from the triage:\nsrc/a.ts:1', 'Вход')).toBe(true);

    const text = readFileSync(join(copy, TASK_NOTEBOOK), 'utf8');
    expect(text).toContain('never a secret');
    expect(text).toContain('src/a.ts:1');
    git(copy, 'add', '-A');
    expect(git(copy, 'status', '--porcelain')).toBe('');
  });

  it('уже заведённую не перезаписывает: записанное агентом дороже посева', () => {
    const { copy } = repoWithCopy();
    seedTaskNotebook(copy, 'первый посев', 'Вход');
    const file = join(copy, TASK_NOTEBOOK);
    writeFileSync(file, `${readFileSync(file, 'utf8')}- стенд: http://localhost:8888\n`);

    expect(seedTaskNotebook(copy, 'второй посев', 'Вход')).toBe(false);

    const text = readFileSync(file, 'utf8');
    expect(text).toContain('стенд: http://localhost:8888');
    expect(text).not.toContain('второй посев');
  });

  /** Ревью A1-F6/B1-F4: без git группы делят каталог, и посев второй терялся за первым. */
  it('общий каталог: раздел каждой группы дописан, свой второй раз не пишется', () => {
    const root = mkdtempSync(join(tmpdir(), 'task-notebook-plain-'));
    roots.push(root);
    expect(seedTaskNotebook(root, 'карта входа', 'Вход')).toBe(true);
    const file = join(root, TASK_NOTEBOOK);
    writeFileSync(file, `${readFileSync(file, 'utf8')}- порт стенда 8888\n`);
    expect(seedTaskNotebook(root, 'карта отчётов', 'Отчёты')).toBe(true);
    expect(seedTaskNotebook(root, 'карта входа ещё раз', 'Вход')).toBe(false);

    const text = readFileSync(file, 'utf8');
    expect(text).toContain('## From the panel at the start — Вход\n\nкарта входа');
    expect(text).toContain('## From the panel at the start — Отчёты\n\nкарта отчётов');
    expect(text).toContain('- порт стенда 8888');
    expect(text).not.toContain('ещё раз');
    expect(text.match(/never a secret/g)).toHaveLength(1);
  });

  it('без заметок — только заголовок, без пустого раздела', () => {
    const { copy } = repoWithCopy();

    seedTaskNotebook(copy, '  ', 'Вход');

    expect(readFileSync(join(copy, TASK_NOTEBOOK), 'utf8')).not.toContain('## From the panel');
  });

  it('копия с тетрадью удаляется обычным git worktree remove, без --force', () => {
    const { repo, copy } = repoWithCopy();
    seedTaskNotebook(copy, 'заметка', 'Вход');

    git(repo, 'worktree', 'remove', copy);

    expect(existsSync(copy)).toBe(false);
  });

  it('имя агентское (.agent.md): слой правил даёт агенту писать в тетрадь через Write', () => {
    expect(TASK_NOTEBOOK).toMatch(/\/notebook\.agent\.md$/);
  });

  it('тетрадь под старым именем notebook.md переезжает целиком, посев дописывается к ней', () => {
    const { copy } = repoWithCopy();
    const legacy = join(copy, TASK_NOTEBOOK.replace(/notebook\.agent\.md$/, 'notebook.md'));
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, '# Task notebook\n\n- вход на стенд: admin\n');

    seedTaskNotebook(copy, 'карта отчётов', 'Отчёты');

    expect(existsSync(legacy)).toBe(false);
    const text = readFileSync(join(copy, TASK_NOTEBOOK), 'utf8');
    expect(text).toContain('- вход на стенд: admin');
    expect(text).toContain('## From the panel at the start — Отчёты\n\nкарта отчётов');
    expect(text.match(/# Task notebook/g)).toHaveLength(1);
  });
});
