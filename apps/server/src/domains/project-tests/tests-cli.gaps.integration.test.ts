import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import { createGroup, upsertCase } from './store/store.ts';
import { writeRun } from './runs-store/runs-store.ts';

/**
 * `tests-cli gaps` — пробелы блока «Тесты» перед «доставлено» тем же кодом,
 * что сверяет панель (живая группа 24.10: после rebase дифф вырос, напоминание
 * назвало два кейса, на деле их было 27 — группа узнавала о каждом следующим
 * кругом). Настоящий процесс CLI на настоящем git; подменены только даты.
 */
const CLI = resolve(__dirname, '../../../../../tools/tests-cli.mjs');
const STARTED = Date.parse('2026-10-24T10:00:00.000Z');
const at = (minutes: number): string => new Date(STARTED + minutes * 60_000).toISOString();

function git(cwd: string, env: Record<string, string>, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, ...env } });
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

describe('tests-cli gaps: пробелы блока перед сдачей', { timeout: 60_000 }, () => {
  let dir = '';
  const gaps = () => {
    const result = spawnSync(process.execPath, [CLI, 'gaps', '--project', dir, '--since', at(0)], {
      encoding: 'utf8',
      timeout: 50_000,
    });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-tests-cli-gaps-'));
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
    commit(dir, { 'src/auth/login.ts': 'export const a = 2;\n' }, at(10));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('задетый кейс без прогона — строка пробела с кейсом и командой, код 1', () => {
    const result = gaps();
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/^- .*auth-001/m);
    expect(result.out).toContain('run --project .');
    expect(result.out).not.toContain('пробелов перед сдачей нет');
  });

  it('прогон после последней правки — пробелов нет, код 0', () => {
    writeRun(dir, passedRun('r1', at(20)));
    const result = gaps();
    expect(result.out).toContain('Блок «Тесты»: пробелов перед сдачей нет.');
    expect(result.code).toBe(0);
  });

  it('правка после прогона — прогон устарел, снова пробел', () => {
    writeRun(dir, passedRun('r1', at(20)));
    commit(dir, { 'src/auth/login.ts': 'export const a = 3;\n' }, at(30));
    const result = gaps();
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/^- .*r1/m);
  });
});
