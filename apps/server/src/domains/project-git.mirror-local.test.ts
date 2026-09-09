import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { addWorktree, mirrorWorktree } from './project-git.ts';
import {
  MIRROR_SIZE_LIMIT,
  describeMirror,
  globToRegExp,
  includeReaches,
  isNever,
  parseFlagged,
  planMirror,
  wanted,
  effectiveSettings,
} from './project-git/mirror-local.ts';

/**
 * Зеркало локального слоя в копию (T2). Правила — на строках и на списках, без
 * репозитория; сам перенос — на НАСТОЯЩЕМ git: флаги `skip-worktree` и список
 * игнорируемого подделкой не доказываются.
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

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
}

describe('globToRegExp и wanted: шаблоны как в .gitignore', () => {
  const only = (include: string[]): { include: string[]; exclude: string[] } => ({
    include,
    exclude: [],
  });

  it('без «/» — по имени на любой глубине', () => {
    expect(wanted('.mcp.json', only(['.mcp.json']))).toBe(true);
    expect(wanted('apps/web/.mcp.json', only(['.mcp.json']))).toBe(true);
    expect(wanted('.mcp.json.bak', only(['.mcp.json']))).toBe(false);
    expect(wanted('a/b/settings.local.json', only(['*.local.*']))).toBe(true);
  });

  it('с «/» — от корня; `**` берёт любую глубину', () => {
    expect(wanted('.claude/settings.local.json', only(['.claude/**']))).toBe(true);
    expect(wanted('.claude/a/b/c.json', only(['.claude/**']))).toBe(true);
    expect(wanted('apps/.claude/settings.local.json', only(['.claude/**']))).toBe(false);
    expect(wanted('apps/.claude/x.json', only(['**/.claude/**']))).toBe(true);
  });

  it('`*` не переходит через сегмент, `?` — один символ', () => {
    expect(globToRegExp('src/*.env').test('src/a.env')).toBe(true);
    expect(globToRegExp('src/*.env').test('src/a/b.env')).toBe(false);
    expect(globToRegExp('.env.?').test('.env.x')).toBe(true);
    expect(globToRegExp('.env.?').test('.env.xy')).toBe(false);
    expect(globToRegExp('./.dev/').test('.dev')).toBe(true);
  });
});

describe('isNever / wanted: запретное не зеркалится никогда', () => {
  it('node_modules, dist, coverage и *.log — где бы ни лежали', () => {
    expect(isNever('node_modules/x.js')).toBe(true);
    expect(isNever('apps/web/dist/index.js')).toBe(true);
    expect(isNever('.agent/debug.log')).toBe(true);
    expect(isNever('.claude/settings.local.json')).toBe(false);
  });

  it('встроенный список и вычеты человека', () => {
    const settings = effectiveSettings({ include: ['notes.txt'], exclude: ['.env'] });
    expect(wanted('.claude/settings.local.json', settings)).toBe(true);
    expect(wanted('.agent/notes.md', settings)).toBe(true);
    expect(wanted('.agent/tmp/scratch.md', settings)).toBe(false);
    expect(wanted('.agent/PROGRESS.md', settings)).toBe(false);
    expect(wanted('notes.txt', settings)).toBe(true);
    expect(wanted('.env', settings)).toBe(false);
    expect(wanted('.env.local', settings)).toBe(true);
    // Даже прямое включение не дотягивается до запретного.
    expect(
      wanted('node_modules/.claude/x', effectiveSettings({ include: ['**/*'], exclude: [] })),
    ).toBe(false);
  });

  it('includeReaches: в свёрнутый каталог заходит только шаблон с «/»', () => {
    expect(includeReaches('.claude', ['.claude/**'])).toBe(true);
    expect(includeReaches('.venv', ['.claude/**', '*.local'])).toBe(false);
    expect(includeReaches('.venv', ['**/pyvenv.cfg'])).toBe(true);
    expect(includeReaches('.dev', ['.d*/**'])).toBe(true);
  });
});

describe('parseFlagged: буквы git ls-files -v', () => {
  it('S и s — skip-worktree, h — assume-unchanged, H — ничего', () => {
    const out = ['H src/a.ts', 'S .mcp.json', 'h config.local.json', 's both.json', ''].join('\0');
    expect(parseFlagged(out)).toEqual([
      { path: '.mcp.json', flag: 'skip-worktree' },
      { path: 'config.local.json', flag: 'assume-unchanged' },
      { path: 'both.json', flag: 'skip-worktree' },
    ]);
  });
});

describe('planMirror: что переносить', () => {
  const listDir = (dir: string): string[] => {
    if (dir === '.claude') return ['.claude/settings.local.json', '.claude/skills/x.md'];
    if (dir === '.agent') return ['.agent/notes.md', '.agent/tmp/scratch.md', '.agent/PROGRESS.md'];
    return [];
  };

  it('флаги и игнорируемое по списку — в план, остальное верхнего уровня — за борт', () => {
    const plan = planMirror({
      flagged: [
        { path: '.mcp.json', flag: 'skip-worktree' },
        { path: 'node_modules/patched.js', flag: 'assume-unchanged' },
      ],
      ignored: [
        '.claude/',
        '.agent/',
        '.env',
        'node_modules/',
        '.venv/',
        'debug.log',
        'src/x.tmp',
        'apps/web/.venv/',
      ],
      settings: undefined,
      listDir,
    });
    expect(plan.files).toEqual([
      '.agent/notes.md',
      '.claude/settings.local.json',
      '.claude/skills/x.md',
      '.env',
      '.mcp.json',
    ]);
    expect(plan.flagged).toEqual([{ path: '.mcp.json', flag: 'skip-worktree' }]);
    // `node_modules/` и `*.log` не называются: их не бывает в зеркале по правилу,
    // а не по недосмотру. Вложенные каталоги — не верхний уровень.
    expect(plan.unlisted).toEqual(['.venv/']);
  });

  it('дописанное человеком: include добирает, exclude вычитает', () => {
    const plan = planMirror({
      flagged: [],
      ignored: ['.env', 'notes.txt', '.venv/'],
      settings: { include: ['notes.txt', '.venv/pyvenv.cfg'], exclude: ['.env'] },
      listDir: (dir) => (dir === '.venv' ? ['.venv/pyvenv.cfg', '.venv/bin/python'] : []),
    });
    expect(plan.files).toEqual(['.venv/pyvenv.cfg', 'notes.txt']);
    expect(plan.unlisted).toEqual([]);
  });
});

describe('describeMirror', () => {
  it('одна строка для тоста', () => {
    expect(
      describeMirror({
        mirrored: ['.env', '.mcp.json'],
        skipped: [{ path: 'big.bin', reason: 'больше 8 МБ' }],
        unlisted: ['.venv/'],
        kept: 3,
      }),
    ).toBe('Локальный слой: перенесено 2, без изменений 3, пропущено 1, за бортом: .venv/');
  });
});

describe.skipIf(!GIT_AVAILABLE)('mirrorLocalLayer на настоящем репозитории', () => {
  let dir: string;
  let siblings: string;
  let home: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Глобальный ignore машины (у владельца там как раз `.mcp.json`) сделал бы
    // тест зависимым от компьютера: git читает `$XDG_CONFIG_HOME/git/ignore` и
    // `~/.config/git/ignore`, оба уводятся в пустой каталог. Домен наследует
    // `process.env`, поэтому подмена действует и на его вызовы git.
    home = mkdtempSync(join(tmpdir(), 'cc-mirror-home-'));
    for (const key of ['XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'HOME'] as const) {
      savedEnv[key] = process.env[key];
    }
    process.env.XDG_CONFIG_HOME = home;
    process.env.GIT_CONFIG_GLOBAL = join(home, 'gitconfig');
    writeFileSync(join(home, 'gitconfig'), '');
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-mirror-')));
    siblings = join(dirname(dir), `${basename(dir)}${'-worktrees'}`);
    gitIn(dir, 'init', '--initial-branch=main');
    gitIn(dir, 'config', 'user.email', 'test@example.invalid');
    gitIn(dir, 'config', 'user.name', 'Test');
    gitIn(dir, 'config', 'commit.gpgsign', 'false');
    gitIn(dir, 'config', 'core.autocrlf', 'false');
    writeFileSync(
      join(dir, '.gitignore'),
      '.claude/\n.env\nnode_modules/\n.venv/\n*.log\nnotes.txt\n',
    );
    writeFileSync(join(dir, '.mcp.json'), '{"shared":true}\n');
    writeFileSync(join(dir, 'file.txt'), 'первый\n');
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-m', 'первый');
    // Локальный слой: правленный skip-worktree файл + игнорируемое.
    writeFileSync(join(dir, '.mcp.json'), '{"local":true}\n');
    gitIn(dir, 'update-index', '--skip-worktree', '.mcp.json');
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.local.json'), '{"permissions":{}}\n');
    writeFileSync(join(dir, '.env'), 'SECRET=1\n');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x.js'), '// deps\n');
    mkdirSync(join(dir, '.venv', 'bin'), { recursive: true });
    writeFileSync(join(dir, '.venv', 'bin', 'python'), '');
    writeFileSync(join(dir, 'debug.log'), 'log\n');
    writeFileSync(join(dir, 'notes.txt'), 'заметки\n');
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    dropTemp(siblings);
    dropTemp(dir);
    dropTemp(home);
  });

  it('создание копии переносит слой, ставит флаг и оставляет копию чистой', async () => {
    const created = await addWorktree(dir, 'feature/x');
    expect(created.mirror).toBeDefined();
    expect(created.mirror?.mirrored).toEqual(['.claude/settings.local.json', '.env', '.mcp.json']);
    expect(created.mirror?.unlisted).toEqual(['.venv/', 'notes.txt']);
    expect(created.mirror?.skipped).toEqual([]);
    expect(created.output).toContain('Локальный слой: перенесено 3');

    const copy = created.path;
    expect(readFileSync(join(copy, '.mcp.json'), 'utf8')).toBe('{"local":true}\n');
    expect(readFileSync(join(copy, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(existsSync(join(copy, 'node_modules'))).toBe(false);
    expect(existsSync(join(copy, '.venv'))).toBe(false);
    expect(existsSync(join(copy, 'debug.log'))).toBe(false);
    expect(gitIn(copy, 'ls-files', '-v', '--', '.mcp.json').startsWith('S')).toBe(true);
    expect(gitIn(copy, 'status', '--porcelain').trim()).toBe('');
  });

  it('повторное зеркало переписывает только то, что в основной копии свежее', async () => {
    const created = await addWorktree(dir, 'feature/y');
    const copy = created.path;
    // Сразу после создания всё уже не старее: ничего не переносится.
    const same = await mirrorWorktree(dir, copy);
    expect(same.mirror.mirrored).toEqual([]);
    expect(same.mirror.kept).toBe(3);

    // Копия правит свой `.env` — основная копия его не затирает.
    writeFileSync(join(copy, '.env'), 'SECRET=copy\n');
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(copy, '.env'), future, future);
    // А правка в основной копии, более свежая, чем у копии, переезжает.
    writeFileSync(join(dir, '.mcp.json'), '{"local":2}\n');
    const later = new Date(Date.now() + 120_000);
    utimesSync(join(dir, '.mcp.json'), later, later);

    const again = await mirrorWorktree(dir, copy);
    expect(again.mirror.mirrored).toEqual(['.mcp.json']);
    expect(again.mirror.kept).toBe(2);
    expect(readFileSync(join(copy, '.env'), 'utf8')).toBe('SECRET=copy\n');
    expect(readFileSync(join(copy, '.mcp.json'), 'utf8')).toBe('{"local":2}\n');
    // Флаг не потерян и после повторного зеркала.
    expect(gitIn(copy, 'ls-files', '-v', '--', '.mcp.json').startsWith('S')).toBe(true);
  });

  it('шаблоны человека и потолок размера', async () => {
    writeFileSync(join(dir, '.claude', 'big.bin'), Buffer.alloc(MIRROR_SIZE_LIMIT + 1));
    const created = await addWorktree(dir, 'feature/z', {
      include: ['notes.txt'],
      exclude: ['.env'],
    });
    expect(created.mirror?.mirrored).toEqual([
      '.claude/settings.local.json',
      '.mcp.json',
      'notes.txt',
    ]);
    expect(created.mirror?.skipped).toEqual([
      { path: '.claude/big.bin', reason: expect.stringContaining('больше 8 МБ') },
    ]);
    expect(existsSync(join(created.path, '.env'))).toBe(false);
    expect(existsSync(join(created.path, '.claude', 'big.bin'))).toBe(false);
  });

  it('основная копия зеркалом не бывает, чужой путь — отказ git-ошибкой', async () => {
    await expect(mirrorWorktree(dir, dir)).rejects.toThrow(/Основная копия/);
    await expect(mirrorWorktree(dir, join(siblings, 'nope'))).rejects.toThrow(/нет в списке/);
  });
});
