import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, upsertCase } from './store/store.ts';
import { readRuns } from './runs-store/runs-store.ts';

/**
 * F2 (g0 27.10): группа прогнала ворота фронта (3:37), а через пять минут на том же дереве
 * `run --stale` гонял те же наборы снова (1:39). Ворота кладут JUnit в
 * `.agent/tests/gate-junit/<имя>.xml` и отпечаток дерева со старта (`tests-cli tree --out`);
 * `run --stale` засчитывает отчёт того же дерева без прогона, другого — называет и гонит.
 * Настоящий CLI, настоящий git; автотест кейса оставляет след запуска.
 */
const CLI = resolve(__dirname, '../../../../../tools/tests-cli.mjs');
const STARTED = '2026-10-27T10:00:00.000Z';
const CHECK = `import { writeFileSync } from 'node:fs';
writeFileSync('ran.txt', 'ran');
writeFileSync(process.argv[2], '<?xml version="1.0"?><testsuites><testsuite name="s" tests="1"><testcase name="[front-001] value" classname="check.mjs"/></testsuite></testsuites>');
`;
const GATE_JUNIT =
  '<?xml version="1.0"?><testsuites><testsuite name="gate" tests="1"><testcase name="[front-001] value" classname="check.mjs"/></testsuite></testsuites>';
const STALE = ['run', '--stale', '--since', STARTED, '--cmd', 'node check.mjs {report}', '--full'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commit(dir: string, files: Record<string, string>, message: string): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git(dir, 'add', '.');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message);
}

describe('tests-cli run --stale: отчёт ворот на том же дереве', { timeout: 180_000 }, () => {
  let dir = '';
  const cli = (...args: string[]) => {
    const result = spawnSync(process.execPath, [CLI, ...args, '--project', dir], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, AGENTDECK_BRIEF_OUTPUT: '' },
    });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  };
  const drop = join('.agent', 'tests', 'gate-junit');
  /** Ворота: отпечаток дерева на старте, затем их JUnit. */
  const gate = () => {
    const tree = cli('tree', '--out', join(drop, 'front.tree'));
    expect(tree.code, tree.out).toBe(0);
    writeFileSync(join(dir, drop, 'front.xml'), GATE_JUNIT);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-tests-cli-gate-'));
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '.agent/\nran.txt\n');
    commit(dir, { 'src/value.txt': 'ok\n', 'check.mjs': CHECK }, 'main');
    git(dir, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'checkout', '-q', '-b', 'feat');
    commit(dir, { 'src/value.txt': 'ok, branch\n' }, 'feat');
    createGroup(dir, 'front', 'front');
    upsertCase(
      dir,
      'front',
      {
        title: 'Значение src/value.txt читается',
        steps: ['node check.mjs'],
        expected: 'check.mjs › [front-001] value проходит',
        codePaths: ['src'],
        automation: { status: 'automated', file: 'check.mjs' },
      },
      '2026-10-27T09:00:00.000Z',
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('отчёт ворот того же дерева засчитан без прогона: запись в истории, автотест не запущен, пара убрана', () => {
    gate();
    const tree = readFileSync(join(dir, drop, 'front.tree'), 'utf8').trim();
    expect(tree).toMatch(/^[0-9a-f]{64}$/);
    const stale = cli(...STALE);
    expect(stale.code, stale.out).toBe(0);
    expect(stale.out).toContain('Отчёт ворот front снят на этом же дереве — засчитан без прогона');
    expect(stale.out).toContain('прогонять нечего');
    expect(existsSync(join(dir, 'ran.txt'))).toBe(false);
    const [record] = readRuns(dir);
    expect(record?.results.map((item) => [item.caseId, item.status])).toEqual([
      ['front-001', 'passed'],
    ]);
    expect(record?.tree).toBe(tree);
    expect(record?.origin).toBe('ci');
    expect(existsSync(join(dir, drop, 'front.xml'))).toBe(false);
    expect(existsSync(join(dir, drop, 'front.tree'))).toBe(false);
  });

  it('дерево сдвинулось после ворот — отчёт не засчитан, назван и оставлен, кейс идёт прогоном', () => {
    gate();
    writeFileSync(join(dir, 'src', 'value.txt'), 'ok, edited after gate\n');
    const stale = cli(...STALE);
    expect(stale.code, stale.out).toBe(0);
    expect(stale.out).toContain('Отчёт ворот front: снят на другом дереве — не засчитан');
    expect(existsSync(join(dir, 'ran.txt'))).toBe(true);
    expect(existsSync(join(dir, drop, 'front.xml'))).toBe(true);
  });

  it('отчёт без отпечатка дерева — не довод: назван, кейс идёт прогоном', () => {
    mkdirSync(join(dir, drop), { recursive: true });
    writeFileSync(join(dir, drop, 'front.xml'), GATE_JUNIT);
    const stale = cli(...STALE);
    expect(stale.out).toContain('без отпечатка дерева (front.tree)');
    expect(existsSync(join(dir, 'ran.txt'))).toBe(true);
  });
});
