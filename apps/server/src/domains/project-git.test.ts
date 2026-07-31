import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CHANGED_FILES_MAX,
  GitError,
  checkoutBranch,
  commitAll,
  createBranch,
  isGitRepo,
  parseBranches,
  parseRemoteBranches,
  parseStatus,
  pickRemote,
  pullChanges,
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

/** Записи `--porcelain=v2 -z` разделены NUL, а не переводом строки. */
const z = (...entries: string[]): string => entries.map((entry) => `${entry}\0`).join('');

describe('parseStatus: разбор git status --porcelain=v2 --branch -z', () => {
  it('ветка, чистое дерево', () => {
    const out = z('# branch.oid abc123', '# branch.head main', '# branch.upstream origin/main');
    expect(parseStatus(out)).toEqual({
      branch: 'main',
      detached: false,
      unborn: false,
      dirtyCount: 0,
      changedFiles: [],
      changedFilesTruncated: false,
      ahead: undefined,
      behind: undefined,
    });
  });

  it('считает изменённые файлы и не считает заголовки', () => {
    const out = z(
      '# branch.oid abc123',
      '# branch.head feature/x',
      '1 .M N... 100644 100644 100644 aaa bbb file.ts',
      '? new.txt',
      'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
    );
    const parsed = parseStatus(out);
    expect(parsed.branch).toBe('feature/x');
    expect(parsed.dirtyCount).toBe(3);
  });

  it('отдаёт сами файлы: путь, состояние и есть ли правка в индексе', () => {
    const out = z(
      '# branch.head main',
      '1 .M N... 100644 100644 100644 aaa bbb src/file.ts',
      '1 A. N... 100644 100644 100644 aaa bbb src/added.ts',
      '1 .D N... 100644 100644 100644 aaa bbb gone.ts',
      '? new.txt',
      'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
    );
    expect(parseStatus(out).changedFiles).toEqual([
      { path: 'src/file.ts', status: 'modified', staged: false },
      { path: 'src/added.ts', status: 'added', staged: true },
      { path: 'gone.ts', status: 'deleted', staged: false },
      { path: 'new.txt', status: 'untracked', staged: false },
      { path: 'conflict.ts', status: 'conflict', staged: false },
    ]);
  });

  it('переименование: прежний путь лежит СЛЕДУЮЩИМ полем и не считается вторым файлом', () => {
    const out = z(
      '# branch.head main',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new/name.ts',
      'old/name.ts',
      '? after.txt',
    );
    const parsed = parseStatus(out);
    expect(parsed.dirtyCount).toBe(2);
    expect(parsed.changedFiles).toEqual([
      { path: 'new/name.ts', status: 'renamed', staged: true, from: 'old/name.ts' },
      { path: 'after.txt', status: 'untracked', staged: false },
    ]);
  });

  it('пробелы и кириллица в пути доезжают целиком — ради этого и взят -z', () => {
    const out = z(
      '# branch.head main',
      '1 .M N... 100644 100644 100644 aaa bbb docs/мой файл.md',
      '? новая папка/файл с пробелом.txt',
    );
    expect(parseStatus(out).changedFiles.map((file) => file.path)).toEqual([
      'docs/мой файл.md',
      'новая папка/файл с пробелом.txt',
    ]);
  });

  it('расхождение с upstream: впереди и позади', () => {
    const parsed = parseStatus(z('# branch.head main', '# branch.ab +2 -5'));
    expect(parsed.ahead).toBe(2);
    expect(parsed.behind).toBe(5);
  });

  it('список обрезается по потолку, но счётчик остаётся полным', () => {
    const entries = ['# branch.head main'];
    for (let index = 0; index < CHANGED_FILES_MAX + 7; index += 1) {
      entries.push(`? file-${index}.txt`);
    }
    const parsed = parseStatus(z(...entries));
    expect(parsed.dirtyCount).toBe(CHANGED_FILES_MAX + 7);
    expect(parsed.changedFiles).toHaveLength(CHANGED_FILES_MAX);
    expect(parsed.changedFilesTruncated).toBe(true);
  });

  it('detached HEAD — ветки нет', () => {
    const parsed = parseStatus(z('# branch.oid abc', '# branch.head (detached)'));
    expect(parsed.detached).toBe(true);
    expect(parsed.branch).toBeUndefined();
  });

  it('репозиторий без коммитов помечается unborn', () => {
    const parsed = parseStatus(z('# branch.oid (initial)', '# branch.head main'));
    expect(parsed.unborn).toBe(true);
  });

  it('игнорируемый файл изменением не считается', () => {
    const parsed = parseStatus(z('# branch.head main', '! dist/bundle.js', '? real.txt'));
    expect(parsed.dirtyCount).toBe(1);
    expect(parsed.changedFiles).toEqual([{ path: 'real.txt', status: 'untracked', staged: false }]);
  });
});

describe('pickRemote / parseRemoteBranches: откуда тянуть', () => {
  it('origin выигрывает, иначе первый по алфавиту, пусто — undefined', () => {
    expect(pickRemote('upstream\norigin\n')).toBe('origin');
    expect(pickRemote('zeta\nalpha\n')).toBe('alpha');
    expect(pickRemote('')).toBeUndefined();
  });

  it('ветки выбранного удалённого, без префикса и без HEAD', () => {
    const refs = 'origin/HEAD\norigin/main\norigin/feature/b\nupstream/main\n';
    expect(parseRemoteBranches(refs, 'origin')).toEqual(['feature/b', 'main']);
    expect(parseRemoteBranches(refs, 'upstream')).toEqual(['main']);
    expect(parseRemoteBranches(refs, undefined)).toEqual([]);
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
      changedFiles: [],
      remoteBranches: [],
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

  it('изменённые файлы приезжают списком, а не только числом', async () => {
    writeFileSync(join(dir, 'new.txt'), 'x');
    writeFileSync(join(dir, 'readme.md'), 'changed\n');
    const info = await readProjectGit(dir);
    expect(info.dirtyCount).toBe(2);
    expect([...info.changedFiles].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'new.txt', status: 'untracked', staged: false },
      { path: 'readme.md', status: 'modified', staged: false },
    ]);
  });

  it('без удалённых pull отказывает, а не идёт в сеть наугад', async () => {
    const info = await readProjectGit(dir);
    expect(info.remote).toBeUndefined();
    expect(info.remoteBranches).toEqual([]);
    await expect(pullChanges(dir, 'main')).rejects.toBeInstanceOf(GitError);
  });
});

/**
 * Pull проверяется на паре настоящих репозиториев: «удалённый» — это голый
 * репозиторий в temp, а не сеть. Подделывать здесь нечего: смысл проверки
 * именно в том, что команда действительно приносит чужой коммит.
 */
describe.skipIf(!GIT_AVAILABLE)('pull на настоящих репозиториях', { timeout: 60_000 }, () => {
  let root: string;
  let dir: string;
  let other: string;

  const run = (cwd: string, ...args: string[]): void => {
    execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
  };
  const identify = (cwd: string): void => {
    run(cwd, 'config', 'user.email', 'test@example.invalid');
    run(cwd, 'config', 'user.name', 'Test');
    run(cwd, 'config', 'commit.gpgsign', 'false');
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-git-pull-'));
    const bare = join(root, 'origin.git');
    dir = join(root, 'work');
    other = join(root, 'other');

    execFileSync('git', ['init', '--bare', '--initial-branch=main', bare], {
      stdio: 'ignore',
      windowsHide: true,
    });
    execFileSync('git', ['clone', bare, dir], { stdio: 'ignore', windowsHide: true });
    identify(dir);
    writeFileSync(join(dir, 'readme.md'), 'hello\n');
    run(dir, 'add', '-A');
    run(dir, 'commit', '-m', 'first');
    run(dir, 'push', '-u', 'origin', 'main');

    execFileSync('git', ['clone', bare, other], { stdio: 'ignore', windowsHide: true });
    identify(other);
  });
  afterEach(() => dropTemp(root));

  /** Второй клон отправляет коммит — так у первого появляется что тянуть. */
  const pushFromOther = (name: string): void => {
    writeFileSync(join(other, name), 'from other\n');
    run(other, 'add', '-A');
    run(other, 'commit', '-m', `add ${name}`);
    run(other, 'push', 'origin', 'main');
  };

  it('видит удалённый, его ветки и отставание', async () => {
    pushFromOther('theirs.txt');
    run(dir, 'fetch', 'origin');
    const info = await readProjectGit(dir);
    expect(info.remote).toBe('origin');
    expect(info.remoteBranches).toEqual(['main']);
    expect(info.behind).toBe(1);
    expect(info.ahead).toBe(0);
  });

  it('обычный pull приносит чужой коммит в текущую ветку', async () => {
    pushFromOther('theirs.txt');
    await pullChanges(dir);
    expect(existsSync(join(dir, 'theirs.txt'))).toBe(true);
    expect((await readProjectGit(dir)).behind).toBe(0);
  });

  it('pull из выбранной ветки удалённого работает по имени из списка', async () => {
    pushFromOther('picked.txt');
    await pullChanges(dir, 'main');
    expect(existsSync(join(dir, 'picked.txt'))).toBe(true);
  });

  it('чужая ссылка не уходит в git: тянем только из перечисленных веток', async () => {
    await expect(pullChanges(dir, 'HEAD')).rejects.toBeInstanceOf(GitError);
    await expect(pullChanges(dir, 'origin/main')).rejects.toBeInstanceOf(GitError);
    await expect(pullChanges(dir, '--upload-pack=touch hacked')).rejects.toBeInstanceOf(GitError);
    expect(existsSync(join(dir, 'hacked'))).toBe(false);
  });

  it('конфликт — это отказ с текстом git, а не молчание', async () => {
    pushFromOther('readme.md');
    writeFileSync(join(dir, 'readme.md'), 'мой вариант\n');
    run(dir, 'add', '-A');
    run(dir, 'commit', '-m', 'local');
    await expect(pullChanges(dir)).rejects.toBeInstanceOf(GitError);
  });
});
