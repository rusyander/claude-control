import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, upsertCase } from './store/store.ts';
import { readBaseRuns, readRuns } from './runs-store/runs-store.ts';

/**
 * `tests-cli run --base` (#g0:109, 25.10): g0 стояла на кейсах, красных от Windows,
 * потому что прогона до старта группы у них не было и доказать «не из-за ветки» было
 * нечем. Прогон на развилке с основной — этот довод: настоящий CLI, настоящий git
 * (worktree на развилке), настоящая команда кейса; подменены только remote (ссылка
 * `origin/main` без сети) и даты.
 */
const CLI = resolve(__dirname, '../../../../../tools/tests-cli.mjs');
const STARTED = '2026-10-25T10:00:00.000Z';
/** Кейс читает файл и пишет JUnit с меткой `[pkg-001]`; есть ли файл ветки — в вывод. */
const CHECK = `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const value = readFileSync('src/value.txt', 'utf8').trim();
console.log('other: ' + (existsSync('src/other.txt') ? 'yes' : 'no'));
console.log('go.sum: ' + (existsSync('mod/go.sum') ? readFileSync('mod/go.sum', 'utf8').trim() : 'none'));
console.log('node_modules: ' + (existsSync('mod/node_modules') ? 'yes' : 'no'));
const ok = value === 'ok';
const failure = ok ? '' : '<failure message="value: ' + value + '">value: ' + value + '</failure>';
writeFileSync(process.argv[2], '<?xml version="1.0"?><testsuites><testsuite name="s" tests="1" failures="' + (ok ? 0 : 1) + '"><testcase name="[pkg-001] value" classname="check.mjs">' + failure + '</testcase></testsuite></testsuites>');
process.exit(ok ? 0 : 1);
`;
const RUN = ['--case', 'pkg:pkg-001', '--cmd', 'node check.mjs {report}', '--full'];

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

describe('tests-cli run --base: прогон на развилке с основной', { timeout: 180_000 }, () => {
  let dir = '';
  const cli = (...args: string[]) => {
    const result = spawnSync(process.execPath, [CLI, ...args, '--project', dir], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, AGENTDECK_BRIEF_OUTPUT: '' },
    });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  };
  const gaps = () => cli('gaps', '--since', STARTED);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-tests-cli-base-'));
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '.agent/\n');
    commit(dir, { 'src/value.txt': 'broken on windows\n', 'check.mjs': CHECK }, 'main');
    git(dir, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'checkout', '-q', '-b', 'feat');
    commit(dir, { 'src/other.txt': 'branch work\n' }, 'feat');
    createGroup(dir, 'pkg', 'Pkg');
    upsertCase(
      dir,
      'pkg',
      {
        title: 'Значение в src/value.txt — ok',
        steps: ['node check.mjs'],
        expected: 'check.mjs › [pkg-001] value проходит',
        // Весь `src`: дифф ветки задевает кейс — снимает только красное с той же подписью.
        codePaths: ['src'],
        automation: { status: 'automated', file: 'check.mjs' },
      },
      '2026-10-25T09:00:00.000Z',
    );
    // Прогон ветки после старта группы: красный, а до старта кейс не гоняли.
    expect(cli('run', ...RUN, '--fresh').out).toContain('other: yes');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('без прогона на развилке доставка держит и называет команду --base на этот кейс', () => {
    const before = gaps();
    expect(before.code).toBe(1);
    expect(before.out).toContain('--case pkg:pkg-001 --base');
  });

  it('прогон на развилке гонит код основной, пишет довод в runs-base, историю копии не трогает, дерево убирает', () => {
    const base = cli('run', '--base', ...RUN);
    expect(base.code).toBe(0);
    // Дерево развилки: файла ветки там нет.
    expect(base.out).toContain('other: no');
    expect(base.out).toContain('Прогон на развилке записан');
    const fork = git(dir, 'merge-base', 'origin/main', 'HEAD');
    const [record, ...rest] = readBaseRuns(dir);
    expect(rest).toEqual([]);
    expect(record?.commit).toBe(fork);
    expect(record?.branch).toBe('origin/main');
    expect(record?.results.map((item) => [item.caseId, item.status])).toEqual([
      ['pkg-001', 'failed'],
    ]);
    expect(readRuns(dir)).toHaveLength(1);
    expect(git(dir, 'worktree', 'list').split('\n')).toHaveLength(1);
    const after = gaps();
    expect(after.code).toBe(0);
    expect(after.out).toContain('на развилке с основной: pkg-001');
  });

  it('go.sum вне git (монорепозиторий на Go) — в дерево развилки из копии; node_modules — нет; вердикт по подписи в выводе', () => {
    // g0 25.10, 20:13: `go.sum` в .gitignore, дерево развилки без него не собиралось вовсе.
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '.agent/\ngo.sum\nnode_modules/\n');
    commit(dir, { 'mod/go.mod': 'module example.com/mod\n' }, 'go module');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(join(dir, 'mod', 'go.sum'), 'hashes-of-copy\n');
    mkdirSync(join(dir, 'mod', 'node_modules'));
    // Модуль, заведённый веткой: на развилке его каталога нет — и прогон не падает.
    commit(dir, { 'newmod/go.mod': 'module example.com/newmod\n' }, 'branch module');
    writeFileSync(join(dir, 'newmod', 'go.sum'), 'branch-only\n');
    const base = cli('run', '--base', ...RUN);
    expect(base.code).toBe(0);
    expect(base.out).toContain('go.sum: hashes-of-copy');
    expect(base.out).toContain('node_modules: no');
    expect(base.out).toContain('файлы окружения Go, которых нет в git: mod/go.sum\n');
    expect(base.out).toContain(
      'pkg:pkg-001 — та же подпись, что у ветки: ворота снимут его с ветки',
    );
  });

  it('{copy} в --cmd — корень исходной копии: её файл вне git находится и на развилке; без него — подсказка', () => {
    // g0 26.10: venv копии в `.agent/tmp` относительным путём на развилке не нашёлся.
    mkdirSync(join(dir, '.agent', 'tmp'), { recursive: true });
    writeFileSync(join(dir, '.agent', 'tmp', 'own-check.mjs'), CHECK);
    const relative = ['--case', 'pkg:pkg-001', '--full', '--cmd'];
    const lost = cli('run', '--base', ...relative, 'node .agent/tmp/missing.mjs {report}');
    expect(lost.out).toContain('Прогон на развилке не записан');
    expect(lost.out).toContain(`через {copy} (здесь ${dir})`);
    const found = cli(
      'run',
      '--base',
      ...relative,
      'node "{copy}/.agent/tmp/own-check.mjs" {report}',
    );
    expect(found.code, found.out).toBe(0);
    expect(found.out).toContain('other: no');
    expect(found.out).toContain('Прогон на развилке записан');
    expect(found.out).not.toContain('Пути копии вне git');
  });

  it('путь копии вне git в --cmd без {copy} — из копии; файл ветки под git остаётся путём развилки', () => {
    // g0 27.10 01:42: `PYTHONPATH=.agent/tmp/pyshim` — прогон впустую до подсказки про {copy}.
    mkdirSync(join(dir, '.agent', 'tmp'), { recursive: true });
    writeFileSync(join(dir, '.agent', 'tmp', 'own-check.mjs'), CHECK);
    const run = cli(
      'run',
      '--base',
      '--case',
      'pkg:pkg-001',
      '--full',
      '--cmd',
      'node .agent/tmp/own-check.mjs {report} src/other.txt',
    );
    expect(run.code, run.out).toBe(0);
    expect(run.out).toContain(
      'Пути копии вне git — из копии, на развилке их нет: .agent/tmp/own-check.mjs\n',
    );
    expect(run.out).toContain('other: no');
    expect(run.out).toContain('Прогон на развилке записан');
  });

  /** Пакет на основной (развилке): package.json + lock; ветка поверх перебазирована. */
  const packageOnMain = (files: Record<string, string>) => {
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '.agent/\nnode_modules/\n');
    git(dir, 'checkout', '-q', 'main');
    commit(dir, files, 'package');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'checkout', '-q', 'feat');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'rebase', '-q', 'main');
  };
  const NM_CHECK = `import { existsSync, writeFileSync } from 'node:fs';
console.log('dep: ' + (existsSync('node_modules/dep/marker.txt') ? 'yes' : 'no'));
writeFileSync(process.argv[2], '<?xml version="1.0"?><testsuites><testsuite name="s" tests="1"><testcase name="[pkg-001] value" classname="check.mjs"/></testsuite></testsuites>');
`;
  const runWithDeps = () => {
    mkdirSync(join(dir, '.agent', 'tmp'), { recursive: true });
    writeFileSync(join(dir, '.agent', 'tmp', 'nm-check.mjs'), NM_CHECK);
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'dep', 'marker.txt'), 'copy deps\n');
    return cli(
      'run',
      '--base',
      '--case',
      'pkg:pkg-001',
      '--full',
      '--cmd',
      'node .agent/tmp/nm-check.mjs {report}',
    );
  };

  it('node_modules копии — в дерево развилки ссылкой при том же package.json и lock-файле; после прогона ссылка снята, зависимости копии целы', () => {
    // g5 27.10: e2e --base падал «Playwright не установлен», npm install в копии — «up to date».
    packageOnMain({
      'package.json': '{"name":"p","private":true}\n',
      'package-lock.json': '{"lockfileVersion":3}\n',
    });
    const run = runWithDeps();
    expect(run.code, run.out).toBe(0);
    expect(run.out).toContain('node_modules копии: связаны .');
    expect(run.out).toContain('dep: yes');
    expect(run.out).toContain('Прогон на развилке записан');
    expect(existsSync(join(dir, 'node_modules', 'dep', 'marker.txt'))).toBe(true);
    expect(git(dir, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('package.json ветки не тот, что на развилке — node_modules не связан, причина названа', () => {
    packageOnMain({
      'package.json': '{"name":"p","private":true}\n',
      'package-lock.json': '{"lockfileVersion":3}\n',
    });
    commit(
      dir,
      { 'package.json': '{"name":"p","private":true,"dependencies":{"dep":"2"}}\n' },
      'dep 2',
    );
    const run = runWithDeps();
    expect(run.out).toContain('dep: no');
    expect(run.out).toContain('не взяты: . — package.json не тот, что на развилке');
    expect(existsSync(join(dir, 'node_modules', 'dep', 'marker.txt'))).toBe(true);
  });

  it('раннер не найден на развилке — ошибка называет дерево развилки, а не копию, и что npm install в копии не поможет', () => {
    // Пакет Playwright (как QA/auto/frontend в монорепозитории): раннер ищется только в его node_modules.
    packageOnMain({
      'web/package.json': '{"name":"web","private":true,"devDependencies":{"playwright":"1"}}\n',
      'web/playwright.config.mjs': "export default { testDir: '.' };\n",
      'web/a.spec.mjs': "import { test } from 'playwright/test';\ntest('a', () => {});\n",
    });
    // Ветка сменила зависимости пакета — node_modules копии к развилке не подходят.
    commit(
      dir,
      {
        'web/package.json': '{"name":"web","private":true,"devDependencies":{"playwright":"2"}}\n',
      },
      'playwright 2',
    );
    mkdirSync(join(dir, 'web', 'node_modules', 'playwright'), { recursive: true });
    upsertCase(
      dir,
      'pkg',
      {
        title: 'Спек web',
        steps: ['playwright test a.spec.mjs'],
        expected: 'a проходит',
        codePaths: ['web'],
        automation: { status: 'automated', file: 'web/a.spec.mjs' },
      },
      '2026-10-25T09:00:00.000Z',
    );
    const run = cli('run', '--base', '--case', 'pkg:pkg-002', '--full');
    expect(run.out).toMatch(
      /Playwright не найден в дереве развилки \S*cc-tests-base-\S*[\\/]tree[\\/]web/,
    );
    expect(run.out).toContain('npm install в копии не поможет');
    expect(run.out).toContain('не взяты: web — package.json не тот, что на развилке');
  });

  it('красный другой подписью на развилке — вывод говорит «не довод», а не «записан» молча', () => {
    // Ветка чинит value — но красное остаётся другим (ветка пишет своё значение).
    commit(dir, { 'src/value.txt': 'broken by branch\n' }, 'branch value');
    expect(cli('run', ...RUN, '--fresh').code).toBe(1);
    const base = cli('run', '--base', ...RUN);
    expect(base.out).toContain(
      'pkg:pkg-001 — подпись не та, что у ветки: это не довод, ворота его не снимут',
    );
    expect(gaps().code).toBe(1);
  });

  it('развилка сдвинулась (rebase на новую основную) — старый довод не считается', () => {
    expect(cli('run', '--base', ...RUN).code).toBe(0);
    git(dir, 'checkout', '-q', 'main');
    commit(dir, { 'README.md': 'next\n' }, 'main 2');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'checkout', '-q', 'feat');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'rebase', '-q', 'main');
    const stale = gaps();
    expect(stale.code).toBe(1);
    expect(stale.out).toContain('--case pkg:pkg-001 --base');
  });
});
