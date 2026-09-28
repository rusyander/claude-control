import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestE2eFolder } from '@agentdeck/contracts';
import { automationCommand, readAutomation } from './automation.ts';
import { e2eCommand } from './e2e-command.ts';

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
});
