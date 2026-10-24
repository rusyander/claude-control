import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import { readRuns, writeRun } from '../../project-tests/runs-store/runs-store.ts';
import { testsDeliveryGaps } from './tests-gate.ts';

/**
 * Свежесть прогона по содержимому на настоящем пути: прогон пишет `node
 * tools/tests-cli.mjs run` (как у группы), потом git — коммит, amend, rebase,
 * правка, — и вердикт дают настоящие ворота: доставки (`testsDeliveryGaps`) и
 * конца хода (`tests-cli gate`). Дата коммита и mtime нарочно в будущем: по
 * старому правилу времени каждый из этих шагов старил прогон.
 */
const CLI = resolve(__dirname, '../../../../../../tools/tests-cli.mjs');
const COMMAND = 'node tests-cli.mjs run --project .';
const LATER = new Date(Date.now() + 3_600_000).toISOString();
const JUNIT = `import { writeFileSync } from 'node:fs';
const ids = { 'tests/login.test.mjs': 'auth-001', 'tests/other.test.mjs': 'other-001' };
const cases = process.argv.slice(3).filter((f) => ids[f]).map((f) => '<testcase classname="' + f + '" name="[' + ids[f] + '] t"/>').join('');
writeFileSync(process.argv[2], '<?xml version="1.0"?><testsuites><testsuite name="s">' + cases + '</testsuite></testsuites>');
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // Коммит «через час»: время его не оправдает, только содержимое.
    env: { ...process.env, GIT_COMMITTER_DATE: LATER, GIT_AUTHOR_DATE: LATER },
  });
}

function put(dir: string, path: string, body: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), body);
  const later = new Date(LATER);
  utimesSync(join(dir, path), later, later);
}

function cli(dir: string, ...args: string[]) {
  const out = spawnSync(process.execPath, [CLI, ...args, '--project', dir], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, AGENTDECK_BRIEF_OUTPUT: '' },
  });
  return { code: out.status, out: `${out.stdout}${out.stderr}` };
}

function addCase(dir: string, group: string, codePath: string, file: string): void {
  const made = cli(
    dir,
    'case',
    '--group',
    group,
    '--json',
    JSON.stringify({
      title: `${group} works`,
      steps: [{ action: `call ${group}`, expected: `${group} returns 2` }],
      codePaths: [codePath],
      automation: { status: 'automated', file },
    }),
  );
  expect(made.code, made.out).toBe(0);
}

function runCase(dir: string, key: string): void {
  const out = cli(
    dir,
    'run',
    '--case',
    key,
    '--cmd',
    'node tests/write-junit.mjs {report}',
    '--full',
  );
  expect(out.code, out.out).toBe(0);
}

describe(
  'свежесть прогона по содержимому: tests-cli run → git → ворота',
  { timeout: 120_000 },
  () => {
    let base = '';
    let dir = '';
    let startedAt = '';

    beforeEach(() => {
      base = mkdtempSync(join(tmpdir(), 'cc-tests-fresh-'));
      dir = join(base, 'work');
      mkdirSync(dir);
      git(dir, 'init', '-q', '-b', 'main');
      mkdirSync(join(dir, '.git', 'info'), { recursive: true });
      writeFileSync(join(dir, '.git', 'info', 'exclude'), '.agent/\n');
      put(dir, 'src/auth/login.ts', 'export const a = 1;\n');
      put(dir, 'src/other/x.ts', 'export const x = 1;\n');
      put(dir, 'tests/login.test.mjs', '// login\n');
      put(dir, 'tests/other.test.mjs', '// other\n');
      put(dir, 'tests/write-junit.mjs', JUNIT);
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'init');
      git(base, 'clone', '-q', '--bare', dir, 'origin.git');
      git(dir, 'remote', 'add', 'origin', '../origin.git');
      git(dir, 'fetch', '-q', 'origin');
      git(dir, 'checkout', '-q', '-b', 'group');
      addCase(dir, 'auth', 'src/auth', 'tests/login.test.mjs');
      addCase(dir, 'other', 'src/other', 'tests/other.test.mjs');
      startedAt = new Date(Date.now() - 60_000).toISOString();
      // Группа правит покрытое кейсом auth-001 — этот прогон и судится.
      put(dir, 'src/auth/login.ts', 'export const a = 2;\n');
    });

    afterEach(() => {
      rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });

    const gaps = async () =>
      (await testsDeliveryGaps({ cwd: dir, startedAt, command: COMMAND })).missing;

    it('прогон пишет отпечаток кейса в запись истории', () => {
      runCase(dir, 'auth:auth-001');
      const [run] = readRuns(dir);
      expect(Object.keys(run?.stamps ?? {})).toEqual(['auth:auth-001']);
    });

    it('прогон → коммит того же — свеж (раньше: «записан раньше последней правки»)', async () => {
      runCase(dir, 'auth:auth-001');
      git(dir, 'commit', '-q', '-am', 'wip');
      expect(await gaps()).toEqual([]);
    });

    it('прогон → commit --amend без правки покрытого — свеж', async () => {
      git(dir, 'commit', '-q', '-am', 'wip');
      runCase(dir, 'auth:auth-001');
      git(dir, 'commit', '-q', '--amend', '-m', 'reworded');
      expect(await gaps()).toEqual([]);
    });

    it('прогон → правка покрытого файла — стар', async () => {
      runCase(dir, 'auth:auth-001');
      put(dir, 'src/auth/login.ts', 'export const a = 3;\n');
      expect(await gaps()).toEqual([expect.stringContaining('auth:auth-001')]);
    });

    it('прогон → новый файл в покрытой папке — стар', async () => {
      runCase(dir, 'auth:auth-001');
      put(dir, 'src/auth/session.ts', 'export const s = 1;\n');
      expect(await gaps()).toEqual([expect.stringContaining('auth:auth-001')]);
    });

    it('прогон → правка файла автотеста — стар', async () => {
      runCase(dir, 'auth:auth-001');
      put(dir, 'tests/login.test.mjs', '// login changed\n');
      expect(await gaps()).toEqual([expect.stringContaining('auth:auth-001')]);
    });

    it('прогон → правка и коммит непокрытого файла — свеж', async () => {
      runCase(dir, 'auth:auth-001');
      put(dir, 'src/misc/y.ts', 'export const y = 1;\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'both');
      expect(await gaps()).toEqual([]);
    });

    it('прогон → rebase на сдвинутую основную, покрытого не тронувшую — свеж', async () => {
      git(dir, 'commit', '-q', '-am', 'group work');
      runCase(dir, 'auth:auth-001');
      git(base, 'clone', '-q', 'origin.git', 'other');
      const other = join(base, 'other');
      put(other, 'src/other/z.ts', 'export const z = 1;\n');
      git(other, 'add', '.');
      git(other, 'commit', '-q', '-m', 'main moved');
      git(other, 'push', '-q', 'origin', 'HEAD:main');
      git(dir, 'fetch', '-q', 'origin');
      git(dir, 'rebase', '-q', 'origin/main');
      expect(await gaps()).toEqual([]);
    });

    it('запись без отпечатка (старая история) — прежнее правило по времени', async () => {
      git(dir, 'commit', '-q', '-am', 'wip');
      const old = (at: string): ProjectTestRunRecord => ({
        id: `old-${at}`,
        mode: 'import',
        actor: 'ci',
        status: 'done',
        startedAt: at,
        finishedAt: at,
        results: [
          { pointId: 'auth|auth-001', groupId: 'auth', caseId: 'auth-001', status: 'passed' },
        ],
        summary: { total: 1, passed: 1, failed: 0, skipped: 0, blocked: 0 },
      });
      writeRun(dir, old(new Date().toISOString()));
      // Коммит «через час» новее записи — по времени она стара.
      expect(await gaps()).toEqual([expect.stringContaining('auth:auth-001')]);
      writeRun(dir, old(new Date(Date.parse(LATER) + 60_000).toISOString()));
      expect(await gaps()).toEqual([]);
    });

    it('конец хода (tests-cli gate): правка непокрытого кейсом файла после прогона его не старит', () => {
      const since = new Date(Date.now() - 1000).toISOString();
      runCase(dir, 'auth:auth-001');
      put(dir, 'src/other/x.ts', 'export const x = 2;\n');
      runCase(dir, 'other:other-001');
      const gate = (...files: string[]) =>
        cli(dir, 'gate', '--since', since, '--changed-at', LATER, ...files);
      const fresh = gate('src/auth/login.ts', 'src/other/x.ts');
      expect(fresh.code, fresh.out).toBe(0);
      put(dir, 'src/auth/login.ts', 'export const a = 3;\n');
      const stale = gate('src/auth/login.ts', 'src/other/x.ts');
      expect(stale.code).toBe(1);
      expect(stale.out).toContain('not run after the last edit (auth-001)');
      expect(stale.out).not.toContain('other-001');
    });
  },
);
