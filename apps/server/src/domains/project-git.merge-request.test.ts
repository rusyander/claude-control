import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  addMergeRequestWorktree,
  mergeRequestRef,
  parseLsRemote,
  pickMergeRequestBranch,
  resolveMergeRequestBranch,
} from './project-git.ts';
import { makeSplitGit, splitTasks } from './chat/ChatSplit.ts';

/**
 * Ветка MR без форджа (Д2, инцидент 23.09.2026). Разбор — на строках, сама
 * операция — на НАСТОЯЩИХ репозиториях: «удалённый» (bare) с веткой MR и
 * служебной ссылкой `refs/merge-requests/<iid>/head`, как её публикует GitLab,
 * и клон — проект панели. Подделка git здесь доказала бы только подделку.
 */

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = hasGit();
const MR_URL = 'https://gitlab.example.com/team/app/-/merge_requests/7';

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста это не влияет.
  }
}

describe('разбор: ссылка MR и снимок удалённого', () => {
  it('служебная ссылка головы MR/PR по адресу', () => {
    expect(mergeRequestRef(MR_URL)).toBe('refs/merge-requests/7/head');
    expect(mergeRequestRef(`${MR_URL}/diffs`)).toBe('refs/merge-requests/7/head');
    expect(mergeRequestRef('https://github.com/o/r/pull/12')).toBe('refs/pull/12/head');
    expect(mergeRequestRef('https://example.com/whatever')).toBeUndefined();
  });

  it('ветка MR — голова refs/heads/* на коммите головы MR, но не HEAD удалённого', () => {
    const refs = parseLsRemote(
      [
        'aaa\tHEAD',
        'aaa\trefs/heads/main',
        'bbb\trefs/heads/feature/mr',
        'bbb\trefs/merge-requests/7/head',
        'ccc\trefs/heads/other',
      ].join('\n'),
    );
    expect(pickMergeRequestBranch(refs, 'refs/merge-requests/7/head', [])).toBe('feature/mr');
    // Подсказка агента, не совпавшая с головой MR, — не ветка MR.
    expect(pickMergeRequestBranch(refs, 'refs/merge-requests/7/head', ['other'])).toBe(
      'feature/mr',
    );
    // Головы MR нет — подсказка, если такая ветка у удалённого есть.
    expect(pickMergeRequestBranch(refs, undefined, ['other'])).toBe('other');
    expect(pickMergeRequestBranch(refs, undefined, ['nope'])).toBeUndefined();
  });

  it('две ветки на голове MR — решает подсказка, без неё не угадываем', () => {
    const refs = parseLsRemote(
      ['bbb\trefs/heads/a', 'bbb\trefs/heads/b', 'bbb\trefs/merge-requests/7/head'].join('\n'),
    );
    expect(pickMergeRequestBranch(refs, 'refs/merge-requests/7/head', ['b'])).toBe('b');
    expect(pickMergeRequestBranch(refs, 'refs/merge-requests/7/head', [])).toBeUndefined();
  });
});

describe.skipIf(!GIT_AVAILABLE)('ветка MR на настоящем git', () => {
  let root = '';
  let origin = '';
  let project = '';
  let mrSha = '';

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'agentdeck-mr-')));
    const seed = join(root, 'seed');
    origin = join(root, 'origin.git');
    project = join(root, 'app');
    execFileSync('git', ['init', '-q', '-b', 'main', seed], { windowsHide: true });
    run(seed, ['config', 'user.email', 't@example.com']);
    run(seed, ['config', 'user.name', 't']);
    writeFileSync(join(seed, 'a.txt'), 'base\n');
    run(seed, ['add', '.']);
    run(seed, ['commit', '-q', '-m', 'base']);
    run(seed, ['checkout', '-q', '-b', 'feature/mr']);
    writeFileSync(join(seed, 'a.txt'), 'mr change\n');
    run(seed, ['commit', '-q', '-am', 'mr change']);
    mrSha = run(seed, ['rev-parse', 'HEAD']);
    run(seed, ['checkout', '-q', 'main']);
    execFileSync('git', ['clone', '-q', '--bare', seed, origin], { windowsHide: true });
    // Так голову MR публикует GitLab: служебная ссылка вне refs/heads.
    run(origin, ['update-ref', 'refs/merge-requests/7/head', mrSha]);
    execFileSync('git', ['clone', '-q', origin, project], { windowsHide: true });
    run(project, ['config', 'user.email', 't@example.com']);
    run(project, ['config', 'user.name', 't']);
  });

  afterEach(() => {
    dropTemp(root);
  });

  it('находит ветку MR по голове MR и подтягивает её', async () => {
    const found = await resolveMergeRequestBranch(project, MR_URL, []);

    expect(found).toEqual({ branch: 'feature/mr', remote: 'origin' });
    expect(run(project, ['rev-parse', 'refs/remotes/origin/feature/mr'])).toBe(mrSha);
  });

  it('несуществующая подсказка агента ветку не выдумывает', async () => {
    const found = await resolveMergeRequestBranch(
      project,
      'https://gitlab.example.com/team/app/-/merge_requests/99',
      ['fix-mr-conflicts'],
    );
    expect(found).toBeUndefined();
  });

  it('свободная ветка — копия на ней самой, на голове MR', async () => {
    await resolveMergeRequestBranch(project, MR_URL, []);
    const copy = await addMergeRequestWorktree(project, { branch: 'feature/mr', remote: 'origin' });

    expect(copy.detached).toBe(false);
    expect(run(copy.path, ['rev-parse', 'HEAD'])).toBe(mrSha);
    expect(run(copy.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feature/mr');
  });

  it('ветка занята основной копией — detached на голове MR, а не `<ветка>-2` от main', async () => {
    run(project, ['checkout', '-q', 'feature/mr']);
    await resolveMergeRequestBranch(project, MR_URL, []);

    const copy = await addMergeRequestWorktree(project, { branch: 'feature/mr', remote: 'origin' });

    expect(copy.detached).toBe(true);
    expect(run(copy.path, ['rev-parse', 'HEAD'])).toBe(mrSha);
    expect(run(copy.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    expect(run(project, ['branch', '--list', 'feature/mr-*'])).toBe('');
  });

  it('локальная ветка разошлась с удалённой — чужие коммиты не трогаем: detached', async () => {
    run(project, ['branch', 'feature/mr', 'origin/main']);
    run(project, ['checkout', '-q', 'feature/mr']);
    writeFileSync(join(project, 'b.txt'), 'local only\n');
    run(project, ['add', '.']);
    run(project, ['commit', '-q', '-m', 'local only']);
    const local = run(project, ['rev-parse', 'HEAD']);
    run(project, ['checkout', '-q', 'main']);
    await resolveMergeRequestBranch(project, MR_URL, []);

    const copy = await addMergeRequestWorktree(project, { branch: 'feature/mr', remote: 'origin' });

    expect(copy.detached).toBe(true);
    expect(run(copy.path, ['rev-parse', 'HEAD'])).toBe(mrSha);
    expect(run(project, ['rev-parse', 'feature/mr'])).toBe(local);
  });

  it('локальная ветка отстала — перематывается вперёд, копия на ней', async () => {
    run(project, ['branch', 'feature/mr', 'main']);
    await resolveMergeRequestBranch(project, MR_URL, []);

    const copy = await addMergeRequestWorktree(project, { branch: 'feature/mr', remote: 'origin' });

    expect(copy.detached).toBe(false);
    expect(run(copy.path, ['rev-parse', 'HEAD'])).toBe(mrSha);
  });

  it('разделение: работа в MR без форджа встаёт на ветку MR, а не на ветку из блока от main', async () => {
    const links: string[] = [];
    const cwds: string[] = [];

    const result = await splitTasks({
      projectPath: project,
      // Так агент родителя пишет блок: ветку группы придумал сам, ветку MR не знает.
      proposal: {
        groups: [
          {
            title: 'Конфликты MR 7',
            branch: 'fix-mr-conflicts',
            tasks: ['разрешить конфликты'],
            review: { url: MR_URL, work: true },
          },
        ],
      },
      startRuns: true,
      git: makeSplitGit(),
      now: () => 1000,
      start: ({ cwd }) => {
        cwds.push(cwd);
        return true;
      },
      link: (chat) => void links.push(chat.branch),
    });

    expect(result.failures).toEqual([]);
    expect(result.chats[0]?.branch).toBe('feature/mr');
    expect(links).toEqual(['feature/mr']);
    expect(run(cwds[0] ?? project, ['rev-parse', 'HEAD'])).toBe(mrSha);
    expect(run(project, ['branch', '--list', 'fix-mr-conflicts*'])).toBe('');
  });
});
