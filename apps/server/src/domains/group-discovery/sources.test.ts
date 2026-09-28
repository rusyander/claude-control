import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  canonicalPath,
  gitOriginOf,
  projectSources,
  resetGitOriginMemo,
  type ProjectSourceOptions,
} from './sources.ts';

/**
 * Источники обнаружения: один проект — один источник. Копии веток, подкаталоги
 * известного проекта и разные написания пути сворачиваются; домашний каталог и
 * каталог, чей `.claude` — это конфигурация CLI, в проекты не попадают.
 */

const slash = (path: string): string => canonicalPath(path);

describe('источники обнаружения: свёртка путей', () => {
  let root: string;
  let project: string;
  let config: string;
  /** git не спрашиваем: эти случаи о свёртке по имени и по реестру. */
  const noGit: ProjectSourceOptions['gitOrigin'] = () => undefined;
  const sources = (paths: string[], options: Partial<ProjectSourceOptions> = {}): string[] =>
    projectSources(paths, { configRoot: config, gitOrigin: noGit, ...options }).map(
      (spec) => spec.source,
    );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-discovery-sources-'));
    project = join(root, 'repo');
    config = join(root, 'home', '.claude');
    mkdirSync(join(project, 'apps', 'server'), { recursive: true });
    mkdirSync(config, { recursive: true });
    resetGitOriginMemo();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('копия панели «<репо>-worktrees/<ветка>» сворачивается к репозиторию', () => {
    mkdirSync(join(root, 'repo-worktrees', 'feat'), { recursive: true });
    expect(sources([join(root, 'repo-worktrees', 'feat'), project])).toEqual([slash(project)]);
  });

  it('копия Claude «<проект>/.claude/worktrees/<имя>» сворачивается к проекту', () => {
    const copy = join(project, '.claude', 'worktrees', 'pr-992');
    mkdirSync(copy, { recursive: true });
    expect(sources([copy])).toEqual([slash(project)]);
  });

  it('копия, которую git относит к другому репозиторию, сворачивается к нему', () => {
    const copy = join(root, 'elsewhere', 'inc-test');
    mkdirSync(copy, { recursive: true });
    const gitOrigin = (path: string): string | undefined =>
      slash(path) === slash(copy) ? slash(project) : undefined;
    expect(sources([copy], { gitOrigin })).toEqual([slash(project)]);
  });

  it('каталог чата внутри проекта реестра — тот же проект', () => {
    expect(sources([project, join(project, 'apps', 'server')], { registered: [project] })).toEqual([
      slash(project),
    ]);
  });

  it('два проекта реестра, один внутри другого, остаются двумя', () => {
    const inner = join(project, 'apps', 'server');
    expect(sources([project, inner], { registered: [project, inner] })).toEqual([
      slash(project),
      slash(inner),
    ]);
  });

  it('буква диска и слэши не делают второй источник', () => {
    expect(canonicalPath('c:\\work\\repo\\')).toBe('C:/work/repo');
    const lower = project.replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
    const back = project.replace(/\//g, '\\');
    const found = sources([lower, back, `${project}/`]);
    expect(found).toHaveLength(1);
  });

  it('домашний каталог и каталог, чей .claude — конфигурация CLI, не проекты', () => {
    const home = join(root, 'home');
    const other = join(root, 'person');
    mkdirSync(other, { recursive: true });
    expect(sources([home, project])).toEqual([slash(project)]);
    expect(sources([other, project], { home: other })).toEqual([slash(project)]);
  });
});

describe('источники обнаружения: корень по git', () => {
  let root: string;
  let main: string;
  let copy: string;
  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

  beforeAll(() => {
    // Длинное имя каталога: git отвечает им, а tmpdir на Windows бывает коротким (8.3).
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-discovery-git-')));
    main = join(root, 'repo');
    mkdirSync(join(main, 'apps', 'server'), { recursive: true });
    git(main, 'init', '-b', 'main');
    git(main, 'config', 'user.email', 'probe@example.com');
    git(main, 'config', 'user.name', 'probe');
    writeFileSync(join(main, 'apps', 'server', 'a.txt'), 'a\n', 'utf8');
    git(main, 'add', '.');
    git(main, 'commit', '-m', 'first');
    // Копия НЕ по имени панели и не в .claude/worktrees — узнать её может только git.
    copy = join(root, 'elsewhere', 'inc-test');
    git(main, 'worktree', 'add', '-b', 'work', copy);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('копия ветки где угодно и подкаталог дают корень основной копии', () => {
    expect(gitOriginOf(copy)?.toLowerCase()).toBe(slash(main).toLowerCase());
    expect(gitOriginOf(join(main, 'apps', 'server'))?.toLowerCase()).toBe(
      slash(main).toLowerCase(),
    );
    expect(gitOriginOf(root)).toBeUndefined();
  });
});
