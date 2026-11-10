import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Настоящий `tools/qa/junit-run.mjs` над записанными проходами (`*.recorded.mjs`) во временном
 * проекте: имя теста кейса сверяется со строкой-меткой спека буква в букву (кусок имени — провал
 * «не найден», а не зелёный), спек идёт без аргументов, `--max-failures 1` встаёт на первом
 * провале — следующий файл ложится «не запускался».
 */
const JUNIT_RUN = resolve(__dirname, '../../../../../../tools/qa/junit-run.mjs');

const spec = (name: string, code: number) =>
  `// recorded-test: ${name}\n` +
  `console.log(process.argv.length > 2 ? '✗ шаг 1: аргументы' : ${JSON.stringify(code === 0 ? '✓ шаг 1: открыть' : '✗ шаг 3: нажать button «Войти»')});\n` +
  `process.exit(process.argv.length > 2 ? 1 : ${code});\n`;

const linked = (id: string, file: string, testName: string) => ({
  id,
  type: 'case',
  title: id,
  automation: { status: 'automated', file, testName },
});

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function junitRun(files: Record<string, string>, cases: object[], extra: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'junit-run-recorded-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), body);
  }
  mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
  writeFileSync(join(root, '.agent', 'tests', 'g.tests.json'), JSON.stringify({ id: 'g', cases }));
  const out = join(root, 'out', 'junit.xml');
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '' };
  delete env.AGENTDECK_TEST_CASES;
  delete env.JUNIT_RUN_MAX_FAILURES;
  const run = spawnSync(
    process.execPath,
    [JUNIT_RUN, '--project', root, '--out', out, ...extra, ...Object.keys(files)],
    { cwd: root, encoding: 'utf8', timeout: 60_000, env },
  );
  return { run, report: readFileSync(out, 'utf8') };
}

const testcase = (report: string, caseId: string) =>
  report.match(
    new RegExp(`<testcase[^>]*name="\\[${caseId}\\][^"]*"[^>]*>([\\s\\S]*?)</testcase>`),
  )?.[1] ?? '';

describe('junit-run over recorded specs', { timeout: 90_000 }, () => {
  it('runs a recorded spec without args when the case names the full test name, fails a partial name', () => {
    const file = '.agent/tests/recorded/g/g-1.recorded.mjs';
    const { report } = junitRun(
      { [file]: spec('recorded > Вход на стенд', 0) },
      [
        linked('g-1', file, 'recorded > Вход на стенд'),
        linked('g-2', file, 'Вход на стенд'),
        linked('g-3', file, 'recorded > Вход'),
      ],
      [],
    );
    expect(testcase(report, 'g-1')).not.toMatch(/<failure|<skipped/);
    // Кусок имени — с конца или с начала — один провал «не найден» и ни одного зелёного прогона.
    for (const caseId of ['g-2', 'g-3']) {
      const all = [...report.matchAll(new RegExp(`<testcase[^>]*name="\\[${caseId}\\]`, 'g'))];
      expect(all, caseId).toHaveLength(1);
      expect(testcase(report, caseId)).toContain('<failure');
      expect(testcase(report, caseId)).toContain('не найден');
    }
  });

  it('--max-failures 1 stops at the first failing spec: the next one is not run', () => {
    const first = '.agent/tests/recorded/g/g-1.recorded.mjs';
    const second = '.agent/tests/recorded/g/g-2.recorded.mjs';
    const { run, report } = junitRun(
      { [first]: spec('recorded > a', 1), [second]: spec('recorded > b', 0) },
      [linked('g-1', first, 'recorded > a'), linked('g-2', second, 'recorded > b')],
      ['--max-failures', '1'],
    );
    expect(testcase(report, 'g-1')).toContain('✗ шаг 3: нажать button «Войти»');
    expect(testcase(report, 'g-2')).toContain('<skipped message="Не запускался');
    expect(run.stdout).not.toContain(`node ${second}`);
    expect(run.stdout).toContain('не запускалось после предела провалов 1');
  });
});
