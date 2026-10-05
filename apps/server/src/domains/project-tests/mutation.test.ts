import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MutationChecks, breakFile, mutationCandidates, sweepMutationCopies } from './mutation.ts';

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
    // Остановленная, она ещё может заводить копию — и занята, пока её не уберёт:
    // вторая проверка поверх неё — отказ (ревью PR #1: стоп сразу после старта).
    expect(checks.status(dir)?.status).toBe('running');
    expect(() => checks.start({ root: dir, appData, file: 'src/math.mjs' })).toThrow(
      expect.objectContaining({ messageCode: 'mutation-busy' }),
    );
    expect(await finished(checks, dir)).toMatchObject({ status: 'stopped' });
    expect(gitIn(dir, ['worktree', 'list']).split('\n')).toHaveLength(1);
  }, 60_000);

  // Ревью PR #1: ошибка внутри прогона подменялась «отчёта нет» с пустым журналом.
  it('нет команды прогона — человек видит эту причину, а не «отчёта нет»', async () => {
    const { dir, appData } = project();
    rmSync(join(dir, '.agent', 'tests', 'automation.json'));
    const checks = new MutationChecks();
    checks.start({ root: dir, appData, file: 'src/math.mjs' });
    expect(await finished(checks, dir)).toMatchObject({
      status: 'error',
      errorCode: 'mutation-no-command',
    });
    expect(gitIn(dir, ['worktree', 'list']).split('\n')).toHaveLength(1);
  }, 60_000);

  // Ревью PR #1: отчёт по постоянному пути от прошлого прогона человека читался
  // как итог этой проверки — команда упала, а вердикт «не заметили».
  it('старый отчёт по пути automation.report не читается как итог проверки', async () => {
    const { dir, appData } = project();
    writeFileSync(
      join(dir, '.agent', 'tests', 'automation.json'),
      JSON.stringify({ command: 'node -e "process.exit(3)"', report: 'out/junit.xml' }),
    );
    mkdirSync(join(dir, 'out'));
    writeFileSync(
      join(dir, 'out', 'junit.xml'),
      '<?xml version="1.0"?><testsuite><testcase name="[math-001] add and big"/></testsuite>',
    );
    const checks = new MutationChecks();
    checks.start({ root: dir, appData, file: 'src/math.mjs' });
    expect(await finished(checks, dir)).toMatchObject({
      status: 'error',
      errorCode: 'mutation-no-report',
    });
  }, 60_000);

  // Ревью PR #1: помощник команды, унаследовавший её вывод, держал проверку
  // «идёт» до своего конца — уже после выхода самой команды.
  it('команда вышла — проверка кончается, даже если её помощник держит вывод', async () => {
    const { dir, appData } = project();
    const pidFile = join(root as string, 'helper.pid');
    // Помощник пишет свой pid наружу — тест гасит его сам: сироту проверка не убирает.
    const helper = [
      "const kid = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'inherit', detached: true });",
      "require('fs').writeFileSync(" + JSON.stringify(pidFile) + ', String(kid.pid));',
      'kid.unref(); process.exit(0);',
    ].join('\n');
    writeFileSync(join(dir, 'helper.cjs'), helper);
    writeFileSync(
      join(dir, '.agent', 'tests', 'automation.json'),
      JSON.stringify({ command: 'node helper.cjs' }),
    );
    const checks = new MutationChecks();
    const startedAt = Date.now();
    checks.start({ root: dir, appData, file: 'src/math.mjs' });
    expect(await finished(checks, dir)).toMatchObject({ status: 'error' });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    process.kill(Number(readFileSync(pidFile, 'utf8')));
    await new Promise((done) => setTimeout(done, 500));
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

  // Ревью 30.09: запись по ссылке ушла бы в настоящий файл вне копии. Ссылку на
  // файл под Windows без прав администратора не завести — там тест пропускается.
  it.skipIf(process.platform === 'win32')('файл-ссылка и файл зависимостей не ломаются', () => {
    const { dir, appData } = project();
    const outside = join(root as string, 'outside.mjs');
    writeFileSync(outside, MATH);
    symlinkSync(outside, join(dir, 'src', 'linked.mjs'));
    const checks = new MutationChecks();
    for (const file of ['src/linked.mjs', 'node_modules/x/index.js']) {
      expect(() => checks.start({ root: dir, appData, file })).toThrow(
        expect.objectContaining({ messageCode: 'mutation-file-invalid' }),
      );
    }
    expect(readFileSync(outside, 'utf8')).toBe(MATH);
  });

  it('новый, ещё не добавленный в git модуль едет в копию — проверка не падает на импорте', async () => {
    const { dir, appData } = project();
    writeFileSync(join(dir, 'src', 'extra.mjs'), 'export const extra = 1;\n');
    writeFileSync(
      join(dir, 'src', 'math.mjs'),
      `import { extra } from './extra.mjs';\n${MATH}export const one = extra;\n`,
    );
    const checks = new MutationChecks();
    checks.start({ root: dir, appData, file: 'src/math.mjs', mode: 'subtle' });
    const check = await finished(checks, dir);
    // Импорт нового модуля в копии цел: покраснел кейс поведения, дымовой — нет.
    expect(check).toMatchObject({ status: 'done', caught: 1, missed: 1 });
  }, 90_000);

  it('уборка при старте снимает копии прошлого процесса вместе с записью worktree', async () => {
    const { dir, appData } = project();
    const copy = join(appData, 'mutation-copies', 'stale');
    mkdirSync(join(appData, 'mutation-copies'), { recursive: true });
    gitIn(dir, ['worktree', 'add', '--detach', copy, 'HEAD']);
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'keep');
    // Тот же вид ссылки, что заводит сама проверка: junction под Windows.
    symlinkSync(
      join(dir, 'node_modules'),
      join(copy, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(await sweepMutationCopies(appData)).toBe(1);
    expect(existsSync(copy)).toBe(false);
    expect(gitIn(dir, ['worktree', 'list']).split('\n')).toHaveLength(1);
    // Ссылка снята, оригинал её цели цел.
    expect(readFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('keep');
  });
});
