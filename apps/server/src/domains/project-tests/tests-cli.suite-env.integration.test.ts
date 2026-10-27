import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, upsertCase } from './store/store.ts';
import { readRuns } from './runs-store/runs-store.ts';

/**
 * M2 (g5 27.10) через настоящий CLI: рецепт окружения набора жил в блокноте группы, `run
 * --stale` его не знал, и сборка Go, упавшая на «missing go.sum entry», легла в историю
 * пятью красными. Теперь `env` в `.agent/tests/automation.json` (каталог → переменные)
 * доходит до команды сам, разные окружения идут частями, а провал окружения Go ложится
 * «заблокирован» с причиной и кодом 75.
 *
 * Автотест кейса — настоящий процесс: печатает переменную, которую получил, и пишет JUnit
 * по файлам `{files}` (в файле кейса — его id и, если нужно, текст падения).
 */
const CLI = resolve(__dirname, '../../../../../tools/tests-cli.mjs');
const CHECK = `import { readFileSync, writeFileSync } from 'node:fs';
const [report, ...files] = process.argv.slice(2);
let failed = false;
const cases = files.map((file) => {
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  console.log('SUITE_VAR[' + spec.id + ']=' + (process.env.SUITE_VAR ?? '-'));
  if (!spec.fail) return '<testcase name="[' + spec.id + '] env" classname="' + file + '"/>';
  failed = true;
  return '<testcase name="[' + spec.id + '] env" classname="' + file + '"><failure message="build failed">' + spec.fail + '</failure></testcase>';
});
writeFileSync(report, '<?xml version="1.0"?><testsuites><testsuite name="s" tests="' + cases.length + '">' + cases.join('') + '</testsuite></testsuites>');
process.exit(failed ? 1 : 0);
`;
const CMD = ['--cmd', 'node check.mjs {report} {files}', '--full', '--fresh'];
const GO_SUM_FAIL =
  'inst-auth/handler.go:7:2: missing go.sum entry for module providing package github.com/x/y (imported by example.com/inst-auth); to add: go get example.com/inst-auth';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
}

describe('tests-cli run: окружение набора из automation.json', { timeout: 180_000 }, () => {
  let dir = '';
  const cli = (...args: string[]) => {
    const result = spawnSync(process.execPath, [CLI, ...args, '--project', dir], {
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, AGENTDECK_BRIEF_OUTPUT: '', SUITE_VAR: '' },
    });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  };
  const automation = (env: unknown) =>
    writeFileSync(
      join(dir, '.agent', 'tests', 'automation.json'),
      JSON.stringify({ version: 1, env }),
    );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-tests-cli-env-'));
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '.agent/\n');
    write(dir, {
      'check.mjs': CHECK,
      'a/a.json': JSON.stringify({ id: 'env-001' }),
      'b/b.json': JSON.stringify({ id: 'env-002' }),
      'inst-auth/go.json': JSON.stringify({ id: 'env-003', fail: GO_SUM_FAIL }),
    });
    git(dir, 'add', '.');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'main');
    createGroup(dir, 'env', 'env');
    for (const [title, file] of [
      ['Набор a', 'a/a.json'],
      ['Набор b', 'b/b.json'],
      ['Набор inst-auth', 'inst-auth/go.json'],
    ] as const)
      upsertCase(
        dir,
        'env',
        {
          title,
          steps: ['node check.mjs'],
          expected: `${file} проходит`,
          codePaths: [dirname(file)],
          automation: { status: 'automated', file },
        },
        '2026-10-27T09:00:00.000Z',
      );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('узкий ключ перекрывает корневой, {copy} — корень копии; разные окружения — частями, у каждой своя запись', () => {
    automation({ '.': { SUITE_VAR: 'root:{copy}' }, a: { SUITE_VAR: 'a-value' } });
    const ran = cli('run', '--case', 'env:env-001,env:env-002', ...CMD);
    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).toContain('Кейсы идут частями (2)');
    expect(ran.out).toContain('SUITE_VAR[env-001]=a-value');
    expect(ran.out).toMatch(new RegExp(`SUITE_VAR\\[env-002\\]=root:.*${basename(dir)}`));
    expect(ran.out).toContain('окружение набора SUITE_VAR (automation.json «env»: ., a)');
    const runs = readRuns(dir);
    expect(runs).toHaveLength(2);
    expect(runs.flatMap((run) => run.results.map((item) => item.status))).toEqual([
      'passed',
      'passed',
    ]);
  });

  it('один набор — одной частью: переменная дошла, строка вывода называет её источник', () => {
    automation({ a: { SUITE_VAR: 'only-a' } });
    const ran = cli('run', '--case', 'env:env-001', ...CMD);
    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).not.toContain('Кейсы идут частями');
    expect(ran.out).toContain('Кейсы несут своё: окружение набора SUITE_VAR');
    expect(ran.out).toContain('SUITE_VAR[env-001]=only-a');
  });

  it('провал сборки Go на окружении (go.sum вне git) — «заблокирован» с причиной и код 75; go.sum под git — красный', () => {
    const ran = cli('run', '--case', 'env:env-003', ...CMD);
    expect(ran.code, ran.out).toBe(75);
    expect(ran.out).toContain('Провал окружения, не кода (1)');
    const [record] = readRuns(dir);
    expect(record?.exitCode).toBe(75);
    expect(record?.results[0]?.status).toBe('blocked');
    expect(record?.results[0]?.note).toContain('Окружение, не код:');
    expect(record?.results[0]?.note).toContain('missing go.sum entry');
    // go.sum под git: недописанная запись — дефект ветки (не сделан go mod tidy).
    write(dir, { 'inst-auth/go.sum': 'hashes\n' });
    git(dir, 'add', '.');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'go.sum');
    const red = cli('run', '--case', 'env:env-003', ...CMD);
    expect(red.code, red.out).toBe(1);
    expect(readRuns(dir)[0]?.results[0]?.status).toBe('failed');
  });

  it('env с ключом наружу — отказ словами до прогона, истории нет', () => {
    automation({ '../other': { SUITE_VAR: 'x' } });
    const ran = cli('run', '--case', 'env:env-001', ...CMD);
    expect(ran.code).toBe(1);
    expect(ran.out).toContain('не каталог от корня проекта');
    expect(readRuns(dir)).toHaveLength(0);
  });
});
