import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redSignature } from '../chat/tests-gate/tests-gate.ts';
import { createGroup, upsertCase } from './store/store.ts';
import { readBaseRuns, readRuns } from './runs-store/runs-store.ts';

/**
 * F-03 (g0 25.10): `run --base` ради ОДНОГО красного теста гонял на развилке весь набор
 * (pytest mod-llmbox: 2105 тестов, 2 мин 14 с). Здесь настоящий `go test` (pytest на этой
 * машине не стоит — его выбор доказан в `red-filter.test.ts` от отчёта до строки), настоящий
 * git с worktree на развилке и настоящий CLI: развилка гонит только красное ветки, и вердикт
 * ворот по подписи остаётся тем же, что дал бы прогон целиком.
 */
const CLI = resolve(__dirname, '../../../../../tools/tests-cli.mjs');
const STARTED = '2026-10-25T10:00:00.000Z';
const HAS_GO = spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0;
const TESTS = `package pkg

import (
	"os"
	"strings"
	"testing"
)

func value(t *testing.T, file string) string {
	body, err := os.ReadFile("../src/" + file)
	if err != nil {
		return "absent"
	}
	return strings.TrimSpace(string(body))
}

func TestValue(t *testing.T) {
	if got := value(t, "value.txt"); got != "ok" {
		t.Fatalf("value: %s", got)
	}
}

func TestBranch(t *testing.T) {
	if got := value(t, "branch.txt"); got == "broken" {
		t.Fatalf("branch: %s", got)
	}
}

func TestOne(t *testing.T) {}
func TestTwo(t *testing.T) {}
`;
const CASE = 'gopkg:gopkg-001';
const RUN = ['--case', CASE, '--cmd', 'go test -json ./{files} > {report}', '--full'];

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

describe.runIf(HAS_GO)(
  'tests-cli run --base: на развилке — только красные тесты ветки',
  { timeout: 240_000 },
  () => {
    let dir = '';
    const cli = (...args: string[]) => {
      const result = spawnSync(process.execPath, [CLI, ...args, '--project', dir], {
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, AGENTDECK_BRIEF_OUTPUT: '' },
      });
      return { code: result.status, out: `${result.stdout}${result.stderr}` };
    };
    const gaps = () => cli('gaps', '--since', STARTED);
    const branchResult = () =>
      readRuns(dir)[0]?.results.find((item) => item.caseId === 'gopkg-001');
    const forkResult = () =>
      readBaseRuns(dir)[0]?.results.find((item) => item.caseId === 'gopkg-001');

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cc-tests-cli-narrow-'));
      git(dir, 'init', '-q', '-b', 'main');
      writeFileSync(join(dir, '.git', 'info', 'exclude'), '.agent/\n');
      commit(
        dir,
        {
          'go.mod': 'module example.com/m\n\ngo 1.21\n',
          'pkg/value_test.go': TESTS,
          'src/value.txt': 'broken on windows\n',
        },
        'main',
      );
      git(dir, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');
      git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      git(dir, 'checkout', '-q', '-b', 'feat');
      commit(dir, { 'src/other.txt': 'branch work\n' }, 'feat');
      createGroup(dir, 'gopkg', 'Go pkg');
      upsertCase(
        dir,
        'gopkg',
        {
          title: 'Пакет pkg',
          steps: ['go test ./pkg/'],
          expected: 'все тесты pkg проходят',
          // Весь `src`: дифф ветки задевает кейс — снимает только красное с той же подписью.
          codePaths: ['src', 'pkg'],
          automation: { status: 'automated', file: 'pkg/', suite: 'example.com/m/pkg' },
        },
        '2026-10-25T09:00:00.000Z',
      );
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });

    it('один красный из четырёх: развилка гонит -run ^(TestValue)$, подпись та же — ворота снимают', () => {
      expect(cli('run', ...RUN, '--fresh').code).toBe(1);
      expect(branchResult()).toMatchObject({
        status: 'failed',
        failedTests: [{ name: 'TestValue', owner: 'example.com/m/pkg' }],
      });
      expect(branchResult()?.note).toMatch(/^✗ 1\/4 · TestValue/);
      expect(gaps().code).toBe(1);

      const base = cli('run', '--base', ...RUN);
      expect(base.out).toContain('На развилке — только красные тесты ветки (go): 1');
      expect(base.out).toMatch(/Команда: go test -run ["']\^\(TestValue\)\$["'] -json \.\/pkg\//);
      // Развилка прогнала один тест, а не четыре — и подпись совпала с веткой без общего счёта.
      expect(forkResult()?.note).toMatch(/^✗ 1\/1 · TestValue/);
      expect(redSignature(forkResult()!)).toBe(redSignature(branchResult()!));
      expect(base.out).toContain(`${CASE} — та же подпись, что у ветки: ворота снимут его с ветки`);
      const after = gaps();
      expect(after.code).toBe(0);
      expect(after.out).toContain('на развилке с основной: gopkg-001');
    });

    it('ветка сломала ещё один тест: развилка гонит оба, у неё красный один — подпись не та, ворота держат', () => {
      commit(dir, { 'src/branch.txt': 'broken\n' }, 'branch breaks');
      expect(cli('run', ...RUN, '--fresh').code).toBe(1);
      expect(branchResult()?.note).toMatch(/^✗ 2\/4 · /);
      const base = cli('run', '--base', ...RUN);
      expect(base.out).toContain('На развилке — только красные тесты ветки (go): 2');
      expect(forkResult()?.note).toMatch(/^✗ 1\/2 · TestValue/);
      expect(base.out).toContain(`${CASE} — подпись не та, что у ветки: это не довод`);
      expect(gaps().code).toBe(1);
    });

    it('красное только у ветки: на развилке выбранный тест зелёный — красное ветки её, ворота держат', () => {
      commit(dir, { 'src/value.txt': 'ok\n', 'src/branch.txt': 'broken\n' }, 'branch');
      git(dir, 'checkout', '-q', 'main');
      commit(dir, { 'src/value.txt': 'ok\n' }, 'main fixed');
      git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      git(dir, 'checkout', '-q', 'feat');
      git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'rebase', '-q', 'main');
      expect(cli('run', ...RUN, '--fresh').code).toBe(1);
      expect(branchResult()?.failedTests).toEqual([
        { name: 'TestBranch', owner: 'example.com/m/pkg' },
      ]);
      const base = cli('run', '--base', ...RUN);
      expect(base.out).toContain('-run');
      expect(forkResult()).toMatchObject({ status: 'passed', note: '✓ 1' });
      expect(base.out).toContain(`${CASE} — зелёный на развилке: красное ветки — её`);
      expect(gaps().code).toBe(1);
    });

    // g9 26.10 (F7): репозиторий из многих go.mod гоняет `{go-modules}` — `go test -C <модуль>`.
    // `-run` вставал до `-C`, go отказывал «-C flag must be first flag», развилка не стартовала.
    it('{go-modules}: развилка гонит go test -C <модуль> -run …, go принимает строку', () => {
      git(dir, 'rm', '-q', 'go.mod', 'pkg/value_test.go', 'src/value.txt');
      commit(
        dir,
        {
          'svc/go.mod': 'module example.com/m\n\ngo 1.21\n',
          'svc/pkg/value_test.go': TESTS,
          'svc/src/value.txt': 'broken on windows\n',
          'other/go.mod': 'module example.com/other\n\ngo 1.21\n',
        },
        'modules',
      );
      git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      git(dir, 'checkout', '-q', '-B', 'feat');
      commit(dir, { 'svc/src/other.txt': 'branch work\n' }, 'feat');
      upsertCase(
        dir,
        'gopkg',
        {
          id: 'gopkg-001',
          title: 'Пакет pkg',
          steps: ['go test ./pkg/'],
          expected: 'все тесты pkg проходят',
          codePaths: ['svc'],
          automation: { status: 'automated', file: 'svc/pkg/', suite: 'example.com/m/pkg' },
        },
        '2026-10-25T09:00:00.000Z',
      );
      writeFileSync(
        join(dir, '.agent', 'tests', 'automation.json'),
        JSON.stringify({ version: 1, command: '{go-modules}', format: 'go-test-json' }),
      );
      const own = ['--case', CASE, '--full'];
      const branch = cli('run', ...own, '--fresh');
      // `|| echo -` цепочки держит код 0 — красное видно по отчёту.
      expect(branch.out).toContain('Команда: go test -C svc -json ./pkg >');
      expect(branchResult()?.failedTests).toEqual([
        { name: 'TestValue', owner: 'example.com/m/pkg' },
      ]);
      const base = cli('run', '--base', ...own);
      expect(base.out).not.toContain('-C flag must be first flag');
      expect(base.out).toMatch(
        /Команда: go test -C svc -run ["']\^\(TestValue\)\$["'] -json \.\/pkg/,
      );
      expect(forkResult()?.note).toMatch(/^✗ 1\/1 · TestValue/);
      expect(base.out).toContain(`${CASE} — та же подпись, что у ветки: ворота снимут его с ветки`);
    });

    it('--cmd с -failfast у кейса-каталога — предупреждение до прогона; без флага — нет', () => {
      const flagged = cli(
        'run',
        '--dry',
        '--case',
        CASE,
        '--cmd',
        'go test -failfast -json ./{files} > {report}',
      );
      expect(flagged.out).toContain(`Внимание: в --cmd флаг «-failfast»`);
      expect(flagged.out).toContain(CASE);
      const plain = cli('run', '--dry', ...RUN);
      expect(plain.out).not.toContain('Внимание: в --cmd флаг');
    });
  },
);
