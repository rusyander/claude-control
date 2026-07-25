import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  GitError,
  checkoutBranch,
  commitAll,
  createBranch,
  isGitRepo,
  parseBranches,
  parseStatus,
  readProjectGit,
} from './project-git.ts';

/**
 * Git проекта (группа 7). Разбор вывода проверяется на строках, а сами операции
 * — на НАСТОЯЩЕМ репозитории во временном каталоге: подделка git здесь ничего не
 * доказала бы, а цена ошибки в чужом репозитории велика.
 *
 * Нет git в PATH (сборочный контейнер) — блок операций пропускается честно, а не
 * притворяется зелёным.
 */

/**
 * Снос временного каталога. На Windows git и запущенные процессы держат хендлы
 * дольше, чем живёт тест, поэтому неудача уборки — не провал проверки: каталог
 * лежит в temp и уйдёт с ОС.
 */
function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста это не влияет.
  }
}

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = hasGit();

describe('parseStatus: разбор git status --porcelain=v2 --branch', () => {
  it('ветка, чистое дерево', () => {
    const out = '# branch.oid abc123\n# branch.head main\n# branch.upstream origin/main\n';
    expect(parseStatus(out)).toEqual({
      branch: 'main',
      detached: false,
      unborn: false,
      dirtyCount: 0,
    });
  });

  it('считает изменённые файлы и не считает заголовки', () => {
    const out = [
      '# branch.oid abc123',
      '# branch.head feature/x',
      '1 .M N... 100644 100644 100644 aaa bbb file.ts',
      '? new.txt',
      'u UU N... 100644 100644 100644 100644 a b c d conflict.ts',
      '',
    ].join('\n');
    const parsed = parseStatus(out);
    expect(parsed.branch).toBe('feature/x');
    expect(parsed.dirtyCount).toBe(3);
  });

  it('detached HEAD — ветки нет', () => {
    const parsed = parseStatus('# branch.oid abc\n# branch.head (detached)\n');
    expect(parsed.detached).toBe(true);
    expect(parsed.branch).toBeUndefined();
  });

  it('репозиторий без коммитов помечается unborn', () => {
    const parsed = parseStatus('# branch.oid (initial)\n# branch.head main\n');
    expect(parsed.unborn).toBe(true);
  });

  it('CRLF в выводе не ломает разбор', () => {
    const parsed = parseStatus('# branch.oid abc\r\n# branch.head main\r\n? new.txt\r\n');
    expect(parsed.branch).toBe('main');
    expect(parsed.dirtyCount).toBe(1);
  });
});

describe('parseBranches: список локальных веток', () => {
  it('пусто и по алфавиту', () => {
    expect(parseBranches('')).toEqual([]);
    expect(parseBranches('main\nfeature/b\nfeature/a\n')).toEqual([
      'feature/a',
      'feature/b',
      'main',
    ]);
  });
});

describe('isGitRepo: раздел появляется только при .git', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cc-git-'))));
  afterEach(() => dropTemp(dir));

  it('обычный каталог — не репозиторий, и чтение отвечает isRepo:false', async () => {
    expect(isGitRepo(dir)).toBe(false);
    const info = await readProjectGit(dir);
    expect(info).toEqual({
      isRepo: false,
      detached: false,
      unborn: false,
      branches: [],
      dirtyCount: 0,
    });
  });

  it('.git ФАЙЛОМ (рабочее дерево worktree) тоже считается репозиторием', () => {
    writeFileSync(join(dir, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n');
    expect(isGitRepo(dir)).toBe(true);
  });

  it('.git каталогом — репозиторий', () => {
    mkdirSync(join(dir, '.git'));
    expect(isGitRepo(dir)).toBe(true);
  });
});

describe.skipIf(!GIT_AVAILABLE)('операции на настоящем репозитории', { timeout: 30_000 }, () => {
  let dir: string;

  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-git-real-'));
    git('init', '--initial-branch=main');
    // Личность коммиттера только в этом репозитории: глобальный конфиг машины
    // тест не трогает.
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'readme.md'), 'hello\n');
    git('add', '-A');
    git('commit', '-m', 'first');
  });
  afterEach(() => dropTemp(dir));

  it('читает текущую ветку, список веток и число изменений', async () => {
    const clean = await readProjectGit(dir);
    expect(clean.isRepo).toBe(true);
    expect(clean.branch).toBe('main');
    expect(clean.branches).toEqual(['main']);
    expect(clean.dirtyCount).toBe(0);

    writeFileSync(join(dir, 'new.txt'), 'x');
    expect((await readProjectGit(dir)).dirtyCount).toBe(1);
  });

  it('создаёт ветку и переключается между ветками', async () => {
    await createBranch(dir, 'feature/panel');
    const after = await readProjectGit(dir);
    expect(after.branch).toBe('feature/panel');
    expect(after.branches).toEqual(['feature/panel', 'main']);

    await checkoutBranch(dir, 'main');
    expect((await readProjectGit(dir)).branch).toBe('main');
  });

  it('коммитит все изменения рабочего дерева', async () => {
    writeFileSync(join(dir, 'new.txt'), 'x');
    await commitAll(dir, 'через панель');
    const after = await readProjectGit(dir);
    expect(after.dirtyCount).toBe(0);
  });

  it('отказы: чужая ветка, дубль имени, пустой коммит, кривое имя', async () => {
    await expect(checkoutBranch(dir, 'origin/main')).rejects.toBeInstanceOf(GitError);
    await expect(createBranch(dir, 'main')).rejects.toBeInstanceOf(GitError);
    await expect(commitAll(dir, 'нечего коммитить')).rejects.toBeInstanceOf(GitError);
    await expect(createBranch(dir, 'с пробелом')).rejects.toBeInstanceOf(GitError);
    await expect(createBranch(dir, '-r')).rejects.toBeInstanceOf(GitError);
    await expect(createBranch(dir, 'плохая..ветка')).rejects.toBeInstanceOf(GitError);
    await expect(commitAll(dir, '   ')).rejects.toBeInstanceOf(GitError);
  });

  it('запись в каталог без .git — отказ, а не попытка угадать', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cc-git-plain-'));
    try {
      await expect(commitAll(plain, 'x')).rejects.toBeInstanceOf(GitError);
      await expect(createBranch(plain, 'x')).rejects.toBeInstanceOf(GitError);
      await expect(checkoutBranch(plain, 'x')).rejects.toBeInstanceOf(GitError);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('имя ветки не может стать командой: аргументы идут массивом', async () => {
    // Точка входа для инъекции была бы здесь: имя уходит в git как один
    // аргумент, оболочки нет — поэтому это просто негодное имя ветки.
    await expect(createBranch(dir, 'x; rm -rf /')).rejects.toBeInstanceOf(GitError);
    expect((await readProjectGit(dir)).branches).toEqual(['main']);
  });
});
