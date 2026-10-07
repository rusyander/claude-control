import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import { createGroup, upsertCase } from '../project-tests/store.ts';
import { writeRun } from '../project-tests/runs-store.ts';
import { testsDeliveryGaps } from './tests-gate.ts';

/**
 * Свежесть прогона группы на настоящем git (Ф23, проект
 * `.agent/item17-tests-block-design.agent.md`): прогон засчитывается, только
 * если записан после последней правки кода группы — коммита или правки в
 * рабочем дереве. Раньше хватало «после старта группы», и прогон, сделанный до
 * последнего коммита, закрывал код, который он не видел.
 *
 * Подменены только даты: коммиту — `GIT_COMMITTER_DATE`, файлу — mtime.
 */
const COMMAND = 'node tests-cli.mjs run --project .';
const STARTED = Date.parse('2026-09-30T10:00:00.000Z');
const at = (minutes: number): string => new Date(STARTED + minutes * 60_000).toISOString();

function git(cwd: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
}

function commit(dir: string, files: Record<string, string>, when: string): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  const env = { GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when };
  git(dir, env, 'add', '.');
  git(dir, env, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', when);
}

const passedRun = (id: string, startedAt: string): ProjectTestRunRecord =>
  ({
    id,
    mode: 'import',
    actor: 'ci',
    status: 'done',
    startedAt,
    finishedAt: startedAt,
    results: [{ pointId: 'auth|auth-001', groupId: 'auth', caseId: 'auth-001', status: 'passed' }],
    summary: { total: 1, passed: 1, failed: 0, skipped: 0, blocked: 0 },
  }) as ProjectTestRunRecord;

describe('Ф23: свежесть прогона группы на настоящем git', { timeout: 60_000 }, () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-tests-gate-git-'));
    git(dir, {}, 'init', '-q', '-b', 'main');
    // `.agent/` вне git, как в проекте: копия получает его зеркалом.
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '.agent/\n');
    commit(dir, { 'src/auth/login.ts': 'export const a = 1;\n' }, at(-60));
    createGroup(dir, 'auth', 'Auth');
    upsertCase(
      dir,
      'auth',
      {
        title: 'Вход',
        codePaths: ['src/auth'],
        automation: { status: 'automated', file: 'tests/login.spec.ts' },
      },
      at(-60),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  const gaps = () => testsDeliveryGaps({ cwd: dir, startedAt: at(0), command: COMMAND });

  it('прогон после последнего коммита группы — пробелов нет', async () => {
    commit(dir, { 'src/auth/login.ts': 'export const a = 2;\n' }, at(10));
    writeRun(dir, passedRun('r1', at(20)));
    expect((await gaps()).missing).toEqual([]);
  });

  it('коммит группы после прогона — прогон старше правки, пробел', async () => {
    commit(dir, { 'src/auth/login.ts': 'export const a = 2;\n' }, at(10));
    writeRun(dir, passedRun('r1', at(20)));
    commit(dir, { 'src/auth/login.ts': 'export const a = 3;\n' }, at(30));
    const result = await gaps();
    expect(result.missing).toEqual([expect.stringContaining('r1')]);
    expect(result.verdict).toMatchObject({ passed: 0 });
  });

  it('правка в рабочем дереве после прогона — тоже пробел', async () => {
    commit(dir, { 'src/auth/login.ts': 'export const a = 2;\n' }, at(10));
    writeRun(dir, passedRun('r1', at(20)));
    const file = join(dir, 'src/auth/login.ts');
    writeFileSync(file, 'export const a = 4;\n');
    const mtime = new Date(at(30));
    utimesSync(file, mtime, mtime);
    expect((await gaps()).missing).toEqual([expect.stringContaining('r1')]);
  });
});
