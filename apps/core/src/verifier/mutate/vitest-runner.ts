import { dirname, join } from 'node:path';
import { runTool } from '../../platform/run-tool.ts';
import { readBytesSync, pathExists } from '../../platform/safe-io/files.ts';
import { removeVerified } from '../../platform/safe-io/remove.ts';
import type { TestRunContext, TestRunner, TestRunOutcome } from './mutate.types.ts';

/**
 * Раннер мутанта по умолчанию — vitest (формат плана mustfail: `test` = имя для `-t`, `spec` = файл).
 * Итог читается из json-отчёта, а не из строк консоли: «убит» значит «названный тест упал на своём
 * утверждении», и это видно только по статусу самого теста. Файл, что не собрался (импорт,
 * синтаксис), — не убийство (тот же довод, что у red-before, P94): мутант назван выжившим с причиной.
 */

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
let reportSeq = 0;

export interface VitestRunnerOptions {
  /** Путь к `vitest.mjs`; по умолчанию — ближайший `node_modules/vitest` вверх от корня плана. */
  entry?: string;
  extraArgs?: string[];
  timeoutMs?: number;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `-t` vitest 4 сверяет с полным именем через пробел, vitest 5 — через « > »; план пишет путь
 * «a > b > it» (AGENTS §Tests block). Разделитель берёт обе формы — тот же, что у `selectionArgs`.
 */
export function namePattern(test: string): string {
  return test.split(' > ').map(escapeRegExp).join('(?: > | )');
}

export function findVitestEntry(root: string): string | undefined {
  let dir = root;
  for (;;) {
    const entry = join(dir, 'node_modules', 'vitest', 'vitest.mjs');
    if (pathExists(entry)) return entry;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

interface JsonAssertion {
  ancestorTitles?: string[];
  title?: string;
  status?: string;
}
interface JsonFile {
  status?: string;
  message?: string;
  name?: string;
  assertionResults?: JsonAssertion[];
}

function statusOf(status: string | undefined): 'passed' | 'failed' | 'skipped' {
  if (status === 'passed' || status === 'failed') return status;
  return 'skipped';
}

/**
 * Итоги названного теста из json-отчёта vitest. Путь — целиком или путь describe, что его покрывает
 * (от внешнего describe, AGENTS §Tests block); хвост « > имя» не годится: тест-сосед с тем же листом
 * в другом describe убил бы мутанта вместо названного.
 */
export function parseVitestReport(json: string, test: string, exit: number | null): TestRunOutcome {
  let report: { testResults?: JsonFile[] };
  try {
    report = JSON.parse(json) as { testResults?: JsonFile[] };
  } catch {
    return { kind: 'not-run', reason: 'json-отчёт vitest не разбирается' };
  }
  const tests: { path: string; status: 'passed' | 'failed' | 'skipped' }[] = [];
  const fileErrors: string[] = [];
  for (const file of report.testResults ?? []) {
    const own = file.assertionResults ?? [];
    if (file.status === 'failed' && !own.some((a) => a.status === 'failed'))
      fileErrors.push(`${file.name ?? '?'}: ${(file.message ?? '').split('\n')[0] ?? ''}`);
    for (const a of own) {
      const path = [...(a.ancestorTitles ?? []), a.title ?? ''].join(' > ');
      if (path !== test && !path.startsWith(`${test} > `)) continue;
      tests.push({ path, status: statusOf(a.status) });
    }
  }
  return { kind: 'ran', tests, fileErrors, exit };
}

export function vitestRunner(options: VitestRunnerOptions = {}): TestRunner {
  return {
    async run(row, ctx: TestRunContext): Promise<TestRunOutcome> {
      const entry = options.entry ?? findVitestEntry(ctx.root);
      if (entry === undefined)
        return { kind: 'not-run', reason: `vitest не найден в node_modules вверх от ${ctx.root}` };
      reportSeq += 1;
      const report = join(ctx.scratchDir, `report-${reportSeq}.json`);
      // Отчёт под тем же именем мог оставить мёртвый прогон: vitest, упавший до записи, судился бы по нему.
      const cleared = removeVerified(report);
      if (!cleared.removed)
        return { kind: 'not-run', reason: `старый отчёт ${report} не удалился: ${cleared.reason}` };
      const run = await runTool(
        process.execPath,
        [
          entry,
          'run',
          row.spec,
          '--coverage.enabled=false',
          '-t',
          namePattern(row.test),
          '--reporter=json',
          `--outputFile=${report}`,
          ...(options.extraArgs ?? []),
        ],
        {
          cwd: ctx.root,
          env: ctx.env,
          acceptNonZero: true,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        },
      );
      if (!run.ok) return { kind: 'not-run', reason: `vitest: ${run.reason}` };
      const json = readBytesSync(report);
      if (!('value' in json)) {
        const tail = `${run.stdout}\n${run.stderr}`.trim().split('\n').slice(-5).join(' | ');
        return { kind: 'not-run', reason: `vitest не записал отчёт (exit ${run.code}): ${tail}` };
      }
      return parseVitestReport(json.value.toString('utf8'), row.test, run.code);
    },
  };
}
