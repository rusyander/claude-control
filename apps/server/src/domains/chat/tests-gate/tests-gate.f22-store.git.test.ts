import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGroup, upsertCase } from '../../project-tests/store/store.ts';
import { importResults } from '../../project-tests/import-results/import-results.ts';
import { recordAgentResults } from '../../project-tests/agent-write/agent-write.ts';
import { readRuns } from '../../project-tests/runs-store/runs-store.ts';
import { testsDeliveryGaps } from './tests-gate.ts';

/**
 * F-22 через настоящее хранилище блока «Тесты»: исполненный красный пишет
 * импорт отчёта JUnit (`importResults` — тот же писатель, что у `tests-cli run`),
 * слово агента — `recordAgentResults` (писатель `tests-cli record`, запись
 * `attested`), а ворота доставки группы (`testsDeliveryGaps`) читают их с диска
 * копии сами. Подменены только даты коммитов и прогонов.
 */
const COMMAND = 'node tests-cli.mjs run --project .';
const STARTED = Date.parse('2026-10-23T10:00:00.000Z');
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

const junit = (caseId: string) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites><testsuite name="api" tests="1" failures="1">',
    `<testcase classname="api" name="[${caseId}] handler answers 200">`,
    '<failure message="expected 200, got 500">expected 200, got 500</failure>',
    '</testcase></testsuite></testsuites>',
  ].join('\n');

describe(
  'F-22 через хранилище блока: слово после исполненного красного',
  { timeout: 60_000 },
  () => {
    let dir = '';
    let caseId = '';

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cc-tests-gate-f22-'));
      git(dir, {}, 'init', '-q', '-b', 'main');
      // `.agent/` вне git, как в проекте: копия получает его зеркалом.
      mkdirSync(join(dir, '.git', 'info'), { recursive: true });
      writeFileSync(join(dir, '.git', 'info', 'exclude'), '.agent/\n');
      commit(dir, { 'src/api/handler.ts': 'export const status = 200;\n' }, at(-60));
      createGroup(dir, 'api', 'API');
      // Ручной кейс: `record` словом принимает только такие (решение 10.10).
      caseId = upsertCase(
        dir,
        'api',
        { title: 'Обработчик отвечает 200', codePaths: ['src/api'] },
        at(-60),
      ).id;
      commit(dir, { 'src/api/handler.ts': 'export const status = 500;\n' }, at(10));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });

    it('исполненный красный (импорт JUnit), затем record …=blocked — ворота держат пробел «красный»', async () => {
      const imported = importResults(dir, { format: 'junit', content: junit(caseId), now: at(20) });
      expect(imported.matched).toBeGreaterThan(0);
      recordAgentResults(
        dir,
        [{ groupId: 'api', caseId, status: 'blocked', note: 'no stand here' }],
        at(30),
      );
      // Обе записи — на диске, и слово читается как `attested`.
      const runs = readRuns(dir);
      expect(runs.map((run) => Boolean(run.attested)).sort()).toEqual([false, true]);

      const gaps = await testsDeliveryGaps({ cwd: dir, startedAt: at(0), command: COMMAND });

      expect(gaps.missing).toEqual(expect.arrayContaining([expect.stringContaining(caseId)]));
      expect(gaps.noted ?? []).not.toContain(caseId);
    });
  },
);
