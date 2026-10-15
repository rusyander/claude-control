import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestE2eFolder } from '@agentdeck/contracts';
import {
  automationCommand,
  COMMAND_LINE_LIMIT,
  RUN_FILES_ENV,
  readAutomation,
  removeAutomation,
  writeAutomation,
} from './automation.ts';
import { e2eCommand } from '../e2e-command/e2e-command.ts';

/**
 * Своя команда проекта читается строго: сломанный файл — причина словами для
 * списка неполадок, а не молчаливое «команды нет» и не запуск мусора.
 */
describe('project-tests/automation: своя команда прогона проекта', () => {
  let root = '';
  const put = (body: string): void => {
    mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
    writeFileSync(join(root, '.agent', 'tests', 'automation.json'), body);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-automation-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('нет файла — пусто и без ошибки: это обычный проект', () => {
    expect(readAutomation(root)).toEqual({});
  });

  it('годная команда: пробелы срезаны, потолок минут ограничен, отчёт — через /', () => {
    put(
      JSON.stringify({
        version: 1,
        command: '  node run.mjs {files}  ',
        report: 'out\\junit.xml',
        timeoutMinutes: 9999,
      }),
    );
    expect(readAutomation(root)).toEqual({
      automation: { command: 'node run.mjs {files}', report: 'out/junit.xml', timeoutMinutes: 240 },
    });
  });

  it.each([
    ['[1]', 'не объект JSON'],
    ['{"version":1}', 'нет строки «command»'],
    ['{"command":"a\\nb"}', 'одна строка'],
    ['{"command":"x","report":"../out.xml"}', 'внутри него'],
    ['{"command":"x","report":"/abs/out.xml"}', 'внутри него'],
  ])('сломанный файл %s — причина словами', (body, reason) => {
    put(body);
    const read = readAutomation(root);
    expect(read.automation).toBeUndefined();
    expect(read.error).toContain(reason);
  });

  it('подстановки: файлы в кавычках при пробелах, отчёт панели и переменная — один путь', () => {
    const own = automationCommand(
      root,
      { command: 'node run.mjs {files} --out {report}' },
      ['a.mjs', 'with space.mjs'],
      join(root, 'rep.xml'),
    );
    expect(own.line).toBe(`node run.mjs a.mjs "with space.mjs" --out ${join(root, 'rep.xml')}`);
    expect(own.env).toEqual({ AGENTDECK_JUNIT_REPORT: join(root, 'rep.xml') });
    expect(own.cwd).toBe(root);
  });

  /**
   * F-14. `automation.file` пишет агент, человек или импорт, а строка идёт в
   * оболочку (`shell: true`). `$()`, обратная кавычка, `%VAR%` раскрываются и в
   * двойных кавычках — такой файл отказом, остальное — в кавычках целиком.
   */
  it('файл кейса с подстановкой оболочки — отказ; метасимволы вне подстановки — в кавычках', () => {
    const run = (file: string) =>
      automationCommand(root, { command: 'npx vitest run {files}' }, [file], 'x').line;
    expect(run('a;id>x.spec.ts')).toBe('npx vitest run "a;id>x.spec.ts"');
    expect(run('glob*.spec.ts')).toBe('npx vitest run "glob*.spec.ts"');
    expect(run('a,b.spec.ts')).toBe('npx vitest run "a,b.spec.ts"');
    expect(run('e2e\\x.spec.ts')).toBe('npx vitest run e2e/x.spec.ts');
    for (const file of ['x$(touch pwned).spec.ts', 'a`id`.ts', '50%PATH%.ts', 'q".ts']) {
      expect(() => run(file), file).toThrow(
        expect.objectContaining({ messageCode: 'e2e-run-file-unsafe' }),
      );
    }
    const folder = { state: 'found', dir: 'tests', framework: 'pytest' } as ProjectTestE2eFolder;
    expect(() => e2eCommand(root, folder, 'r.xml', ['tests/$(id).py'])).toThrow(
      expect.objectContaining({ messageCode: 'e2e-run-file-unsafe' }),
    );
    expect(e2eCommand(root, folder, 'r.xml', ['tests/a b.py'])?.line).toContain('"tests/a b.py"');
  });

  it('свой путь отчёта команды важнее каталога панели; без {files} — весь набор', () => {
    const own = automationCommand(root, { command: 'npm test', report: 'out/j.xml' }, ['a'], 'x');
    expect(own).toMatchObject({ line: 'npm test', report: join(root, 'out/j.xml') });
  });

  it('вид отчёта: родной вывод читается, чужой вид и каталог у родного — отказ', () => {
    put('{"command":"go test -json ./... > {report}","format":"go-test-json"}');
    expect(readAutomation(root).automation?.format).toBe('go-test-json');
    put('{"command":"x","format":"junit"}');
    expect(readAutomation(root).automation).toEqual({ command: 'x' });
    put('{"command":"x","format":"tap"}');
    expect(readAutomation(root).error).toContain('«tap»');
    put('{"command":"x","format":"cargo-test","report":"out/"}');
    expect(readAutomation(root).error).toContain('Каталог отчётов');
  });

  it('каталог отчётов: хвостовой / сохранён для сбора, в {report} и переменную — без него', () => {
    put('{"command":"mvn test","report":"api\\\\target\\\\surefire-reports\\\\"}');
    const automation = readAutomation(root).automation!;
    expect(automation.report).toBe('api/target/surefire-reports/');
    const own = automationCommand(root, { ...automation, command: 'x {report}' }, [], 'p');
    expect(own.report).toMatch(/surefire-reports[\\/]$/);
    expect(own.line).toBe(`x ${join(root, 'api/target/surefire-reports')}`);
    expect(own.env.AGENTDECK_JUNIT_REPORT).toBe(join(root, 'api/target/surefire-reports'));
  });

  it('{packages}: каталоги файлов без повторов, подстановка оболочки — отказ', () => {
    const line = (files: string[]) =>
      automationCommand(root, { command: 'go test {packages}' }, files, 'x').line;
    expect(line(['a/b/x_test.go', 'a/b/y_test.go', 'main_test.go'])).toBe('go test ./a/b .');
    expect(line([])).toBe('go test ./...');
    expect(() => line(['x$(id)/a_test.go'])).toThrow(
      expect.objectContaining({ messageCode: 'e2e-run-file-unsafe' }),
    );
  });

  it('полный прогон: {files} несёт файлы кейсов, {paths} пуст, {packages} — ./...', () => {
    const command = { command: 'run {files} | pytest {paths} | go test {packages}' };
    const files = ['orders/a_test.go', 'tests/test_b.py'];
    expect(automationCommand(root, command, files, 'x', true).line).toBe(
      'run orders/a_test.go tests/test_b.py | pytest  | go test ./...',
    );
    expect(automationCommand(root, command, files, 'x').line).toBe(
      'run orders/a_test.go tests/test_b.py | pytest orders/a_test.go tests/test_b.py | go test ./orders ./tests',
    );
  });

  /**
   * 16.10: группа из 300 наборов собирала строку в 11 тыс. знаков, cmd.exe
   * отвечал «Слишком длинная командная строка», и прогон падал за 0 с без отчёта.
   */
  it('список длиннее строки cmd.exe — файлом в AGENTDECK_TEST_FILES, строка — как весь набор', () => {
    const command = { command: 'node junit-run.mjs {files} | pytest {paths} | go test {packages}' };
    const files = Array.from({ length: 300 }, (_, index) => `apps/web/src/features/F${index}/`);
    const report = join(root, 'run', 'junit.xml');
    const own = automationCommand(root, command, files, report);
    expect(own.line).toBe('node junit-run.mjs  | pytest  | go test ./...');
    expect(own.line.length).toBeLessThan(COMMAND_LINE_LIMIT);
    expect(own.listed).toBe(300);
    const list = own.env[RUN_FILES_ENV]!;
    expect(list).toBe(`${report}.files.txt`);
    expect(readFileSync(list, 'utf8').trim().split('\n')).toEqual(files);
    expect(own.env.AGENTDECK_JUNIT_REPORT).toBe(report);

    const short = automationCommand(root, command, files.slice(0, 2), join(root, 'short.xml'));
    expect(short.line).toContain('apps/web/src/features/F1/');
    expect(short.env[RUN_FILES_ENV]).toBeUndefined();
    expect(short.listed).toBeUndefined();
    expect(existsSync(join(root, 'short.xml.files.txt'))).toBe(false);
  });

  it('запись — те же правила, что чтение; снятие откладывает файл, а не стирает', () => {
    expect(() => writeAutomation(root, { command: 'a\nb' })).toThrow(
      expect.objectContaining({ messageCode: 'automation-command-multiline', statusCode: 400 }),
    );
    writeAutomation(root, { command: ' go test ./... ', format: 'junit', timeoutMinutes: 30 });
    expect(readAutomation(root).automation).toEqual({
      command: 'go test ./...',
      timeoutMinutes: 30,
    });
    removeAutomation(root);
    expect(readAutomation(root)).toEqual({});
    expect(existsSync(join(root, '.agent', 'tests', 'automation.removed.json'))).toBe(true);
    // Снять то, чего нет, — не ошибка.
    expect(() => removeAutomation(root)).not.toThrow();
  });
});
