import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_SIEVES,
  countClaimOf,
  judgeSieves,
  type SieveReportRow,
} from '@agentdeck/contracts/sieves';
import { importResults } from '../project-tests/import-results/import-results.ts';
import { readRun, writeRun } from '../project-tests/runs-store/runs-store.ts';
import { sieveProofFacts } from './sieve-proof/sieve-proof.ts';

/**
 * Аудит g0 25.10 (F-12): строка project-checks сказала «tests-cli: … 2117 passed», а прогон
 * за ней напечатал «1 failed, 2117 passed»; судья принял счёт словами, и он ушёл заметкой в
 * описание MR. Путь настоящий: прогон пишет `importResults` — тот же писатель, что у
 * `tests-cli run`, — из JUnit-отчёта, факты читает `sieveProofFacts` из истории копии,
 * решает `judgeSieves`. Подменять нечего: вопрос в том, что записал прогон и что сверил судья.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const checks = BUILTIN_SIEVES.find((sieve) => sieve.id === 'project-checks')!;

/** JUnit: три зелёных теста и один красный, все — кейсы группы `api`. */
const JUNIT =
  '<testsuites><testsuite name="api">' +
  '<testcase name="[api-001] a" classname="api" time="1"/>' +
  '<testcase name="[api-002] b" classname="api" time="1"/>' +
  '<testcase name="[api-003] c" classname="api" time="1"/>' +
  '<testcase name="[api-004] d" classname="api" time="1"><failure message="boom"/></testcase>' +
  '</testsuite></testsuites>';

function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sieve-count-'));
  dirs.push(dir);
  const git = (args: string[]): string =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'api.py'), 'x = 1\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  mkdirSync(join(dir, '.agent', 'tests'), { recursive: true });
  const cases = ['api-001', 'api-002', 'api-003', 'api-004'].map((id) => ({
    id,
    title: id,
    steps: [],
    status: 'unknown',
  }));
  writeFileSync(
    join(dir, '.agent', 'tests', 'api.tests.json'),
    JSON.stringify({ version: 1, title: 'API', cases }),
  );
  return dir;
}

const pass = (evidence: string): SieveReportRow => ({
  id: 'project-checks',
  status: 'pass',
  evidence,
});

async function judge(dir: string, evidence: string) {
  const rows = [pass(evidence)];
  const proof = await sieveProofFacts({ cwd: dir, rows, branchPaths: ['api.py'] });
  return judgeSieves({ applicable: [checks], rows, mechanics: {}, proof });
}

describe('счёт тестов в строке сита сверяется с прогоном (F-12)', () => {
  it('прогон записывает счёт тестов, а не кейсов', () => {
    const dir = copy();
    const { runId } = importResults(dir, { format: 'junit', content: JUNIT });
    expect(readRun(dir, runId!)?.tests).toEqual({ passed: 3, failed: 1, skipped: 0 });
  });

  it('прогон одной группы считает и тест кейса чужой группы — как итог tests-cli run', () => {
    const dir = copy();
    writeFileSync(
      join(dir, '.agent', 'tests', 'web.tests.json'),
      JSON.stringify({
        version: 1,
        title: 'Web',
        cases: [{ id: 'web-001', title: 'web-001', steps: [], status: 'unknown' }],
      }),
    );
    const junit = JUNIT.replace(
      '</testsuite>',
      '<testcase name="[web-001] w" classname="web" time="1"/></testsuite>',
    );
    const { runId } = importResults(dir, { format: 'junit', content: junit, groups: ['api'] });
    expect(readRun(dir, runId!)?.tests).toEqual({ passed: 4, failed: 1, skipped: 0 });
  });

  it('«3 passed» при прогоне «1 failed, 3 passed» — расхождение; полный счёт — принят', async () => {
    const dir = copy();
    const { runId } = importResults(dir, { format: 'junit', content: JUNIT });
    expect(await judge(dir, `tests-cli run → 3 passed (run:${runId})`)).toEqual([
      {
        code: 'sieve-gap-count-mismatch',
        params: {
          sieve: 'project-checks',
          claim: '3 passed',
          run: runId,
          passed: '3',
          failed: '1',
        },
      },
    ]);
    expect(await judge(dir, `tests-cli run → 1 failed, 3 passed (run:${runId})`)).toEqual([]);
    // Другое число «прошло» — тоже расхождение.
    expect((await judge(dir, `tests-cli run → 1 failed, 2 passed run:${runId}`))[0]?.code).toBe(
      'sieve-gap-count-mismatch',
    );
  });

  it('счёт tests-cli без ссылки — пробел называет последний прогон с его счётом', async () => {
    const dir = copy();
    const { runId } = importResults(dir, { format: 'junit', content: JUNIT });
    expect(await judge(dir, 'tests-cli run --project . → 3 passed')).toEqual([
      {
        code: 'sieve-gap-count-no-cite',
        params: {
          sieve: 'project-checks',
          claim: '3 passed',
          run: runId,
          passed: '3',
          failed: '1',
        },
      },
    ]);
  });

  it('прогонов нет — пробел «запишите прогон»; счёт чужой команды без tests-cli не сверяется', async () => {
    const dir = copy();
    expect((await judge(dir, 'tests-cli run → 3 passed'))[0]).toEqual({
      code: 'sieve-gap-count-no-run',
      params: { sieve: 'project-checks', claim: '3 passed' },
    });
    expect(await judge(dir, 'pytest mod-llmbox → 2117 passed')).toEqual([]);
  });

  it('старая запись без счёта — сверяется по заметкам: только «упало ли что-то»', async () => {
    const dir = copy();
    writeRun(dir, {
      id: 'old-run-0001',
      mode: 'import',
      actor: 'ci',
      status: 'done',
      startedAt: '2026-10-20T10:00:00.000Z',
      finishedAt: '2026-10-20T10:00:00.000Z',
      results: [
        {
          pointId: 'api:api-001',
          groupId: 'api',
          caseId: 'api-001',
          status: 'failed',
          note: '✗ 1/2118 · test_x: boom',
        },
      ],
      summary: { total: 1, passed: 0, failed: 1, blocked: 0, skipped: 0 },
    } as never);
    expect((await judge(dir, 'tests-cli → 2117 passed run:old-run-0001'))[0]).toMatchObject({
      code: 'sieve-gap-count-mismatch',
      params: { passed: '?', failed: '1' },
    });
    expect(await judge(dir, 'tests-cli → 1 failed, 2117 passed run:old-run-0001')).toEqual([]);
  });
});

describe('countClaimOf: какие числа — счёт тестов', () => {
  it('«N passed/failed», «passed: N», русские слова; запятая не делит число', () => {
    expect(countClaimOf('1 failed, 2117 passed')).toMatchObject({ passed: [2117], failed: [1] });
    expect(countClaimOf('passed: 40; failed=0')).toMatchObject({ passed: [40], failed: [0] });
    expect(countClaimOf('прошло 12, упал 1')).toBeUndefined();
    expect(countClaimOf('12 прошли, 1 упал')).toMatchObject({ passed: [12], failed: [1] });
    expect(countClaimOf('pnpm lint → 0 problems')).toBeUndefined();
    // Номер версии — не счёт.
    expect(countClaimOf('v1.2 passed')).toBeUndefined();
  });
});
