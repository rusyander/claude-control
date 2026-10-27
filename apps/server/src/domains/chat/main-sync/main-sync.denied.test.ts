import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import { writeRun } from '../../project-tests/runs-store/runs-store.ts';
import { buildsTargetTree, copyRedCases, MAIN_SYNC_DENIED, mainSyncDenied } from './main-sync.ts';

/**
 * F-09 (g0 25.10, прогон 1): `git worktree add --detach .agent/tmp/main-wt origin/main; go test …`
 * — проверить, «моё ли красное», — получил верный отказ, но без разрешённого пути, и прогон
 * кончился с двумя кейсами без ответа. Отказ дереву целевой теперь называет `run --base`.
 */
const G0 =
  'git worktree add --detach .agent/tmp/main-wt origin/main >/dev/null 2>&1; go test ./internal/pipeline -run "TestCallLLMRetries"';

const run = (
  startedAt: string,
  results: [string, ProjectTestRunRecord['results'][number]['status']][],
  status: ProjectTestRunRecord['status'] = 'done',
): ProjectTestRunRecord =>
  ({
    id: `run-${startedAt}`,
    mode: 'import',
    actor: 'ci',
    status,
    startedAt,
    results: results.map(([key, value], index) => {
      const [groupId, caseId] = key.split(':') as [string, string];
      return { pointId: `p${index}`, groupId, caseId, status: value };
    }),
  }) as ProjectTestRunRecord;

describe('отказ догону: дерево целевой ветки называет run --base (F-09)', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'main-sync-denied-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    G0,
    'git worktree add -b tmp ../wt origin/main',
    'git checkout --detach origin/main',
    'git switch --detach origin/master',
    'git archive origin/main | tar -x -C /tmp/m',
  ])('строит дерево целевой: %s', (command) => {
    expect(buildsTargetTree(command)).toBe(true);
  });

  it.each([
    'git rebase origin/main',
    'git merge origin/main',
    'git worktree add ../wt feature/x',
    'git worktree list',
    'git checkout feature/x',
    'git diff origin/main > p.diff',
  ])('не дерево целевой: %s', (command) => {
    expect(buildsTargetTree(command)).toBe(false);
  });

  it('красные кейсы копии — по последнему результату каждого; идущий прогон не в счёт', () => {
    writeRun(
      dir,
      run('2026-10-25T13:00:00.000Z', [
        ['g:a', 'failed'],
        ['g:b', 'failed'],
        ['g:c', 'blocked'],
      ]),
    );
    writeRun(dir, run('2026-10-25T14:00:00.000Z', [['g:b', 'passed']]));
    writeRun(dir, run('2026-10-25T15:00:00.000Z', [['g:a', 'passed']], 'running'));
    expect(copyRedCases(dir)).toEqual(['g:a', 'g:c']);
  });

  it('дерево целевой: отказ + команда --base с красными кейсами копии', () => {
    writeRun(
      dir,
      run('2026-10-25T13:00:00.000Z', [
        ['g:a', 'failed'],
        ['g:b', 'passed'],
      ]),
    );
    const text = mainSyncDenied(G0, dir);
    expect(text.startsWith(`${MAIN_SYNC_DENIED} `)).toBe(true);
    expect(text).toMatch(
      /`node "[^"]+[\\/]tools[\\/]tests-cli\.mjs" run --project \. --case g:a --base`/,
    );
  });

  it('красных не записано — образец списка, а не пустой --case', () => {
    expect(mainSyncDenied(G0, dir)).toContain('--case <group:case,group:case> --base');
  });

  it('обычный догон (rebase) — отказ как был, без пути --base', () => {
    writeRun(dir, run('2026-10-25T13:00:00.000Z', [['g:a', 'failed']]));
    expect(mainSyncDenied('git rebase origin/main', dir)).toBe(MAIN_SYNC_DENIED);
  });
});
