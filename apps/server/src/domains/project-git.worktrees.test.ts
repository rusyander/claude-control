import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, basename, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  GitError,
  addWorktree,
  listWorktrees,
  parseWorktrees,
  removeWorktree,
  stripGitProgress,
  worktreeDirFor,
  worktreeDirName,
} from './project-git.ts';

/**
 * Параллельные рабочие копии (группа 7). Разбор вывода и правила именования
 * каталога проверяются на строках, а сами операции — на НАСТОЯЩЕМ репозитории:
 * `git worktree` слишком тесно связан с состоянием на диске, чтобы подделка
 * что-то доказывала.
 *
 * Нет git в PATH — блок операций пропускается честно, а не притворяется зелёным.
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

describe('parseWorktrees: разбор git worktree list --porcelain', () => {
  it('первая запись — основная копия, ветка без refs/heads/', () => {
    const out = [
      'worktree C:/work/repo',
      'HEAD 1234567890abcdef',
      'branch refs/heads/main',
      '',
      'worktree C:/work/repo-worktrees/feature-x',
      'HEAD abcdef1234567890',
      'branch refs/heads/feature/x',
      '',
    ].join('\n');

    const list = parseWorktrees(out);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ isMain: true, branch: 'main', head: '12345678' });
    expect(list[1]).toMatchObject({ isMain: false, branch: 'feature/x', detached: false });
  });

  it('отцепленный HEAD, запертая и потерянная копии распознаются', () => {
    const out = [
      'worktree /repo',
      'HEAD aaa',
      'branch refs/heads/main',
      '',
      'worktree /repo-worktrees/detached',
      'HEAD bbb',
      'detached',
      '',
      'worktree /repo-worktrees/locked',
      'HEAD ccc',
      'branch refs/heads/wip',
      'locked разбираю руками',
      '',
      'worktree /repo-worktrees/gone',
      'HEAD ddd',
      'branch refs/heads/gone',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');

    const list = parseWorktrees(out);
    expect(list[1]?.detached).toBe(true);
    expect(list[1]?.branch).toBeUndefined();
    expect(list[2]).toMatchObject({ locked: true, branch: 'wip' });
    expect(list[3]).toMatchObject({ prunable: true });
  });

  it('пустой вывод — пустой список, а не запись без пути', () => {
    expect(parseWorktrees('')).toEqual([]);
    expect(parseWorktrees('\n\n')).toEqual([]);
  });
});

describe('worktreeDirName: имя ветки → имя каталога', () => {
  it('слэши схлопываются в дефис, буквы любого алфавита остаются', () => {
    expect(worktreeDirName('feature/parallel')).toBe('feature-parallel');
    expect(worktreeDirName('fix/двойной//слэш')).toBe('fix-двойной-слэш');
    expect(worktreeDirName('release-1.2.3')).toBe('release-1.2.3');
  });

  it('мусор по краям срезается, зарезервированные имена Windows не остаются', () => {
    expect(worktreeDirName('--wip--')).toBe('wip');
    expect(worktreeDirName('con')).toBe('con-wt');
    expect(worktreeDirName('COM1')).toBe('COM1-wt');
  });

  it('имя, от которого ничего не осталось, не даёт каталога без названия', () => {
    expect(worktreeDirName('///')).toBe('wt');
  });

  /**
   * Windows считает 260 символов на весь путь, и длинное имя ветки — та часть,
   * которую панель выбирает сама. Проверяем и потолок, и то, что укорачивание
   * не сводит разные ветки в один каталог: иначе второй агент пришёл бы работать
   * в копию первого.
   */
  it('длинное имя укорачивается, но остаётся своим у каждой ветки', () => {
    const long = 'task/e-inst-admin-ui-polzovateli-huki-plaginy-komandy';
    const other = 'task/e-inst-admin-ui-polzovateli-huki-plaginy-komandy-2';

    expect(long.length).toBeGreaterThan(40);
    expect(worktreeDirName(long).length).toBeLessThanOrEqual(40);
    expect(worktreeDirName(other).length).toBeLessThanOrEqual(40);
    expect(worktreeDirName(long)).not.toBe(worktreeDirName(other));
    // Укорачивание детерминировано: тот же путь и после перезапуска панели.
    expect(worktreeDirName(long)).toBe(worktreeDirName(long));
    // Начало имени остаётся читаемым — каталог должен узнаваться глазами.
    expect(worktreeDirName(long).startsWith('task-e-inst-admin-ui')).toBe(true);
  });

  it('короткое имя не трогается вовсе', () => {
    expect(worktreeDirName('task/d-inst-admin-ui-modeli-2')).toBe('task-d-inst-admin-ui-modeli-2');
  });
});

describe('stripGitProgress: в отказе видно причину, а не полосу прогресса', () => {
  it('строки прогресса выкидываются, сообщение об ошибке остаётся', () => {
    const raw = [
      "Preparing worktree (new branch 'task/d-inst-admin-ui-modeli-2')",
      'Updating files:  20% (1614/7829)\rUpdating files:  33% (2584/7829)',
      'Receiving objects:  50% (10/20)',
      "warning: unable to access 'inst-admin-ui/src/features/…/.gitattributes': Filename too long",
      "fatal: cannot create directory at 'inst-admin-ui/src/features/…/ui': Filename too long",
    ].join('\n');

    const clean = stripGitProgress(raw);

    expect(clean).not.toMatch(/Updating files/);
    expect(clean).not.toMatch(/Receiving objects/);
    expect(clean).toMatch(/Preparing worktree/);
    expect(clean).toMatch(/Filename too long/);
  });

  it('обычный вывод без прогресса не портится', () => {
    expect(stripGitProgress('fatal: not a git repository')).toBe('fatal: not a git repository');
  });
});

describe('worktreeDirFor: копии лежат рядом с репозиторием, а не внутри', () => {
  it('соседний каталог <репозиторий>-worktrees', () => {
    const target = worktreeDirFor(join('c:', 'work', 'gorgona'), 'feature/x');
    expect(basename(dirname(target))).toBe('gorgona-worktrees');
    expect(basename(target)).toBe('feature-x');
    // Внутрь рабочего дерева копия не попадает ни при каких именах.
    expect(target.startsWith(join('c:', 'work', 'gorgona') + sep)).toBe(false);
  });
});

describe.skipIf(!GIT_AVAILABLE)('копии на настоящем репозитории', { timeout: 60_000 }, () => {
  let dir: string;
  let siblings: string;

  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
  };

  beforeEach(() => {
    // Длинный вид пути обязателен: `os.tmpdir()` в Windows отдаёт 8.3-форму
    // (`RUSYAN~1`), а git всегда отвечает длинной, и сравнение путей — то самое,
    // на чём стоит вся защита от удаления чужого каталога.
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-wt-')));
    siblings = join(dirname(dir), `${basename(dir)}-worktrees`);
    git('init', '--initial-branch=main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'file.txt'), 'первый\n');
    git('add', '-A');
    git('commit', '-m', 'первый');
  });

  afterEach(() => {
    dropTemp(siblings);
    dropTemp(dir);
  });

  it('новая ветка: каталог рядом с репозиторием, копия видна в списке', async () => {
    const created = await addWorktree(dir, 'feature/x');
    expect(existsSync(created.path)).toBe(true);
    expect(created.path).toBe(join(siblings, 'feature-x'));

    const info = await listWorktrees(dir);
    expect(info.isRepo).toBe(true);
    expect(info.worktrees).toHaveLength(2);
    expect(info.worktrees[0]).toMatchObject({ isMain: true, branch: 'main' });
    expect(info.worktrees[1]).toMatchObject({ isMain: false, branch: 'feature/x' });
  });

  /**
   * Ключ длинных путей ставится САМОМУ репозиторию, а не только своим вызовам.
   * Панель кладёт `-c core.longpaths=true` в каждый свой git, поэтому копия
   * выкладывается целиком, — но дальше в ней работает АГЕНТ, обычным git с
   * обычным конфигом. Для него файл длиннее 260 символов не существует: он
   * показан УДАЛЁННЫМ, дерево читается грязным, а `git add -A` записал бы
   * удаление настоящих файлов. Это и покраснило вкладки на живом прогоне.
   */
  it.skipIf(process.platform !== 'win32')(
    'заведение копии включает длинные пути в конфиге репозитория',
    async () => {
      // Именно `--local`, и это тот же капкан, что и в самом коде: у человека,
      // послушавшего совет из README, ключ стоит ГЛОБАЛЬНО, и обычный `--get`
      // ответил бы «true» ещё до первой копии. Тест тогда проверяет настройку
      // машины, а не поведение панели, — и краснеет на ровном месте.
      const longpaths = (): string =>
        execFileSync('git', ['config', '--local', '--get', 'core.longpaths'], {
          cwd: dir,
          encoding: 'utf8',
          windowsHide: true,
        }).trim();

      // До первой копии ключа в конфиге репозитория нет — `--get` выходит с
      // ненулевым кодом.
      expect(() => longpaths()).toThrow();

      await addWorktree(dir, 'feature/x');
      expect(longpaths()).toBe('true');
    },
  );

  it('существующая локальная ветка переезжает в копию как есть', async () => {
    git('branch', 'ready');
    const created = await addWorktree(dir, 'ready');
    const info = await listWorktrees(dir);
    expect(info.worktrees.find((item) => item.path === created.path)?.branch).toBe('ready');
  });

  it('ветка, уже занятая копией или основным деревом, — отказ с объяснением', async () => {
    await addWorktree(dir, 'feature/x');
    await expect(addWorktree(dir, 'feature/x')).rejects.toBeInstanceOf(GitError);
    await expect(addWorktree(dir, 'main')).rejects.toThrow(/основной копией/);
  });

  it('имя ветки проверяет git, а не панель: мусор не доходит до диска', async () => {
    await expect(addWorktree(dir, '-r')).rejects.toBeInstanceOf(GitError);
    await expect(addWorktree(dir, 'плохая..ветка')).rejects.toBeInstanceOf(GitError);
    expect(existsSync(siblings)).toBe(false);
  });

  it('ветка агента внутри копии не ломает список: показывается та, что сейчас', async () => {
    const created = await addWorktree(dir, 'feature/x');
    // Так делает агент: сам завёл ветку и перешёл на неё внутри своей копии.
    execFileSync('git', ['checkout', '-b', 'feature/y'], {
      cwd: created.path,
      stdio: 'ignore',
      windowsHide: true,
    });
    const info = await listWorktrees(dir);
    expect(info.worktrees.find((item) => item.path === created.path)?.branch).toBe('feature/y');
  });

  it('удаление: основную копию и чужой путь панель не трогает', async () => {
    await expect(removeWorktree(dir, dir)).rejects.toThrow(/основная рабочая копия/);
    await expect(removeWorktree(dir, join(tmpdir(), 'cc-wt-нет-такого'))).rejects.toThrow(
      /копии в этом репозитории нет/,
    );
  });

  it('удаление копии убирает каталог и строку списка', async () => {
    const created = await addWorktree(dir, 'feature/x');
    await removeWorktree(dir, created.path);
    expect(existsSync(created.path)).toBe(false);
    const info = await listWorktrees(dir);
    expect(info.worktrees).toHaveLength(1);
  });

  it('незакоммиченная работа внутри копии удаляется только с force', async () => {
    const created = await addWorktree(dir, 'feature/x');
    writeFileSync(join(created.path, 'черновик.txt'), 'не потерять\n');
    await expect(removeWorktree(dir, created.path)).rejects.toBeInstanceOf(GitError);
    await removeWorktree(dir, created.path, true);
    expect(existsSync(created.path)).toBe(false);
  });

  it('каталог без .git: список отвечает isRepo:false, а не ошибкой', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cc-wt-plain-'));
    try {
      expect(await listWorktrees(plain)).toEqual({ isRepo: false, worktrees: [] });
      await expect(addWorktree(plain, 'x')).rejects.toBeInstanceOf(GitError);
    } finally {
      dropTemp(plain);
    }
  });
});
