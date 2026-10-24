import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GROUP_REQUEST_DEFAULTS } from '@agentdeck/contracts/split-groups';
import { groupDecision, withWorktree, type GroupAutoApprove } from '../group-permissions.ts';
import { groupCommandVerdict } from './group-command.ts';

/**
 * Обходы git из холодного ревью зон B+G и C+D (RF-BGCD-01/02/03/05a), каждый —
 * на настоящем git во временном каталоге: сначала сам git показывает, что форма
 * делает то, чего группа сама делать не должна, затем суд группы отдаёт её
 * человеку, а соседние рабочие формы остаются сами.
 */
describe('git: программы, HEAD, чужие копии, подделка `origin/*`', () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'git-escapes-')));
  const main = join(base, 'shop');
  const trees = join(base, 'shop-worktrees');
  const own = join(trees, 'fix-a');
  const sibling = join(trees, 'fix-b');
  const origin = join(base, 'origin.git');
  const slash = (path: string): string => path.replace(/\\/g, '/');
  const run = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });
  const scope = (extra: { prunable?: string[] } = {}) => ({
    worktree: own,
    cwd: own,
    branch: 'fix/a',
    base: 'main',
    ignored: [],
    ...extra,
  });
  const kind = (command: string, extra: { prunable?: string[] } = {}): string =>
    groupCommandVerdict(command, scope(extra)).kind;

  beforeAll(() => {
    mkdirSync(main, { recursive: true });
    run(base, 'init', '-q', '--bare', '-b', 'main', origin);
    run(main, 'init', '-q', '-b', 'main');
    run(main, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(main, 'a.txt'), 'one\n');
    // Программа, которую назовёт ключ: пишет метку рядом с собой.
    writeFileSync(join(main, 'x.sh'), '#!/bin/sh\necho ran > "$(dirname "$0")/marker"\nexit 1\n');
    run(main, 'add', '-A');
    run(main, 'commit', '-qm', 'init');
    run(main, 'remote', 'add', 'origin', origin);
    run(main, 'push', '-q', 'origin', 'main');
    run(main, 'fetch', '-q', 'origin');
    run(main, 'worktree', 'add', '-q', '-b', 'fix/a', own);
    run(main, 'worktree', 'add', '-q', '-b', 'fix/b', sibling);
    writeFileSync(join(sibling, 'wip.txt'), 'uncommitted\n');
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  describe('RF-BGCD-01: ключ, запускающий программу, — любым началом имени', () => {
    it('git сам принимает сокращение: `ls-remote --upload-pa=./x.sh .` запускает программу', () => {
      const marker = join(main, 'marker');
      rmSync(marker, { force: true });
      try {
        run(main, 'ls-remote', '--upload-pa=./x.sh', '.');
      } catch {
        // Программа нарочно падает: важна метка, а не код выхода.
      }
      expect(existsSync(marker)).toBe(true);
    });

    it('`grep -O<программа>` открывает найденные файлы ею', () => {
      const marker = join(main, 'marker');
      rmSync(marker, { force: true });
      try {
        run(main, 'grep', '-O./x.sh', 'one');
      } catch {
        // То же: код выхода программы не важен.
      }
      expect(existsSync(marker)).toBe(true);
    });

    it.each([
      "git rebase --exe 'rm -rf ~' main",
      "git rebase --ex='rm -rf ~' main",
      'git rebase -ix ./x.sh main',
      'git fetch --upl=./x.sh origin',
      'git pull --upload-p ./x.sh origin main',
      'git ls-remote --upload-pa=./x.sh .',
      'git ls-remote --upload=./x.sh .',
      'git ls-remote -qu./x.sh .',
      'git ls-remote --exe=./x.sh .',
      'git clone --upload-p=./x.sh ../shop .agent/tmp/c',
      'git clone -qc core.fsmonitor=./x.sh ../shop .agent/tmp/c',
      'git clone --conf core.fsmonitor=./x.sh ../shop .agent/tmp/c',
      'git clone --temp=../t ../shop .agent/tmp/c',
      'git init --templ=../t .agent/tmp/i',
      'git difftool --extc=./x.sh',
      'git difftool --ext=./x.sh',
      'git difftool -yx ./x.sh',
      'git push --rece=./x.sh origin HEAD:fix/a',
      'git push --e=./x.sh origin HEAD:fix/a',
      'git archive --remote=. --exe=./x.sh HEAD',
      'git grep -O./x.sh one',
      'git grep -nO one',
      'git grep --open-files-in-pager=./x.sh one',
      'git grep --op one',
    ])('человеку: %s', (command) => {
      expect(kind(command)).toBe('danger');
    });

    it.each([
      'git grep -n one',
      'git grep -o one',
      'git grep -e -x one',
      'git rebase -Xours origin/main',
      'git rebase --empty=drop origin/main',
      'git pull --rebase',
      'git fetch origin main',
      'git push -u origin HEAD:fix/a',
      'git ls-remote --heads origin',
      'git difftool -t meld --dir-diff',
    ])('не запуск программы: %s', (command) => {
      expect(kind(command)).not.toBe('danger');
    });
  });

  describe('RF-BGCD-02: `symbolic-ref HEAD` и `update-ref --no-deref HEAD` меняют ветку', () => {
    it('git не мешает: `symbolic-ref HEAD refs/heads/main` в копии ветки, где main стоит в основной', () => {
      const probe = join(trees, 'probe-head');
      run(main, 'worktree', 'add', '-q', '-b', 'fix/probe', probe);
      try {
        run(probe, 'symbolic-ref', 'HEAD', 'refs/heads/main');
        // Следующий коммит лёг бы в main — ту, что стоит в основной копии.
        expect(run(probe, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
      } finally {
        run(main, 'worktree', 'remove', '--force', probe);
      }
    });

    it.each([
      'git symbolic-ref HEAD refs/heads/main && git commit -am x && git push origin HEAD',
      'git symbolic-ref HEAD refs/heads/main',
      'git symbolic-ref -m why HEAD refs/heads/fix/b',
      'git symbolic-ref -q HEAD refs/heads/main',
      'git update-ref --no-deref HEAD HEAD && git push origin HEAD',
    ])('человеку: %s', (command) => {
      expect(kind(command)).toBe('danger');
    });

    it.each([
      'git symbolic-ref --short HEAD',
      'git symbolic-ref -q HEAD',
      'git symbolic-ref HEAD refs/heads/fix/a',
      'git symbolic-ref HEAD refs/heads/fix/a && git push origin HEAD',
      'git symbolic-ref -m why HEAD refs/heads/fix/a',
    ])('своя ветка и чтение — не человеку: %s', (command) => {
      expect(kind(command)).not.toBe('danger');
    });
  });

  describe('RF-BGCD-03: `worktree move|lock|unlock|repair|prune` чужой копии', () => {
    it('git сам переносит незапертую чужую копию с незакоммиченным', () => {
      const victim = join(trees, 'victim');
      run(main, 'worktree', 'add', '-q', '-b', 'fix/victim', victim);
      writeFileSync(join(victim, 'wip.txt'), 'uncommitted\n');
      const moved = join(own, '.agent', 'tmp', 'g1');
      mkdirSync(join(own, '.agent', 'tmp'), { recursive: true });
      run(own, 'worktree', 'move', victim, moved);
      expect(existsSync(join(moved, 'wip.txt'))).toBe(true);
      run(main, 'worktree', 'remove', '--force', moved);
    });

    it.each([
      `git worktree move ${slash(sibling)} .agent/tmp/g1`,
      `git worktree move ${slash(sibling)} .agent/tmp/g1 && rm -rf .agent/tmp/g1`,
      'git worktree move ../fix-b .agent/tmp/g1',
      'git worktree move .agent/tmp/s ../elsewhere',
      `git worktree lock ${slash(sibling)}`,
      `git worktree unlock ${slash(sibling)}`,
      `git worktree repair ${slash(sibling)}`,
      `git -C ${slash(sibling)} worktree lock .`,
    ])('человеку: %s', (command) => {
      expect(kind(command, { prunable: [] })).toBe('danger');
    });

    it.each([
      'git worktree move .agent/tmp/s .agent/tmp/s2',
      'git worktree lock .',
      'git worktree lock --reason probe .agent/tmp/s',
      'git worktree unlock .',
      'git worktree repair',
      'git worktree prune -n',
      'git worktree list',
    ])('своя копия и копии внутри неё — не человеку: %s', (command) => {
      expect(kind(command, { prunable: [] })).not.toBe('danger');
    });

    it('`prune`: по живому списку копий — сносит своё или чужое', async () => {
      const group: GroupAutoApprove = {
        rows: { ...GROUP_REQUEST_DEFAULTS },
        allowEdits: true,
        parentChatId: 'p',
        groupIndex: 0,
        tree: { dirty: false },
        branch: 'fix/a',
      };
      const decide = async (command: string): Promise<string> => {
        const placed = await withWorktree(group, own, { toolName: 'Bash', input: { command } });
        return groupDecision(
          { ...placed, shellCwd: own },
          { toolName: 'Bash', input: { command }, guardedPatterns: [] },
        );
      };
      // Сносить нечего — сама.
      expect(await decide('git worktree prune')).toBe('auto');
      // Пробная копия внутри своей, папку уже убрали — её запись своя.
      const scratch = join(own, '.agent', 'tmp', 'scratch-1');
      run(own, 'worktree', 'add', '-q', '--detach', scratch);
      rmSync(scratch, { recursive: true, force: true });
      expect(run(main, 'worktree', 'list', '--porcelain')).toContain('prunable');
      expect(await decide('git worktree prune')).toBe('auto');
      // Папки соседней копии нет — её запись снесётся, это решает человек.
      const gone = join(trees, 'fix-gone');
      run(main, 'worktree', 'add', '-q', '-b', 'fix/gone', gone);
      rmSync(gone, { recursive: true, force: true });
      expect(await decide('git worktree prune')).toBe('human');
      expect(await decide('git worktree prune -n')).toBe('auto');
      // Без списка (git не ответил) — человеку.
      expect(kind('git worktree prune')).toBe('danger');
      run(main, 'worktree', 'prune');
    });
  });

  describe('RF-BGCD-05a: загрузка в `refs/remotes/*` не с того удалённого', () => {
    it('git сам пишет поддельную `origin/main`: `fetch . +HEAD:refs/remotes/origin/main`', () => {
      writeFileSync(join(own, 'b.txt'), 'two\n');
      run(own, 'add', '-A');
      run(own, 'commit', '-qm', 'own');
      const before = run(own, 'rev-parse', 'refs/remotes/origin/main').trim();
      run(own, 'fetch', '-q', '.', '+HEAD:refs/remotes/origin/main');
      const forged = run(own, 'rev-parse', 'refs/remotes/origin/main').trim();
      expect(forged).toBe(run(own, 'rev-parse', 'HEAD').trim());
      expect(forged).not.toBe(before);
      run(own, 'update-ref', 'refs/remotes/origin/main', before);
    });

    it.each([
      'git fetch . +HEAD:refs/remotes/origin/main',
      'git fetch . HEAD:refs/remotes/origin/main',
      `git fetch ${slash(main)} main:refs/remotes/origin/main`,
      `git fetch file://${slash(origin)} main:refs/remotes/origin/main`,
      'git fetch ../shop +main:refs/remotes/origin/main',
      'git fetch https://example.com/r.git main:refs/remotes/origin/main',
      'git fetch upstream main:refs/remotes/origin/main',
      'git fetch origin +fix/a:refs/remotes/origin/main',
      'git fetch origin +HEAD:refs/remotes/origin/fix/a',
      'git fetch origin x:remotes/origin/main',
      'git fetch origin "$B:refs/remotes/origin/main"',
      'git fetch origin "main:$T"',
      'git fetch origin +refs/heads/x/*:refs/remotes/origin/*',
      'git fetch --refmap=+refs/heads/*:refs/remotes/origin/* . main',
      'git fetch --refmap +refs/heads/*:refs/remotes/origin/* . main',
      'git pull . HEAD:refs/remotes/origin/main',
    ])('человеку: %s', (command) => {
      expect(kind(command)).toBe('danger');
    });

    it.each([
      'git fetch origin',
      'git fetch origin main',
      'git fetch -q origin main:refs/remotes/origin/main',
      'git fetch origin +refs/heads/*:refs/remotes/origin/*',
      'git fetch -q origin "feat/x:refs/remotes/origin/mr920"',
      'git fetch origin "$B"',
      'git fetch --depth 1 origin fix/a:refs/remotes/origin/fix/a',
      'git pull --rebase origin main',
    ])('загрузка с самого удалённого — не человеку: %s', (command) => {
      expect(kind(command)).not.toBe('danger');
    });
  });
});
