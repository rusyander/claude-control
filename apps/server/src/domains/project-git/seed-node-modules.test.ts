import { execFileSync, execSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorktreeBootstraps, detectBootstrapPlan } from './bootstrap.ts';
import { removeWorktree } from './project-git.ts';
import {
  missingPackages,
  seedNodeModules,
  seedSourceFor,
  selfContained,
} from './seed-node-modules.ts';

/**
 * Посев `node_modules` копии из оригинала. Всё настоящее: жёсткие ссылки на
 * диске, git worktree, и в последнем тесте — сам `npm`, которому пакет отдан
 * tgz-файлом из репозитория, чтобы не ходить в сеть.
 */

let root: string;

/** npm на Windows — `npm.cmd`, его запускает только оболочка; аргументы здесь свои, без пробелов. */
const sh = (cwd: string, cmd: string, args: string[]): string =>
  cmd === 'npm'
    ? execSync(['npm', ...args.map((arg) => `"${arg}"`)].join(' '), {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
      })
    : execFileSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true });

const put = (path: string, text: string): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

const links = (path: string): number => statSync(path).nlink;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-seed-nm-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('seedNodeModules', () => {
  it('файлы пакетов — ссылками, служебное с точкой — копией, кэши и junction — мимо', async () => {
    const from = join(root, 'orig', 'node_modules');
    put(join(from, 'pkg', 'index.js'), 'module.exports = 1;');
    put(join(from, '@scope', 'deep', 'lib', 'a.js'), 'a');
    put(join(from, '.bin', 'pkg.cmd'), '@echo off');
    put(join(from, '.prisma', 'client', 'index.js'), 'generated');
    put(join(from, '.vite', 'deps', '_metadata.json'), '{}');
    put(join(from, '.experimental-vitest-cache', 'results.json'), '{}');
    put(join(root, 'orig', 'shared', 'index.js'), 'shared');
    symlinkSync(
      join(root, 'orig', 'shared'),
      join(from, 'shared'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const to = join(root, 'copy', 'node_modules');

    const report = await seedNodeModules(from, to);

    expect(links(join(to, 'pkg', 'index.js'))).toBe(2);
    expect(links(join(to, '@scope', 'deep', 'lib', 'a.js'))).toBe(2);
    expect(links(join(to, '.bin', 'pkg.cmd'))).toBe(2);
    expect(links(join(to, '.prisma', 'client', 'index.js'))).toBe(1);
    expect(readFileSync(join(to, '.prisma', 'client', 'index.js'), 'utf8')).toBe('generated');
    expect(existsSync(join(to, '.vite'))).toBe(false);
    expect(existsSync(join(to, '.experimental-vitest-cache'))).toBe(false);
    expect(existsSync(join(to, 'shared'))).toBe(false);
    expect(report).toMatchObject({ linked: 3, copied: 1 });
    expect(report.skipped).toHaveLength(3);
  });

  /**
   * Замер 17.10 на настоящем оригинале: его память tsc отстала от дерева копии, и
   * первая проверка типов с ней шла 19 с против 14 с с нуля.
   */
  it('память tsc оригинала (.tmp) в копию не переносится', async () => {
    const from = join(root, 'orig', 'node_modules');
    put(join(from, 'pkg', 'index.js'), 'module.exports = 1;');
    put(join(from, '.tmp', 'tsconfig.app.tsbuildinfo'), '{"fileNames":[]}');
    const to = join(root, 'copy', 'node_modules');

    const report = await seedNodeModules(from, to);

    expect(existsSync(join(to, '.tmp'))).toBe(false);
    expect(report.skipped).toEqual([join(from, '.tmp')]);
  });

  it('сбой посредине — недосеянный каталог убран', async () => {
    const to = join(root, 'copy', 'node_modules');
    await expect(seedNodeModules(join(root, 'нет-такого'), to)).rejects.toThrow();
    expect(existsSync(to)).toBe(false);
  });
});

describe('seedSourceFor', () => {
  const repo = (): { main: string; copy: string } => {
    const main = join(root, 'main');
    put(join(main, 'app', 'package.json'), '{"name":"app"}');
    put(join(main, 'app', 'package-lock.json'), '{"lockfileVersion":3}');
    put(join(main, '.gitignore'), 'node_modules\n');
    sh(main, 'git', ['init', '-q']);
    sh(main, 'git', ['add', '-A']);
    sh(main, 'git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one']);
    put(join(main, 'app', 'node_modules', 'x', 'index.js'), 'x');
    const copy = join(root, 'copy');
    sh(main, 'git', ['worktree', 'add', '-q', '-b', 'side', copy]);
    return { main, copy };
  };

  it('совпавшие манифесты — каталог оригинала', async () => {
    const { main, copy } = repo();
    expect(await seedSourceFor(copy, 'app')).toBe(join(realpathSync.native(main), 'app'));
  });

  it('другой lock-файл, свой node_modules, сам оригинал, не репозиторий — не сеем', async () => {
    const { main, copy } = repo();
    expect(await seedSourceFor(main, 'app')).toBeUndefined();
    expect(await seedSourceFor(root, 'app')).toBeUndefined();
    writeFileSync(join(copy, 'app', 'package-lock.json'), '{"lockfileVersion":3,"x":1}');
    expect(await seedSourceFor(copy, 'app')).toBeUndefined();
    writeFileSync(join(copy, 'app', 'package-lock.json'), '{"lockfileVersion":3}');
    mkdirSync(join(copy, 'app', 'node_modules'));
    expect(await seedSourceFor(copy, 'app')).toBeUndefined();
  });
});

describe('missingPackages', () => {
  it('нет пакета или версия не та, что в lock-файле — назван; полное дерево — пусто', async () => {
    const dir = join(root, 'app');
    put(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { a: '^1.0.0', b: '^2.0.0' }, devDependencies: { c: '3' } }),
    );
    put(
      join(dir, 'package-lock.json'),
      JSON.stringify({ packages: { 'node_modules/a': { version: '1.2.0' } } }),
    );
    put(join(dir, 'node_modules', 'a', 'package.json'), '{"version":"1.1.0"}');
    put(join(dir, 'node_modules', 'b', 'package.json'), '{"version":"2.0.0"}');
    expect(await missingPackages(dir)).toEqual(['a', 'c']);
    put(join(dir, 'node_modules', 'a', 'package.json'), '{"version":"1.2.0"}');
    put(join(dir, 'node_modules', 'c', 'package.json'), '{"version":"3.0.0"}');
    expect(await missingPackages(dir)).toEqual([]);
  });

  it('npm: сверяется всё дерево lock-файла, вложенные тоже; необязательные и ссылки — нет', async () => {
    const dir = join(root, 'tree');
    put(join(dir, 'package.json'), JSON.stringify({ dependencies: { a: '^1.0.0' } }));
    put(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        packages: {
          '': { name: 'tree' },
          'node_modules/a': { version: '1.0.0' },
          'node_modules/dep': { version: '2.0.0' },
          'node_modules/a/node_modules/nested': { version: '3.0.0' },
          'node_modules/fsevents': { version: '2.3.3', optional: true },
          'node_modules/types-only': { version: '1.0.0', devOptional: true },
          'node_modules/local': { resolved: 'packages/local', link: true },
        },
      }),
    );
    put(join(dir, 'node_modules', 'a', 'package.json'), '{"version":"1.0.0"}');
    expect(await missingPackages(dir, 'npm')).toEqual(['dep', 'nested']);
    put(join(dir, 'node_modules', 'dep', 'package.json'), '{"version":"2.0.0"}');
    put(
      join(dir, 'node_modules', 'a', 'node_modules', 'nested', 'package.json'),
      '{"version":"3.1.0"}',
    );
    expect(await missingPackages(dir, 'npm')).toEqual(['nested']);
    put(
      join(dir, 'node_modules', 'a', 'node_modules', 'nested', 'package.json'),
      '{"version":"3.0.0"}',
    );
    expect(await missingPackages(dir, 'npm')).toEqual([]);
  });

  it('pnpm и yarn: забытый рядом package-lock.json о дереве не говорит — только наличие прямых', async () => {
    const dir = join(root, 'pnpm');
    put(join(dir, 'package.json'), JSON.stringify({ dependencies: { gd: '^1.0.0' } }));
    put(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        packages: {
          'node_modules/gd': { version: '0.9.0' },
          'node_modules/gone': { version: '1.0.0' },
        },
      }),
    );
    put(join(dir, 'node_modules', 'gd', 'package.json'), '{"version":"1.0.0"}');
    expect(await missingPackages(dir, 'pnpm')).toEqual([]);
    expect(await missingPackages(dir, 'yarn')).toEqual([]);
    expect(await missingPackages(dir, 'npm')).toEqual(['gd', 'gone']);
  });
});

describe('selfContained', () => {
  const pkg = (deps: Record<string, string>, extra = {}): string => {
    const dir = join(root, `p${Math.random().toString(36).slice(2)}`);
    put(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: deps, ...extra }));
    return dir;
  };

  it('пакеты из реестра и архив по file: — да; соседняя папка и workspace — нет', async () => {
    expect(await selfContained(pkg({ react: '^18.0.0', tiny: 'file:./tiny-1.0.0.tgz' }))).toBe(
      true,
    );
    expect(await selfContained(pkg({ lib: 'file:../lib' }))).toBe(false);
    expect(await selfContained(pkg({ lib: 'link:../lib' }))).toBe(false);
    expect(await selfContained(pkg({ lib: 'workspace:*' }))).toBe(false);
    expect(await selfContained(pkg({}, { workspaces: ['packages/*'] }))).toBe(false);
    const pnpmWs = pkg({});
    put(join(pnpmWs, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    expect(await selfContained(pnpmWs)).toBe(false);
    expect(await selfContained(join(root, 'нет-такого'))).toBe(false);
  });
});

describe('подготовка копии на npm', () => {
  /** Оригинал с `web` на npm, установленным по-настоящему, и его копия-worktree. */
  const project = (deps: Record<string, string>, beforeInstall?: (main: string) => void) => {
    const main = join(root, 'main');
    const tiny = join(root, 'tiny');
    put(join(tiny, 'package.json'), '{"name":"tiny","version":"1.0.0","main":"index.js"}');
    put(join(tiny, 'index.js'), 'module.exports = 42;');
    mkdirSync(join(main, 'web'), { recursive: true });
    sh(tiny, 'npm', ['pack', '--silent', '--pack-destination', join(main, 'web')]);
    beforeInstall?.(main);
    put(
      join(main, 'web', 'package.json'),
      JSON.stringify({ name: 'web', version: '1.0.0', dependencies: deps }),
    );
    sh(join(main, 'web'), 'npm', ['install', '--silent', '--no-audit', '--no-fund']);
    put(join(main, '.gitignore'), 'node_modules\n');
    sh(main, 'git', ['init', '-q']);
    sh(main, 'git', ['add', '-A']);
    sh(main, 'git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one']);
    const copy = join(root, 'copy');
    sh(main, 'git', ['worktree', 'add', '-q', '-b', 'side', copy]);
    return { main, copy };
  };

  it('самодостаточный каталог: node_modules — ссылка на оригинал, установки нет; удаление копии оригинал не трогает', async () => {
    const { main, copy } = project({ tiny: 'file:./tiny-1.0.0.tgz' });

    const plan = detectBootstrapPlan(copy);
    expect(plan?.summary).toContain('npm ci');
    const boots = new WorktreeBootstraps(join(root, 'logs'));
    const state = await boots.run(copy, plan!);

    expect(state.status).toBe('ok');
    const log = boots.log(copy);
    expect(log).toContain('ссылка на каталог оригинала');
    expect(log).not.toContain('$ npm');
    const shared = join(copy, 'web', 'node_modules');
    expect(lstatSync(shared).isSymbolicLink()).toBe(true);
    expect(realpathSync.native(shared).toLowerCase()).toBe(
      realpathSync.native(join(main, 'web', 'node_modules')).toLowerCase(),
    );
    expect(sh(join(copy, 'web'), 'node', ['-p', "require('tiny')"]).trim()).toBe('42');
    expect(sh(copy, 'git', ['status', '--porcelain'])).toBe('');

    // tmpdir на Windows — короткая форма (`RUSYAN~1`), git помнит длинную.
    await removeWorktree(realpathSync.native(main), realpathSync.native(copy));

    expect(existsSync(copy)).toBe(false);
    expect(readFileSync(join(main, 'web', 'node_modules', 'tiny', 'index.js'), 'utf8')).toBe(
      'module.exports = 42;',
    );
  }, 180_000);

  /**
   * Оригинал 16.10: манифест требовал пакет, которого в `node_modules` не было;
   * ссылка отдала копии неполное дерево, и сборка группы была красной.
   */
  it('в node_modules оригинала недостаёт пакета из манифеста — не ссылка, а посев с доустановкой', async () => {
    const { main, copy } = project({ tiny: 'file:./tiny-1.0.0.tgz' });
    rmSync(join(main, 'web', 'node_modules', 'tiny'), { recursive: true, force: true });

    const boots = new WorktreeBootstraps(join(root, 'logs'));
    const state = await boots.run(copy, detectBootstrapPlan(copy)!);

    expect(state.status).toBe('ok');
    const log = boots.log(copy);
    expect(log).toContain('недостаёт пакетов или они не той версии (tiny)');
    expect(log).not.toContain('ссылка на каталог оригинала');
    expect(lstatSync(join(copy, 'web', 'node_modules')).isSymbolicLink()).toBe(false);
    expect(sh(join(copy, 'web'), 'node', ['-p', "require('tiny')"]).trim()).toBe('42');
    expect(existsSync(join(main, 'web', 'node_modules', 'tiny'))).toBe(false);
  }, 180_000);

  it('каталог с соседней папкой по file: — посев жёсткими ссылками, папка своя, не оригинала', async () => {
    const { copy } = project({ tiny: 'file:./tiny-1.0.0.tgz', lib: 'file:../lib' }, (main) =>
      put(join(main, 'lib', 'package.json'), '{"name":"lib","version":"1.0.0"}'),
    );

    const boots = new WorktreeBootstraps(join(root, 'logs'));
    const state = await boots.run(copy, detectBootstrapPlan(copy)!);

    expect(state.status).toBe('ok');
    expect(boots.log(copy)).toContain('node_modules из оригинала ссылками');
    expect(lstatSync(join(copy, 'web', 'node_modules')).isSymbolicLink()).toBe(false);
    const copied = join(copy, 'web', 'node_modules', 'tiny', 'index.js');
    expect(links(copied)).toBe(2);
    expect(realpathSync.native(join(copy, 'web', 'node_modules', 'lib')).toLowerCase()).toBe(
      realpathSync.native(join(copy, 'lib')).toLowerCase(),
    );
    expect(sh(copy, 'git', ['status', '--porcelain'])).toBe('');
  }, 180_000);
});
