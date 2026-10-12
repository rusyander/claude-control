import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyParityExcludes, sourceTails } from './copy-parity.ts';

/**
 * Копия грузит ровно то, что источник (E1). Что переписанный шаблон узнаёт файл
 * в настоящем CLI — доказывает живая проба; здесь — что панель переписывает
 * ровно привязанные к источнику шаблоны и ровно из действующих слоёв.
 */
describe('sourceTails: хвост шаблона относительно корня источника', () => {
  const root = 'C:/work/proj';
  it.each([
    ['плавающий, корень в конце', '**/proj/CLAUDE.md', true, ['CLAUDE.md']],
    ['плавающий с ** в хвосте', '**/proj/**/.claude/rules/**', true, ['**/.claude/rules/**']],
    ['два ведущих сегмента', '**/work/proj/CLAUDE.md', true, ['CLAUDE.md']],
    ['маска в сегменте', '**/p*/CLAUDE.md', true, ['CLAUDE.md']],
    ['относительный без ** — CLI его не узнает', 'ab/proj/CLAUDE.md', true, []],
    ['абсолютный, обратные слэши', 'C:\\work\\proj\\docs\\AGENTS.md', true, ['docs/AGENTS.md']],
    ['регистр без учёта на Windows', '**/PROJ/CLAUDE.md', true, ['CLAUDE.md']],
    ['регистр с учётом на Linux', '**/PROJ/CLAUDE.md', false, []],
    ['не привязан к источнику', '**/CLAUDE.md', true, []],
    ['чужой проект', '**/other/CLAUDE.md', true, []],
    ['чужой абсолютный путь', 'C:/work/proj-two/CLAUDE.md', true, []],
    ['класс в сегменте — не берёмся', '**/{proj,x}/CLAUDE.md', true, []],
  ])('%s', (_label, pattern, caseless, expected) => {
    expect(sourceTails(pattern, root, caseless)).toEqual(expected);
  });
});

describe('copyParityExcludes на настоящей копии git', () => {
  let base: string;
  let repo: string;
  let copy: string;
  let config: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' });
  const place = (cwd: string) => ({
    cwd,
    env: { CLAUDE_CONFIG_DIR: config },
    platform: process.platform,
    fallbackHome: base,
  });
  const literal = (list: string[]) => list.filter((item) => !item.includes('['));

  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-parity-')));
    repo = join(base, 'proj');
    copy = join(base, 'proj-worktrees', 'x');
    config = join(base, 'config');
    mkdirSync(join(repo, 'apps', 'web'), { recursive: true });
    mkdirSync(config);
    writeFileSync(join(repo, 'CLAUDE.md'), '# team\n');
    writeFileSync(join(repo, 'apps', 'web', 'index.ts'), '');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'p@example.com');
    git(repo, 'config', 'user.name', 'p');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'one');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat', copy);
    writeFileSync(
      join(config, 'settings.json'),
      JSON.stringify({
        claudeMdExcludes: [
          '**/proj/CLAUDE.md',
          '**/proj/**/.claude/rules/**',
          `${repo.replaceAll('\\', '/')}/docs/AGENTS.md`,
          '**/other/CLAUDE.md',
        ],
      }),
    );
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('личные шаблоны источника переписаны на корень копии, чужие — нет', () => {
    const root = copy.replaceAll('\\', '/');
    const excludes = copyParityExcludes([], place(join(copy, 'apps', 'web')));
    expect(literal(excludes)).toEqual([
      `${root}/CLAUDE.md`,
      `${root}/**/.claude/rules/**`,
      `${root}/docs/AGENTS.md`,
    ]);
    // Регистронезависимая ФС: к каждому буквальному — шаблон корня `[cC]:/…`.
    const caseless = process.platform === 'win32' || process.platform === 'darwin';
    expect(excludes).toHaveLength(caseless ? 6 : 3);
  });

  it('основной чекаут — источник сам себе, переписывать нечего', () => {
    expect(copyParityExcludes([], place(join(repo, 'apps')))).toEqual([]);
  });

  it('снятый личный слой не переносится; локальный слой копии — переносится', () => {
    mkdirSync(join(copy, '.claude'));
    writeFileSync(
      join(copy, '.claude', 'settings.local.json'),
      JSON.stringify({ claudeMdExcludes: ['**/proj/apps/CLAUDE.md'] }),
    );
    const root = copy.replaceAll('\\', '/');
    expect(
      literal(copyParityExcludes(['--setting-sources', 'project,local'], place(copy))),
    ).toEqual([`${root}/apps/CLAUDE.md`]);
    expect(literal(copyParityExcludes(['--setting-sources', 'user'], place(copy)))).toHaveLength(3);
  });
});
