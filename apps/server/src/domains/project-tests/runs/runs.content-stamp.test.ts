import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ChatRun, type ChatEvent } from '../../chat/ChatRunner/ChatRunner.ts';
import { testsDeliveryGaps } from '../../chat/tests-gate/tests-gate.ts';
import { readRuns } from '../runs-store/runs-store.ts';
import { createGroup, readGroups, upsertCase, writeGroup } from '../store/store.ts';
import { ProjectTestRunRegistry } from './runs.ts';

/**
 * Прогон агента панели (`ProjectTestRunRegistry`, запись `persist`) несёт тот же
 * отпечаток содержимого, что `tests-cli run`: снятый на старте, по `codePaths` и
 * автотесту кейса. Агент подменён на границе — процесс CLI (`ChatRun.start`):
 * он ставит кейсам итог, как настоящий агент, а запись истории, отпечаток и
 * ворота — настоящие. Дата коммита и mtime — «через час»: по времени каждый
 * такой шаг старил бы прогон.
 */
const CLI = resolve(__dirname, '../../../../../../tools/tests-cli.mjs');
const COMMAND = 'node tests-cli.mjs run --project .';
const LATER = new Date(Date.now() + 3_600_000).toISOString();
const JUNIT = `import { writeFileSync } from 'node:fs';
const cases = process.argv.slice(3).filter((f) => f === 'tests/other.test.mjs').map((f) => '<testcase classname="' + f + '" name="[other-001] t"/>').join('');
writeFileSync(process.argv[2], '<?xml version="1.0"?><testsuites><testsuite name="s">' + cases + '</testsuite></testsuites>');
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_COMMITTER_DATE: LATER, GIT_AUTHOR_DATE: LATER },
  });
}

function put(dir: string, path: string, body: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), body);
  const later = new Date(LATER);
  utimesSync(join(dir, path), later, later);
}

describe(
  'прогон агента панели: отпечаток содержимого в записи и ворота',
  { timeout: 120_000 },
  () => {
    let base = '';
    let dir = '';
    let startedAt = '';
    const registry = new ProjectTestRunRegistry();

    beforeEach(() => {
      base = mkdtempSync(join(tmpdir(), 'cc-runs-stamp-'));
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
      const at = new Date(Date.now() - 120_000).toISOString();
      createGroup(dir, 'auth', 'Auth');
      upsertCase(
        dir,
        'auth',
        {
          title: 'Login',
          steps: [{ action: 'log in', expected: 'session cookie set' }],
          codePaths: ['src/auth'],
          automation: { status: 'automated', file: 'tests/login.test.mjs' },
        },
        at,
      );
      upsertCase(
        dir,
        'auth',
        {
          title: 'Login page opens',
          steps: [{ action: 'open /login', expected: 'form visible' }],
          area: 'auth',
          automation: { status: 'automated', file: 'tests/login.test.mjs' },
        },
        at,
      );
      createGroup(dir, 'other', 'Other');
      upsertCase(
        dir,
        'other',
        {
          title: 'Other',
          steps: [{ action: 'call x', expected: 'x returns 2' }],
          codePaths: ['src/other'],
          automation: { status: 'automated', file: 'tests/other.test.mjs' },
        },
        at,
      );
      startedAt = new Date(Date.now() - 60_000).toISOString();
      put(dir, 'src/auth/login.ts', 'export const a = 2;\n');
    });

    afterEach(() => {
      registry.stop(dir);
      vi.restoreAllMocks();
      rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });

    /** Агент ставит кейсам группы `passed` — как настоящий, через файл группы. */
    async function agentRun(caseIds?: string[], during?: () => void): Promise<void> {
      vi.spyOn(ChatRun.prototype, 'start').mockImplementation(async (_options, onEvent) => {
        during?.();
        const group = readGroups(dir).find((item) => item.id === 'auth');
        if (!group) throw new Error('no group');
        const now = new Date().toISOString();
        writeGroup(dir, {
          ...group,
          cases: group.cases.map((item) =>
            !caseIds || caseIds.includes(item.id)
              ? { ...item, status: 'passed', lastRunAt: now }
              : item,
          ),
        });
        (onEvent as (event: ChatEvent) => void)({ kind: 'done', sessionId: 's1' } as ChatEvent);
      });
      registry.start(
        { projectPath: dir, mode: 'run', groupId: 'auth', ...(caseIds ? { caseIds } : {}) },
        new Date().toISOString(),
      );
      await vi.waitFor(() => expect(registry.get(dir)?.status).toBe('done'));
      vi.restoreAllMocks();
    }

    const gaps = async () =>
      (await testsDeliveryGaps({ cwd: dir, startedAt, command: COMMAND })).missing;

    it('запись прогона агента несёт отпечаток кейса с codePaths; кейс без них — нет', async () => {
      await agentRun();
      const [run] = readRuns(dir);
      expect(run?.results.map((item) => item.caseId).sort()).toEqual(['auth-001', 'auth-002']);
      expect(Object.keys(run?.stamps ?? {})).toEqual(['auth:auth-001']);
    });

    it('прогон агента → коммит того же — свеж', async () => {
      // Кейс без `codePaths` тоже покрывает файл (по области) — здесь он в архиве,
      // чтобы вердикт был только о кейсе с отпечатком.
      const group = readGroups(dir).find((item) => item.id === 'auth');
      if (!group) throw new Error('no group');
      writeGroup(dir, {
        ...group,
        cases: group.cases.map((item) =>
          item.id === 'auth-002' ? { ...item, archived: true } : item,
        ),
      });
      await agentRun(['auth-001']);
      git(dir, 'commit', '-q', '-am', 'wip');
      expect(await gaps()).toEqual([]);
    });

    it('прогон агента → правка покрытого файла — стар', async () => {
      await agentRun(['auth-001']);
      put(dir, 'src/auth/login.ts', 'export const a = 3;\n');
      expect(await gaps()).toEqual([expect.stringContaining('auth:auth-001')]);
    });

    it('агент правит покрытый файл во время прогона — отпечаток снят на старте, прогон стар', async () => {
      await agentRun(['auth-001'], () => put(dir, 'src/auth/login.ts', 'export const a = 4;\n'));
      git(dir, 'commit', '-q', '-am', 'wip');
      expect(await gaps()).toEqual([expect.stringContaining('auth-001')]);
    });

    it('кейс без codePaths отпечатка не получает — коммит после прогона его старит, как прежде', async () => {
      await agentRun();
      git(dir, 'commit', '-q', '-am', 'wip');
      const missing = await gaps();
      expect(missing).toHaveLength(1);
      expect(missing[0]).toContain('auth-002');
      expect(missing[0]).not.toContain('auth-001');
    });

    it('конец хода (tests-cli gate): правка чужого кейса после прогона агента его не старит', async () => {
      const since = new Date(Date.now() - 1000).toISOString();
      await agentRun(['auth-001']);
      put(dir, 'src/other/x.ts', 'export const x = 2;\n');
      const ran = spawnSync(
        process.execPath,
        [
          CLI,
          'run',
          '--case',
          'other:other-001',
          '--cmd',
          'node tests/write-junit.mjs {report}',
          '--full',
          '--project',
          dir,
        ],
        {
          cwd: dir,
          encoding: 'utf8',
          timeout: 60_000,
          env: { ...process.env, AGENTDECK_BRIEF_OUTPUT: '' },
        },
      );
      expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0);
      const gate = spawnSync(
        process.execPath,
        [
          CLI,
          'gate',
          '--since',
          since,
          '--changed-at',
          LATER,
          'src/auth/login.ts',
          'src/other/x.ts',
          '--project',
          dir,
        ],
        { cwd: dir, encoding: 'utf8', timeout: 60_000 },
      );
      expect(gate.status, `${gate.stdout}${gate.stderr}`).toBe(0);
    });
  },
);
