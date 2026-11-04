import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestCase, ProjectTestRunMode } from '@agentdeck/contracts';
import { describeScope, isWritable, runScope, scopeClause } from './run-permissions.ts';
import { e2eFolderView } from '../e2e-folder/e2e-folder.ts';

/**
 * Границы прогона по режиму. Их держит не судья ядра (тот знает только корень проекта), а
 * задание словами и сверка дерева на финише (`scope-audit.ts`) — обе берут их отсюда. Важно и
 * обратное: границы, запретившие писать статусы, отменили бы сам прогон.
 */
function testCase(id: string, file?: string): ProjectTestCase {
  return {
    id,
    type: 'case',
    title: `Кейс ${id}`,
    steps: [],
    status: 'unknown',
    source: 'agent',
    automation: file ? { status: 'automated', file } : undefined,
  };
}

describe('project-tests run-permissions', () => {
  let root = '';
  const scopeOf = (mode: ProjectTestRunMode, cases: ProjectTestCase[] = []) =>
    runScope(root, mode, cases);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-perm-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe('генерация и прогон пишут только в свой каталог', () => {
    for (const mode of ['run', 'explore'] as const) {
      it(`${mode}: кейсы записать можно, чужой код — нет`, () => {
        const scope = scopeOf(mode);
        // То, ради чего прогон и запускают: свои файлы он пишет.
        expect(isWritable(scope, join(root, '.agent', 'tests', 'gui.tests.json'))).toBe(true);
        expect(isWritable(scope, '.agent/tests/runs/2026-09-07.json')).toBe(true);
        // И то, ради чего заведены границы: чужой рабочий код он не трогает.
        expect(isWritable(scope, join(root, 'apps', 'web', 'src', 'App.tsx'))).toBe(false);
        expect(describeScope(scope)).toBe('writing is allowed only inside .agent/tests/');
      });
    }

    /**
     * Генерация НЕ пишет в библиотеку: галочка «принимать сразу» решает лишь, кто нажимает
     * «применить», и никогда — кто пишет в файлы групп.
     */
    it('генерация пишет только черновик — файлы групп ей запрещены', () => {
      const scope = scopeOf('generate');
      expect(isWritable(scope, join(root, '.agent', 'tests', 'drafts', 'run-1.draft.json'))).toBe(
        true,
      );
      expect(isWritable(scope, join(root, '.agent', 'tests', 'gui.tests.json'))).toBe(false);
      expect(isWritable(scope, '.agent/tests/_shared.steps.json')).toBe(false);
      expect(isWritable(scope, '.agent/tests/environments.json')).toBe(false);
      expect(describeScope(scope)).toContain('draft');
    });

    it('за корень проекта не выпускает даже абсолютным путём', () => {
      const scope = scopeOf('run');
      const outside = resolve(root, '..', 'чужой-проект', 'src', 'index.ts');
      expect(isWritable(scope, outside)).toBe(false);
      // Путь вверх из тестового каталога — тот же выход наружу, только скрытый.
      expect(isWritable(scope, '.agent/tests/../../src/main.ts')).toBe(false);
    });

    it('режим `automate` пишет НАЗВАННЫЕ кейсами автотесты и соседей по папке', () => {
      const cases = [testCase('gui-001', 'tests/e2e/chat.spec.ts'), testCase('gui-002')];
      const scope = scopeOf('automate', cases);
      expect(scope.testFiles).toEqual(['tests/e2e/chat.spec.ts']);
      expect(isWritable(scope, 'tests/e2e/chat.spec.ts')).toBe(true);
      // Фикстура рядом с тестом — часть того же теста.
      expect(isWritable(scope, 'tests/e2e/fixtures/user.json')).toBe(true);
      expect(isWritable(scope, 'apps/web/src/App.tsx')).toBe(false);
      expect(describeScope(scope)).toContain('tests/e2e/chat.spec.ts');
    });

    // Живая проверка 08.10: кейсы ещё без `automation.file`, папка e2e заведена
    // панелью и пуста — первый спек писать было некуда, автоматизация отложила всё.
    it('режим `automate` пишет первый спек в папку e2e проекта', () => {
      const scope = runScope(root, 'automate', [testCase('calc-002')], 'e2e');
      expect(isWritable(scope, 'e2e/calc.spec.ts')).toBe(true);
      expect(isWritable(scope, 'apps/web/src/App.tsx')).toBe(false);
      expect(describeScope(scope)).toContain('e2e/');
      // Корень проекта папкой e2e не становится.
      expect(isWritable(runScope(root, 'automate', [], '.'), 'src/main.ts')).toBe(false);
    });

    it('automate без папки e2e и без названных файлов честно говорит, что кода тестов не будет', () => {
      expect(describeScope(scopeOf('automate'))).toContain('no test code can be written');
    });

    it('в остальных режимах имя автотеста прав не даёт', () => {
      const cases = [testCase('gui-001', 'tests/e2e/chat.spec.ts')];
      expect(isWritable(scopeOf('run', cases), 'tests/e2e/chat.spec.ts')).toBe(false);
      expect(scopeOf('generate', cases).testFiles).toEqual([]);
    });
  });

  it('строка границ для задания называет границы, запрет коммита и сверку на финише', () => {
    const clause = scopeClause(scopeOf('generate'));
    expect(clause).toContain('writing is allowed only inside .agent/tests/drafts/');
    expect(clause).toContain('Never commit, reset or switch branches');
    expect(clause).toContain('compares the working tree after the run');
  });
});

// `testDir` из конфига Playwright брался дословно: чужой репозиторий с `testDir: '.'`
// во вложенном приложении открывал агенту тестов запись в код приложения, а
// `testDir: '..'` — запись за пределами проекта.
describe('папка e2e из конфига не расширяет запись агента', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'cc-e2e-scope-'));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const scopeFor = (root: string) => runScope(root, 'generate', [], e2eFolderView(root).dir);

  it('testDir «.» во вложенном приложении — код приложения не пишется', () => {
    const root = join(base, 'proj');
    mkdirSync(join(root, 'apps', 'web', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'apps', 'web', 'playwright.config.ts'),
      "export default { testDir: '.' }\n",
    );
    expect(isWritable(scopeFor(root), 'apps/web/src/App.tsx')).toBe(false);
  });

  it('testDir «..» — за пределы проекта не пишется', () => {
    const root = join(base, 'proj');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'playwright.config.ts'), "export default { testDir: '..' }\n");
    expect(isWritable(scopeFor(root), join(base, 'other', 'secret.txt'))).toBe(false);
  });

  it('обычная папка тестов из конфига по-прежнему пишется', () => {
    const root = join(base, 'proj');
    mkdirSync(join(root, 'apps', 'web', 'e2e'), { recursive: true });
    writeFileSync(
      join(root, 'apps', 'web', 'playwright.config.ts'),
      "export default { testDir: './e2e' }\n",
    );
    expect(isWritable(scopeFor(root), 'apps/web/e2e/login.spec.ts')).toBe(true);
  });
});
