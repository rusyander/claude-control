import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, upsertCase } from './store/store.ts';
import { readRuns } from './runs-store/runs-store.ts';

/**
 * F3 (g0 27.10): кейс mod-llmbox на Windows идёт только с `--cmd "set PYTHONPATH=…"` —
 * группа переписывала строку в каждый `run`, а `--stale` и `--base` её не знали. Теперь
 * команда кейса задаётся раз (`tests-cli case-cmd`), лежит в `.agent/tests/case-commands.json`
 * копии вне git и берётся run, run --stale и run --base. Настоящий CLI, настоящий git.
 */
const CLI = resolve(__dirname, '../../../../../tools/tests-cli.mjs');
const STARTED = '2026-10-27T10:00:00.000Z';
/** Автотест: печатает, кто его позвал, и пишет зелёный JUnit кейса. */
const CHECK = `import { writeFileSync } from 'node:fs';
console.log('called-by: ' + process.argv[3]);
writeFileSync(process.argv[2], '<?xml version="1.0"?><testsuites><testsuite name="s" tests="1"><testcase name="[llm-001] value" classname="check.mjs"/></testsuite></testsuites>');
`;
const OWN = 'node check.mjs {report} own-command';

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

describe('tests-cli case-cmd: своя команда кейса у копии', { timeout: 180_000 }, () => {
  let dir = '';
  const cli = (...args: string[]) => {
    const result = spawnSync(process.execPath, [CLI, ...args, '--project', dir], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, AGENTDECK_BRIEF_OUTPUT: '' },
    });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  };
  const stored = join('.agent', 'tests', 'case-commands.json');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-tests-cli-own-'));
    git(dir, 'init', '-q', '-b', 'main');
    // `.agent/` НЕ исключён: файл команды обязан уйти из git сам.
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '');
    commit(dir, { 'src/value.txt': 'ok\n', 'check.mjs': CHECK }, 'main');
    git(dir, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'checkout', '-q', '-b', 'feat');
    commit(dir, { 'src/value.txt': 'ok, branch\n' }, 'feat');
    createGroup(dir, 'llm', 'llm');
    upsertCase(
      dir,
      'llm',
      {
        title: 'Значение src/value.txt читается',
        steps: ['node check.mjs'],
        expected: 'check.mjs › [llm-001] value проходит',
        codePaths: ['src'],
        automation: { status: 'automated', file: 'check.mjs' },
      },
      '2026-10-27T09:00:00.000Z',
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('задана раз — лежит вне git (путь дописан в info/exclude), видна в show и в списке', () => {
    const set = cli('case-cmd', 'llm:llm-001', '--cmd', OWN);
    expect(set.code, set.out).toBe(0);
    expect(set.out).toContain('путь дописан в info/exclude');
    expect(JSON.parse(readFileSync(join(dir, stored), 'utf8')).commands['llm:llm-001'].cmd).toBe(
      OWN,
    );
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '/.agent/tests/case-commands.json',
    );
    expect(git(dir, 'status', '--porcelain', '--', stored)).toBe('');
    expect(cli('show', 'llm:llm-001').out).toContain(`Своя команда копии: ${OWN}`);
    expect(cli('case-cmd').out).toContain(`llm:llm-001 — ${OWN}`);
  });

  it('run без --cmd берёт свою команду; явный --cmd сильнее; --clear снимает', () => {
    expect(cli('case-cmd', 'llm:llm-001', '--cmd', OWN).code).toBe(0);
    const own = cli('run', '--case', 'llm:llm-001', '--full', '--fresh');
    expect(own.code, own.out).toBe(0);
    expect(own.out).toContain(`своя команда копии: ${OWN}`);
    expect(own.out).toContain('called-by: own-command');
    expect(readRuns(dir)[0]?.results[0]?.status).toBe('passed');
    const explicit = cli(
      'run',
      '--case',
      'llm:llm-001',
      '--full',
      '--fresh',
      '--cmd',
      'node check.mjs {report} explicit',
    );
    expect(explicit.out).toContain('called-by: explicit');
    expect(cli('case-cmd', 'llm:llm-001', '--clear').code).toBe(0);
    expect(cli('case-cmd').out).toContain('Своих команд кейсов у копии нет');
  });

  it('run --stale и run --base берут её же', () => {
    expect(cli('case-cmd', 'llm:llm-001', '--cmd', OWN).code).toBe(0);
    const stale = cli('run', '--stale', '--since', STARTED, '--full');
    expect(stale.code, stale.out).toBe(0);
    expect(stale.out).toContain('called-by: own-command');
    const base = cli('run', '--base', '--case', 'llm:llm-001', '--full');
    expect(base.code, base.out).toBe(0);
    expect(base.out).toContain('called-by: own-command');
    expect(base.out).toContain('Прогон на развилке записан');
  });

  it('файл команды под git — отказ до записи: рецепт машины в репозиторий не уходит', () => {
    mkdirSync(join(dir, '.agent', 'tests'), { recursive: true });
    writeFileSync(join(dir, stored), '{"version":1,"commands":{}}\n');
    git(dir, 'add', '-f', stored);
    const set = cli('case-cmd', 'llm:llm-001', '--cmd', OWN);
    expect(set.code).toBe(1);
    expect(set.out).toContain('под git');
    expect(existsSync(join(dir, stored))).toBe(true);
    expect(readFileSync(join(dir, stored), 'utf8')).not.toContain(OWN);
  });
});
