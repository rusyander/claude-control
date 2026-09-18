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
import { addWorktree, mirrorWorktree, removeWorktree } from './project-git.ts';
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
import {
  checkCopyReady,
  describeGaps,
  layoutForCwd,
  repairCopy,
} from './project-git/copy-readiness.ts';

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

  it('тяжёлое окружение сборки закрыто наглухо: копия собирает его сама', () => {
    // Внутри — абсолютные пути и бинарники оригинала: скопированные, они дают
    // копии не рабочее окружение, а сломанное, ценой гигабайтов.
    for (const path of [
      '.venv/pyvenv.cfg',
      'apps/api/venv/bin/python',
      'src/__pycache__/main.cpython-312.pyc',
      '.pytest_cache/v/cache/lastfailed',
      '.mypy_cache/3.12/os.data.json',
      '.ruff_cache/content',
      'android/.gradle/8.7/x.bin',
      'node_modules/expo/android/.cxx/x.o',
      'rust/target/debug/app.exe',
      'ios/Pods/Manifest.lock',
      'infra/.terraform/providers/x',
      'apps/web/.next/server/app.js',
      '.nuxt/dist/server.mjs',
      '.svelte-kit/output/server.js',
    ]) {
      expect(isNever(path), path).toBe(true);
    }
    // Широкий шаблон человека сюда тоже не дотягивается.
    const wide = effectiveSettings({ include: ['**/*'], exclude: [] });
    expect(wanted('.venv/.env', wide)).toBe(false);
    expect(wanted('rust/target/.env', wide)).toBe(false);
    // А похожее по имени, но НЕ каталог сборки, зеркалится как прежде.
    expect(isNever('docs/targeting.md')).toBe(false);
    expect(isNever('src/venv-setup.md')).toBe(false);
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
    // «За бортом» — только то, что человек МОЖЕТ дописать в список. Окружение
    // сборки дописать нельзя, поэтому оно названо отдельно и с причиной, а
    // вложенные каталоги не верхний уровень и не называются вовсе.
    expect(plan.unlisted).toEqual([]);
    expect(plan.built).toEqual(['.venv/', 'node_modules/']);
  });

  it('дописанное человеком: include добирает, exclude вычитает', () => {
    const plan = planMirror({
      flagged: [],
      ignored: ['.env', 'notes.txt', 'secrets.d/'],
      settings: { include: ['notes.txt', 'secrets.d/**'], exclude: ['.env'] },
      listDir: (dir) => (dir === 'secrets.d' ? ['secrets.d/key.pem'] : []),
    });
    expect(plan.files).toEqual(['notes.txt', 'secrets.d/key.pem']);
    expect(plan.unlisted).toEqual([]);
  });

  it('окружение сборки не берётся даже по прямому шаблону — и сказано почему', () => {
    const plan = planMirror({
      flagged: [],
      ignored: ['.venv/', 'node_modules/'],
      settings: { include: ['.venv/pyvenv.cfg'], exclude: [] },
      listDir: (dir) => (dir === '.venv' ? ['.venv/pyvenv.cfg', '.venv/bin/python'] : []),
    });
    expect(plan.files).toEqual([]);
    expect(plan.built).toEqual(['.venv/', 'node_modules/']);
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
    expect(created.mirror?.unlisted).toEqual(['notes.txt']);
    expect(created.mirror?.skipped).toEqual([
      {
        path: '.venv/',
        kind: 'build-env',
        reason: 'окружение сборки — копия ставит его командой после создания',
        reasonCode: 'worktree-mirror-skip-build-env',
      },
      {
        path: 'node_modules/',
        kind: 'build-env',
        reason: 'окружение сборки — копия ставит его командой после создания',
        reasonCode: 'worktree-mirror-skip-build-env',
      },
    ]);
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
      // Группировка на экране идёт по `kind`, а не по русскому тексту причины.
      {
        path: '.venv/',
        kind: 'build-env',
        reason: expect.stringContaining('окружение сборки'),
        reasonCode: 'worktree-mirror-skip-build-env',
      },
      {
        path: 'node_modules/',
        kind: 'build-env',
        reason: expect.stringContaining('окружение сборки'),
        reasonCode: 'worktree-mirror-skip-build-env',
      },
      {
        path: '.claude/big.bin',
        reason: expect.stringContaining('больше 8 МБ'),
        reasonCode: 'worktree-mirror-skip-too-big',
        reasonParams: { size: 8 },
      },
    ]);
    expect(existsSync(join(created.path, '.env'))).toBe(false);
    expect(existsSync(join(created.path, '.claude', 'big.bin'))).toBe(false);
  });

  it('основная копия зеркалом не бывает, чужой путь — отказ git-ошибкой', async () => {
    await expect(mirrorWorktree(dir, dir)).rejects.toThrow(/Основная копия/);
    await expect(mirrorWorktree(dir, join(siblings, 'nope'))).rejects.toThrow(/нет в списке/);
  });
});

describe.skipIf(!GIT_AVAILABLE)('дыры зеркала, закрытые 17.09.2026', () => {
  let dir: string;
  let siblings: string;
  let home: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-gap-home-'));
    for (const key of ['XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'HOME'] as const) {
      savedEnv[key] = process.env[key];
    }
    process.env.XDG_CONFIG_HOME = home;
    process.env.GIT_CONFIG_GLOBAL = join(home, 'gitconfig');
    writeFileSync(join(home, 'gitconfig'), '');
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-gap-')));
    siblings = join(dirname(dir), `${basename(dir)}-worktrees`);
    gitIn(dir, 'init', '--initial-branch=main');
    gitIn(dir, 'config', 'user.email', 'test@example.invalid');
    gitIn(dir, 'config', 'user.name', 'Test');
    gitIn(dir, 'config', 'commit.gpgsign', 'false');
    gitIn(dir, 'config', 'core.autocrlf', 'false');
    // Ни `.mcp.json`, ни `CLAUDE.local.md` в игноре НЕТ — ровно тот проект, где
    // зеркало их не видело: git о них молчал обоим прежним источникам.
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(dir, 'file.txt'), 'первый\n');
    writeFileSync(join(dir, 'CLAUDE.local.md'), 'версия коммита\n');
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-m', 'первый');
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

  it('неотслеживаемый и не игнорируемый файл из списка попадает в копию', async () => {
    writeFileSync(join(dir, '.mcp.json'), '{"servers":{"panel":{}}}\n');
    const created = await addWorktree(dir, 'feature/untracked');
    expect(created.mirror?.mirrored).toContain('.mcp.json');
    expect(readFileSync(join(created.path, '.mcp.json'), 'utf8')).toBe(
      '{"servers":{"panel":{}}}\n',
    );
  });

  it('отслеживаемый файл из списка едет РАБОЧЕЙ версией, а не версией коммита', async () => {
    writeFileSync(join(dir, 'CLAUDE.local.md'), 'моя правка\n');
    const created = await addWorktree(dir, 'feature/modified');
    expect(created.mirror?.mirrored).toContain('CLAUDE.local.md');
    expect(readFileSync(join(created.path, 'CLAUDE.local.md'), 'utf8')).toBe('моя правка\n');
  });

  it('незакоммиченная работа вне списка в копию не тащится', async () => {
    writeFileSync(join(dir, 'file.txt'), 'правка рабочего дерева\n');
    writeFileSync(join(dir, 'new-source.ts'), 'export const x = 1;\n');
    const created = await addWorktree(dir, 'feature/only-listed');
    expect(created.mirror?.mirrored).not.toContain('file.txt');
    expect(existsSync(join(created.path, 'new-source.ts'))).toBe(false);
    expect(readFileSync(join(created.path, 'file.txt'), 'utf8')).toBe('первый\n');
  });

  it('скиллы достаются копии ссылкой: правка в оригинале видна сразу', async () => {
    mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', 'review.md'), 'версия оригинала\n');
    const created = await addWorktree(dir, 'feature/linked');
    expect(created.mirror?.linked).toEqual(['.claude/skills']);
    const inCopy = join(created.path, '.claude', 'skills', 'review.md');
    expect(readFileSync(inCopy, 'utf8')).toBe('версия оригинала\n');

    writeFileSync(join(dir, '.claude', 'skills', 'review.md'), 'поправили скилл\n');
    expect(readFileSync(inCopy, 'utf8')).toBe('поправили скилл\n');
    // Файлы под ссылкой зеркало не копирует: это тот же каталог оригинала.
    expect(created.mirror?.mirrored).not.toContain('.claude/skills/review.md');
  });

  it('копия получает запись доступа, удаление копии её забирает', async () => {
    const claudeJson = join(home, '.claude.json');
    writeFileSync(
      claudeJson,
      JSON.stringify({
        projects: {
          [dir.replace(/\\/g, '/')]: {
            hasTrustDialogAccepted: true,
            enabledMcpjsonServers: ['panel'],
            allowedTools: ['Bash(git status)'],
            lastCost: 42,
            history: [{ display: 'старое' }],
          },
        },
      }),
    );

    const created = await addWorktree(dir, 'feature/access', undefined, undefined, claudeJson);
    const key = created.path.replace(/\\/g, '/');
    const after = JSON.parse(readFileSync(claudeJson, 'utf8')) as {
      projects: Record<string, Record<string, unknown>>;
    };
    expect(after.projects[key]).toMatchObject({
      hasTrustDialogAccepted: true,
      enabledMcpjsonServers: ['panel'],
      allowedTools: ['Bash(git status)'],
    });
    // Следы работы оригинала копии не достаются: они про другой каталог.
    expect(after.projects[key]).not.toHaveProperty('lastCost');
    expect(after.projects[key]).not.toHaveProperty('history');
    expect(created.mirror?.access?.copied).toBe(true);
    expect(created.mirror?.gaps).toEqual([]);

    await removeWorktree(dir, created.path, true, claudeJson);
    const cleaned = JSON.parse(readFileSync(claudeJson, 'utf8')) as {
      projects: Record<string, unknown>;
    };
    expect(cleaned.projects[key]).toBeUndefined();
  });

  it('копия без записи доступа и без файла неполная, добор её чинит', async () => {
    const claudeJson = join(home, '.claude.json');
    const entry = JSON.stringify({
      projects: { [dir.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true } },
    });
    writeFileSync(claudeJson, entry);
    writeFileSync(join(dir, '.mcp.json'), '{"servers":{}}\n');
    const created = await addWorktree(dir, 'feature/broken');

    // Ломаем копию так, как её ломает жизнь: файл пропал, записи нет.
    rmSync(join(created.path, '.mcp.json'), { force: true });
    writeFileSync(claudeJson, JSON.stringify({ projects: {} }));

    const before = checkCopyReady({
      mainDir: dir,
      copyDir: created.path,
      claudeJsonPath: claudeJson,
    });
    expect(before.ready).toBe(false);
    expect(describeGaps(before.gaps)).toContain('.mcp.json');

    writeFileSync(claudeJson, entry);
    const after = await repairCopy({
      mainDir: dir,
      copyDir: created.path,
      claudeJsonPath: claudeJson,
    });
    expect(after.ready).toBe(true);
    expect(existsSync(join(created.path, '.mcp.json'))).toBe(true);
  });
});

describe('запись доступа: спрашиваем только там, где можем ответить', () => {
  let root: string;
  let main: string;
  let copy: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-access-'));
    main = join(root, 'repo');
    copy = join(root, 'repo-worktrees', 'feature');
    mkdirSync(main, { recursive: true });
    mkdirSync(copy, { recursive: true });
  });

  afterEach(() => dropTemp(root));

  const claudeJson = (projects: Record<string, unknown>): string => {
    const path = join(root, '.claude.json');
    writeFileSync(path, JSON.stringify({ projects }));
    return path;
  };

  const key = (dir: string): string => dir.replace(/\\/g, '/');

  it('файла .claude.json нет — копию не держим, состояние «не сверяли»', () => {
    const state = checkCopyReady({
      mainDir: main,
      copyDir: copy,
      claudeJsonPath: join(root, 'nothing.json'),
    });
    expect(state.access).toBe('unknown');
    expect(state.gaps).toEqual([]);
    expect(state.ready).toBe(true);
  });

  it('у оригинала записи никогда не было — копировать нечего, прогон не держим', () => {
    // Иначе копия навсегда «неполная»: ни зеркало, ни добор такую запись не придумают.
    const path = claudeJson({ 'c:/somewhere/else': { hasTrustDialogAccepted: true } });
    const state = checkCopyReady({ mainDir: main, copyDir: copy, claudeJsonPath: path });
    expect(state.access).toBe('unknown');
    expect(state.gaps).toEqual([]);
    expect(state.ready).toBe(true);
  });

  it('у оригинала запись есть, у копии нет — это дыра, и она названа', () => {
    const path = claudeJson({ [key(main)]: { hasTrustDialogAccepted: true } });
    const state = checkCopyReady({ mainDir: main, copyDir: copy, claudeJsonPath: path });
    expect(state.access).toBe('missing');
    expect(state.ready).toBe(false);
    expect(state.gaps).toEqual([{ kind: 'access', path: key(copy) }]);
    expect(describeGaps(state.gaps)).toContain('доверие');
  });

  it('у копии запись есть — доступ в порядке', () => {
    const path = claudeJson({
      [key(main)]: { hasTrustDialogAccepted: true },
      [key(copy)]: { hasTrustDialogAccepted: true },
    });
    const state = checkCopyReady({ mainDir: main, copyDir: copy, claudeJsonPath: path });
    expect(state.access).toBe('ok');
    expect(state.ready).toBe(true);
  });
});

describe.skipIf(!GIT_AVAILABLE)('три дефекта, найденные проверкой копий 18.09.2026', () => {
  let dir: string;
  let siblings: string;
  let home: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-def-home-'));
    for (const key of ['XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'HOME'] as const) {
      savedEnv[key] = process.env[key];
    }
    process.env.XDG_CONFIG_HOME = home;
    process.env.GIT_CONFIG_GLOBAL = join(home, 'gitconfig');
    writeFileSync(join(home, 'gitconfig'), '');
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-def-')));
    siblings = join(dirname(dir), `${basename(dir)}-worktrees`);
    gitIn(dir, 'init', '--initial-branch=main');
    gitIn(dir, 'config', 'user.email', 'test@example.invalid');
    gitIn(dir, 'config', 'user.name', 'Test');
    gitIn(dir, 'config', 'commit.gpgsign', 'false');
    gitIn(dir, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(dir, 'file.txt'), 'первый\n');
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-m', 'первый');
    mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', 'review.md'), 'скилл оригинала\n');
    writeFileSync(join(dir, '.mcp.json'), '{"servers":{}}\n');
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

  it('копия убирается с первого раза: своя же грязь вопросом не считается', async () => {
    const created = await addWorktree(dir, 'feature/remove-once');
    // Зеркало положило `.mcp.json` — для git копия «грязная» с рождения.
    expect(existsSync(join(created.path, '.mcp.json'))).toBe(true);
    await removeWorktree(dir, created.path);
    expect(existsSync(created.path)).toBe(false);
  });

  it('чужая правка в копии вопрос сохраняет', async () => {
    const created = await addWorktree(dir, 'feature/real-work');
    writeFileSync(join(created.path, 'file.txt'), 'работа агента\n');
    await expect(removeWorktree(dir, created.path)).rejects.toThrow();
    expect(existsSync(created.path)).toBe(true);
    // С явным согласием — убирается.
    await removeWorktree(dir, created.path, true);
    expect(existsSync(created.path)).toBe(false);
  });

  it('удаление снимает ссылку, а скиллы оригинала остаются на месте', async () => {
    const created = await addWorktree(dir, 'feature/link-gone');
    expect(created.mirror?.linked).toEqual(['.claude/skills']);
    await removeWorktree(dir, created.path);
    expect(existsSync(join(created.path, '.claude'))).toBe(false);
    // Главное: за ссылку удаление не провалилось.
    expect(readFileSync(join(dir, '.claude', 'skills', 'review.md'), 'utf8')).toBe(
      'скилл оригинала\n',
    );
    // И та же ветка заводится снова — каталог свободен.
    const again = await addWorktree(dir, 'feature/link-gone');
    expect(existsSync(join(again.path, '.claude', 'skills', 'review.md'))).toBe(true);
  });

  /**
   * Раскладка копии читается файлами, без запуска git, потому что её
   * спрашивают на КАЖДОМ сообщении человека, а порождение процесса стоило
   * 44–62 мс на посылку. Раз ответ теперь свой, он обязан совпадать с ответом
   * самого git — не «выглядеть правдоподобно», а совпадать: сверяем с
   * `rev-parse` на настоящей копии, на её подкаталоге, на оригинале и вне
   * репозитория.
   */
  it('раскладка копии читается без git — и совпадает с ответом git', async () => {
    const created = await addWorktree(dir, 'feature/layout');
    const copyDir = realpathSync.native(created.path);
    const asGit = (cwd: string): { mainDir: string; copyDir: string } => {
      const [commonDir, topLevel] = gitIn(
        cwd,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
        '--show-toplevel',
      )
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return {
        mainDir: realpathSync.native(dirname(commonDir as string)),
        copyDir: realpathSync.native(topLevel as string),
      };
    };

    const fromGit = asGit(copyDir);
    expect(fromGit.mainDir).toBe(dir);
    expect(layoutForCwd(copyDir)).toEqual({ mainDir: dir, copyDir });

    // Подкаталог копии — тот же ответ: корень ищется вверх по дереву.
    const nested = join(copyDir, 'nested', 'deep');
    mkdirSync(nested, { recursive: true });
    expect(asGit(nested)).toEqual(fromGit);
    expect(layoutForCwd(nested)).toEqual({ mainDir: dir, copyDir });

    // Оригинал сверять не с чем, и вне репозитория тоже.
    expect(layoutForCwd(dir)).toEqual({});
    expect(layoutForCwd(home)).toEqual({});
  });

  it('каталог на месте файла — это дыра, а не «файл есть»', async () => {
    const created = await addWorktree(dir, 'feature/dir-instead');
    rmSync(join(created.path, '.mcp.json'), { force: true });
    mkdirSync(join(created.path, '.mcp.json'), { recursive: true });
    const state = checkCopyReady({ mainDir: dir, copyDir: created.path });
    expect(state.ready).toBe(false);
    expect(state.gaps).toContainEqual({ kind: 'file', path: '.mcp.json' });
  });
});
