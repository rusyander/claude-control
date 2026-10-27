import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, upsertCase } from './store/store.ts';
import { readRuns } from './runs-store/runs-store.ts';

/**
 * T2 + P2 (g5 25.10) через настоящий CLI и настоящий git:
 * - зелёный прогон кейса группы `users` на дереве засчитывается кейсу группы `suites` с тем
 *   же автотестом (файл + имя теста) — `gaps` не требует гонять тот же пакет второй раз;
 * - правка дерева это снимает, и `run --stale` гонит ровно кейсы, названные `gaps`.
 */
const CLI = resolve(__dirname, '../../../../../tools/tests-cli.mjs');
const STARTED = '2026-10-25T10:00:00.000Z';
/** Один автотест, два кейса: JUnit с меткой каждого — чей прогон, тот и возьмёт свой. */
const CHECK = `import { writeFileSync } from 'node:fs';
const cases = ['users-001', 'suites-001'].map((id) => '<testcase name="[' + id + '] value" classname="check.mjs"/>').join('');
writeFileSync(process.argv[2], '<?xml version="1.0"?><testsuites><testsuite name="s" tests="2">' + cases + '</testsuite></testsuites>');
`;
const CMD = ['--cmd', 'node check.mjs {report}', '--full', '--fresh'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commit(dir: string, files: Record<string, string>, message: string): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git(dir, 'add', '.');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message);
}

describe(
  'tests-cli: зелёный того же автотеста на том же дереве, run --stale',
  { timeout: 180_000 },
  () => {
    let dir = '';
    const cli = (...args: string[]) => {
      const result = spawnSync(process.execPath, [CLI, ...args, '--project', dir], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, AGENTDECK_BRIEF_OUTPUT: '' },
      });
      return { code: result.status, out: `${result.stdout}${result.stderr}` };
    };
    const gaps = () => cli('gaps', '--since', STARTED);

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cc-tests-cli-tree-'));
      git(dir, 'init', '-q', '-b', 'main');
      writeFileSync(join(dir, '.git', 'info', 'exclude'), '.agent/\n');
      commit(dir, { 'src/value.txt': 'ok\n', 'check.mjs': CHECK }, 'main');
      git(dir, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');
      git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      git(dir, 'checkout', '-q', '-b', 'feat');
      commit(dir, { 'src/value.txt': 'ok, branch\n' }, 'feat');
      for (const group of ['users', 'suites']) {
        createGroup(dir, group, group);
        upsertCase(
          dir,
          group,
          {
            title: `Значение src/value.txt читается (${group})`,
            steps: ['node check.mjs'],
            expected: `check.mjs › [${group}-001] value проходит`,
            codePaths: ['src'],
            automation: { status: 'automated', file: 'check.mjs' },
          },
          '2026-10-25T09:00:00.000Z',
        );
      }
      // Кейс, которого дифф не задел: `--stale` его не гонит, прогон всех — гнал бы.
      createGroup(dir, 'docs', 'docs');
      upsertCase(
        dir,
        'docs',
        {
          title: 'Документация собирается',
          steps: ['node check.mjs'],
          expected: 'check.mjs › [docs-001] value проходит',
          codePaths: ['docs'],
          automation: { status: 'automated', file: 'check.mjs' },
        },
        '2026-10-25T09:00:00.000Z',
      );
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });

    it('прогон users на этом дереве закрывает кейс suites с тем же автотестом', () => {
      const ran = cli('run', '--case', 'users:users-001', ...CMD);
      expect(ran.code).toBe(0);
      const [record] = readRuns(dir);
      expect(record?.tree).toMatch(/^[0-9a-f]{64}$/);
      expect(record?.results.map((item) => item.caseId)).toEqual(['users-001']);
      const after = gaps();
      expect(after.out).not.toContain('suites-001');
      expect(after.code).toBe(0);
    });

    it('правка дерева — заимствования нет; run --stale гонит ровно названные gaps кейсы', () => {
      expect(cli('run', '--case', 'users:users-001', ...CMD).code).toBe(0);
      writeFileSync(join(dir, 'src', 'value.txt'), 'ok, edited\n');
      const stale = gaps();
      expect(stale.code).toBe(1);
      expect(stale.out).toContain('suites-001');
      expect(stale.out).toContain('run --project . --stale --since');
      const rerun = cli('run', '--stale', '--since', STARTED, ...CMD);
      expect(rerun.out).toContain('Кейсы из пробелов gaps (2): suites:suites-001,users:users-001');
      expect(rerun.out).toContain('Кейсов с автотестом: 2');
      expect(rerun.code).toBe(0);
      expect(gaps().code).toBe(0);
      const nothing = cli('run', '--stale', '--since', STARTED, ...CMD);
      expect(nothing.code).toBe(0);
      expect(nothing.out).toContain('прогонять нечего');
      expect(readRuns(dir)).toHaveLength(2);
    });
  },
);
