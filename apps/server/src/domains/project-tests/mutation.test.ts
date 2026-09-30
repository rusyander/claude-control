import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MutationChecks, breakFile, mutationCandidates } from './mutation.ts';

/**
 * Проверка набора поломкой на настоящем git и настоящей команде прогона:
 * копия, поломка, прогон автокейсов, разбор отчёта — и рабочая копия человека
 * нетронута, копия убрана (решение владельца 30.09).
 */

const MATH = 'export const add = (a, b) => a + b;\nexport const big = (n) => n >= 10;\n';

/** «Раннер» проекта: проверяет модуль и пишет junit туда, куда велела панель. */
const CHECK = `import { writeFileSync } from 'node:fs';
let first = 'passed';
try {
  const math = await import('./src/math.mjs');
  if (math.add(2, 2) !== 4 || math.big(10) !== true) first = 'failed';
} catch {
  first = 'failed';
}
const row = (name, status) =>
  status === 'passed' ? '<testcase name="' + name + '"/>' : '<testcase name="' + name + '"><failure message="x"/></testcase>';
writeFileSync(
  process.env.AGENTDECK_JUNIT_REPORT,
  '<?xml version="1.0"?><testsuite>' + row('[math-001] add and big', first) + row('[math-002] smoke', 'passed') + '</testsuite>',
);
`;

function gitIn(dir: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
}

describe('проверка набора поломкой', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function project(): { dir: string; appData: string } {
    root = mkdtempSync(join(tmpdir(), 'mutation-'));
    const dir = join(root, 'repo');
    const appData = join(root, 'app-data');
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, '.agent', 'tests'), { recursive: true });
    writeFileSync(join(dir, 'src', 'math.mjs'), MATH);
    writeFileSync(join(dir, 'check.mjs'), CHECK);
    writeFileSync(join(dir, '.gitignore'), '.agent\n');
    writeFileSync(
      join(dir, '.agent', 'tests', 'automation.json'),
      JSON.stringify({ command: 'node check.mjs' }),
    );
    const automated = { status: 'automated', file: 'check.mjs' };
    writeFileSync(
      join(dir, '.agent', 'tests', 'math.tests.json'),
      JSON.stringify({
        title: 'Math',
        cases: [
          {
            id: 'math-001',
            title: 'add and big',
            steps: [],
            automation: automated,
            codePaths: ['src/math.mjs'],
          },
          { id: 'math-002', title: 'smoke', steps: [], automation: automated, codePaths: ['src'] },
          { id: 'math-003', title: 'manual', steps: [], codePaths: ['src/math.mjs'] },
        ],
      }),
    );
    gitIn(dir, ['init', '-q', '-b', 'main']);
    gitIn(dir, ['add', '.']);
    gitIn(dir, ['commit', '-q', '-m', 'init']);
    return { dir, appData };
  }

  const finished = async (checks: MutationChecks, dir: string) => {
    await vi.waitFor(() => expect(checks.status(dir)?.status).not.toBe('running'), {
      timeout: 60_000,
      interval: 100,
    });
    return checks.status(dir);
  };

  it('грубая поломка: пойман кейс, который файл исполняет; дымовой её не заметил', async () => {
    const { dir, appData } = project();
    const checks = new MutationChecks();
    const started = checks.start({ root: dir, appData, file: 'src/math.mjs' });
    expect(started).toMatchObject({ status: 'running', mutation: 'module throws on load' });
    expect(started.cases.map((item) => item.caseId)).toEqual(['math-001', 'math-002']);

    const check = await finished(checks, dir);
    expect(check).toMatchObject({ status: 'done', caught: 1, missed: 1 });
    expect(check?.cases.map((item) => [item.caseId, item.status])).toEqual([
      ['math-001', 'failed'],
      ['math-002', 'passed'],
    ]);
    // Рабочая копия человека нетронута, копия убрана, история не тронута.
    expect(readFileSync(join(dir, 'src', 'math.mjs'), 'utf8')).toBe(MATH);
    expect(gitIn(dir, ['worktree', 'list']).split('\n')).toHaveLength(1);
    expect(gitIn(dir, ['status', '--porcelain'])).toBe('');
  }, 90_000);

  it('тонкая поломка переворачивает сравнение — ловит проверка поведения', async () => {
    const { dir, appData } = project();
    const checks = new MutationChecks();
    const started = checks.start({ root: dir, appData, file: 'src/math.mjs', mode: 'subtle' });
    expect(started.mutation).toContain('n < 10');
    const check = await finished(checks, dir);
    expect(check).toMatchObject({ status: 'done', caught: 1 });
  }, 90_000);

  it('отказы: файл вне проекта, без привязанных кейсов, вторая проверка', async () => {
    const { dir, appData } = project();
    const checks = new MutationChecks();
    expect(() => checks.start({ root: dir, appData, file: '../x' })).toThrow(
      expect.objectContaining({ messageCode: 'mutation-file-invalid' }),
    );
    expect(() => checks.start({ root: dir, appData, file: 'check.mjs' })).toThrow(
      expect.objectContaining({ messageCode: 'mutation-no-cases' }),
    );
    checks.start({ root: dir, appData, file: 'src/math.mjs' });
    expect(() => checks.start({ root: dir, appData, file: 'src/math.mjs' })).toThrow(
      expect.objectContaining({ messageCode: 'mutation-busy' }),
    );
    checks.stop(dir);
    // Остановленная проверка ещё убирает копию — дождаться, чтобы не убрать каталог под ней.
    await vi.waitFor(() => expect(gitIn(dir, ['worktree', 'list']).split('\n')).toHaveLength(1), {
      timeout: 30_000,
      interval: 100,
    });
    expect(checks.status(dir)?.status).toBe('stopped');
  }, 60_000);

  it('кандидаты — файлы codePaths автокейсов, каталог не ломается целиком', () => {
    const { dir } = project();
    expect(mutationCandidates(dir)).toEqual([{ file: 'src/math.mjs', cases: 1 }]);
  });

  it('breakFile: код падает при загрузке, данные пустеют, нечего перевернуть — undefined', () => {
    expect(breakFile('x', 'a.py', 'break')?.text).toMatch(/^raise RuntimeError/);
    expect(breakFile('{"a":1}', 'a.json', 'break')).toEqual({
      text: '',
      description: 'file emptied',
    });
    expect(breakFile('const a = 1; // a === b', 'a.ts', 'subtle')).toBeUndefined();
    expect(breakFile('if (a === b) go();', 'a.ts', 'subtle')?.text).toBe('if (a !== b) go();');
  });
});
