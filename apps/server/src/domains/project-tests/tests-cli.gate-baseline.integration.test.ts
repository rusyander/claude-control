import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import { createGroup, upsertCase } from './store/store.ts';
import { writeRun } from './runs-store/runs-store.ts';

/**
 * Конец хода группы (`tests-cli gate --defer-runs`, хук Stop) и её доставка судят
 * красное одним правилом (g3 25.10): набор, красный слово в слово как на основной
 * до старта группы, доставка пишет заметкой — и ход им больше не держится. Старт
 * группы CLI читает из `state.json` панели (`CLAUDE_CONFIG_DIR`). Настоящий
 * процесс CLI на настоящем git; подменены только даты.
 */
const CLI = resolve(__dirname, '../../../../../tools/tests-cli.mjs');
const STARTED = Date.parse('2026-10-25T10:00:00.000Z');
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

const redRun = (id: string, startedAt: string, note: string): ProjectTestRunRecord =>
  ({
    id,
    mode: 'import',
    actor: 'ci',
    status: 'done',
    startedAt,
    finishedAt: startedAt,
    results: [
      { pointId: 'pkg|pkg-001', groupId: 'pkg', caseId: 'pkg-001', status: 'failed', note },
    ],
    summary: { total: 1, passed: 0, failed: 1, skipped: 0, blocked: 0 },
  }) as ProjectTestRunRecord;

describe(
  'tests-cli gate: красное с основной не держит конец хода группы',
  { timeout: 60_000 },
  () => {
    let dir = '';
    let config = '';
    const gate = () => {
      const result = spawnSync(
        process.execPath,
        [CLI, 'gate', '--project', dir, '--since', at(15), '--defer-runs', 'src/pkg/a.go'],
        { encoding: 'utf8', timeout: 50_000, env: { ...process.env, CLAUDE_CONFIG_DIR: config } },
      );
      return `${result.stdout}${result.stderr}`;
    };

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cc-tests-cli-gate-'));
      config = mkdtempSync(join(tmpdir(), 'cc-tests-cli-gate-config-'));
      git(dir, {}, 'init', '-q', '-b', 'main');
      mkdirSync(join(dir, '.git', 'info'), { recursive: true });
      writeFileSync(join(dir, '.git', 'info', 'exclude'), '.agent/\n');
      commit(dir, { 'src/pkg/a.go': 'package pkg\n' }, at(-60));
      git(dir, {}, 'checkout', '-q', '-b', 'feat');
      createGroup(dir, 'pkg', 'Pkg');
      upsertCase(
        dir,
        'pkg',
        {
          title: 'Набор пакета pkg',
          steps: ['go test ./src/pkg/...'],
          expected: 'Все тесты пакета проходят',
          codePaths: ['src/pkg'],
          automation: { status: 'automated', file: 'src/pkg/a_test.go' },
        },
        at(-60),
      );
      mkdirSync(join(config, 'agentdeck'), { recursive: true });
      writeFileSync(
        join(config, 'agentdeck', 'state.json'),
        JSON.stringify({ splitPlans: { p: { groups: [{ path: dir, startedAt: at(0) }] } } }),
      );
      // На основной до старта группы набор уже красный.
      writeRun(dir, redRun('base', at(-30), '✗ 2/59 · TestUnreadable'));
      commit(dir, { 'src/pkg/a.go': 'package pkg\n\n// b\n' }, at(10));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      rmSync(config, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });

    it('красный слово в слово как до старта (счёт без общего числа) — ход не держит', () => {
      writeRun(dir, redRun('turn', at(20), '✗ 2/60 · TestUnreadable'));
      expect(gate()).not.toContain('red this turn');
    });

    it('упавших больше — ход держит, как раньше', () => {
      writeRun(dir, redRun('turn', at(20), '✗ 3/60 · TestUnreadable'));
      expect(gate()).toContain('red this turn (pkg:pkg-001)');
    });
  },
);
