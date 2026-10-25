import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, parseCase, writeGroup } from './store/store.ts';
import { readRuns } from './runs-store/runs-store.ts';

/**
 * Повисший файл vitest у `tests-cli run` (группа 23–24.10.2026, inst-docs-ui): тест держал
 * поток синхронным `cpSync`, предел теста vitest такой код не прерывает — прогон шёл 42 мин
 * или снимался по пределу 10 мин, ничего не назвав, а цепочка пакетов гасила код провала, и
 * 19 упавших тестов выглядели «кодом 0». Настоящий `node tools/tests-cli.mjs` и настоящий
 * vitest сервера над временным проектом; синхронная блокировка — `Atomics.wait`.
 */
const CLI = resolve(__dirname, '../../../../../tools/tests-cli.mjs');
const MODULES = resolve(__dirname, '../../../node_modules');
const VITEST = join(MODULES, 'vitest', 'vitest.mjs');

const SLEEP = `const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);\n`;

/** Пять тестов по 3 с синхронно при пределе 1 с; каждый дописывает свой номер в done.txt. */
const HANG = (project: string) =>
  `import { appendFileSync } from 'node:fs';\nimport { it } from 'vitest';\n${SLEEP}` +
  `for (const n of [1, 2, 3, 4, 5]) it('держит поток ' + n, () => { sleep(3000); appendFileSync(${JSON.stringify(
    join(project, 'done.txt'),
  )}, n + '\\n'); });\n`;

function cli(project: string, args: string[]) {
  const clean = { ...process.env };
  delete clean.AGENTDECK_TESTS_CASE_TIMEOUT;
  delete clean.AGENTDECK_BRIEF_OUTPUT;
  delete clean.AGENTDECK_TESTS_PROJECT;
  const started = Date.now();
  const result = spawnSync(process.execPath, [CLI, ...args, '--project', project], {
    encoding: 'utf8',
    timeout: 120_000,
    env: clean,
  });
  return {
    code: result.status,
    out: `${result.stdout}${result.stderr}`,
    seconds: (Date.now() - started) / 1000,
  };
}

describe('tests-cli run: повисший и синхронно занятый файл vitest', () => {
  let project = '';
  const packages: string[] = [];

  const pkg = (name: string, config: string, files: Record<string, string>): void => {
    mkdirSync(join(project, name), { recursive: true });
    writeFileSync(join(project, name, 'package.json'), `{"name":"${name}","type":"module"}`);
    writeFileSync(join(project, name, 'vitest.config.mjs'), `export default ${config};\n`);
    for (const [file, body] of Object.entries(files))
      writeFileSync(join(project, name, file), body);
    symlinkSync(MODULES, join(project, name, 'node_modules'), 'junction');
    packages.push(name);
  };
  const group = (id: string, cases: { id: string; file: string }[]): void =>
    writeGroup(project, {
      ...createGroup(project, id, id),
      cases: cases
        .map((c) => ({
          id: c.id,
          title: c.id,
          automation: {
            status: 'automated',
            file: c.file,
            ...(c.file.endsWith('/') ? { suite: '.' } : {}),
          },
        }))
        .flatMap((raw, index) => parseCase(raw, index) ?? []),
    });
  const done = (): number =>
    existsSync(join(project, 'done.txt'))
      ? readFileSync(join(project, 'done.txt'), 'utf8').trim().split('\n').length
      : 0;

  beforeEach(() => {
    project = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-tests-cli-sync-')));
    packages.length = 0;
  });

  afterEach(() => {
    // unlink: на Windows ссылка — junction, rmSync без recursive её не берёт.
    for (const name of packages)
      try {
        unlinkSync(join(project, name, 'node_modules'));
      } catch {
        // ссылки нет — тест упал раньше
      }
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('цепочка пакетов: провал из отчёта — строки падений и счёт «упало / прошло»', () => {
    pkg('ok', '{}', {
      'ok.test.mjs': `import { it, expect } from 'vitest';\nit('сходится', () => expect(1).toBe(1));\n`,
    });
    pkg('red', '{}', {
      'red.test.mjs': `import { it, expect } from 'vitest';\nit('не сходится', () => expect(1).toBe(2));\n`,
    });
    group('suites', [
      { id: 'suites-ok', file: 'ok/' },
      { id: 'suites-red', file: 'red/' },
    ]);
    const result = cli(project, ['run', '--group', 'suites', '--brief']);
    expect(result.out).toMatch(/\|\| echo -\) && \(/);
    expect(result.out).toContain('Первые строки падений:');
    expect(result.out).toContain('не сходится');
    expect(result.out).toContain('упало 1 / прошло 1');
    expect(result.code).toBe(1);
  }, 120_000);

  it('снятый по пределу прогон называет незаконченный файл и сколько он молчит', () => {
    pkg('slow', '{ test: { testTimeout: 120000 } }', {
      'fast.test.mjs': `import { it } from 'vitest';\nit('быстрый', () => {});\n`,
      'stuck.test.mjs': `import { it } from 'vitest';\n${SLEEP}it('спит', () => { sleep(60000); });\n`,
    });
    group('slow', [{ id: 'slow-001', file: 'slow/' }]);
    // 0,15 мин = 9 с на кейс.
    const result = cli(project, ['run', '--group', 'slow', '--brief', '--case-timeout', '0.15']);
    expect(result.code).toBe(124);
    expect(result.out).toMatch(
      /Не закончили к остановке: slow\/stuck\.test\.mjs — начат \d+ с назад/,
    );
    expect(result.out).not.toMatch(/Не закончили[^\n]*fast\.test\.mjs/);
    expect(result.out).toContain('не оборачивай vitest в `timeout N`');
  }, 120_000);

  it('синхронная блокировка: прогон снят на первом её признаке, кейс — проваленным с причиной', () => {
    pkg('hang', '{ test: { testTimeout: 1000 } }', { 'hang.test.mjs': HANG(project) });
    group('hang', [{ id: 'hang-001', file: 'hang/' }]);
    const result = cli(project, ['run', '--group', 'hang', '--brief']);
    expect(result.code).toBe(124);
    expect(result.out).toMatch(
      /Синхронная блокировка: hang\/hang\.test\.mjs > держит поток \d шёл 3 с при пределе 1 с/,
    );
    expect(result.out).toContain('vitest не прерывает синхронный код');
    // Без остановки прошли бы все пять (15 с): снят раньше.
    expect(done()).toBeLessThan(5);
    const [record] = readRuns(project);
    expect(record?.exitCode).toBe(124);
    expect(record?.scope).toContain('синхронная блокировка');
    expect(record?.results.find((point) => point.caseId === 'hang-001')).toMatchObject({
      status: 'failed',
    });
    expect(record?.results.find((point) => point.caseId === 'hang-001')?.note).toContain(
      'синхронная блокировка',
    );
  }, 120_000);

  it('своя команда vitest (без меток хода): подсказка о синхронной блокировке из вывода', () => {
    pkg('own', '{ test: { testTimeout: 1000 } }', {
      'own.test.mjs': `import { it } from 'vitest';\n${SLEEP}it('держит поток', () => { sleep(2500); });\n`,
    });
    writeFileSync(
      join(project, 'own', 'run.mjs'),
      `import { spawnSync } from 'node:child_process';\n` +
        `const r = spawnSync(process.execPath, [${JSON.stringify(VITEST)}, 'run', '--reporter=default', '--reporter=junit', '--outputFile.junit=junit.xml'], { stdio: 'inherit', cwd: process.cwd() });\n` +
        `process.exit(r.status ?? 1);\n`,
    );
    group('own', [{ id: 'own-001', file: 'own/own.test.mjs' }]);
    const result = cli(project, [
      'run',
      '--group',
      'own',
      '--brief',
      '--cmd',
      'cd own && node run.mjs',
      '--results',
      'own/junit.xml',
    ]);
    expect(result.out).toMatch(
      /Синхронная блокировка: [^\n]*держит поток шёл \d с при пределе 1 с/,
    );
    expect(result.out).toContain('vitest не прерывает синхронный код');
  }, 120_000);
});
