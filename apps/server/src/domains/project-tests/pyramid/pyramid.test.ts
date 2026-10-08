import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPyramid } from './pyramid.ts';
import { createE2eFolder } from '../e2e-folder/e2e-folder.ts';

/**
 * Пирамида тестов. Главное свойство — панель не гадает: слой без каркаса,
 * названного проектом, — «не известно» (`undefined`), а не ноль; деление на
 * модульные и интеграционные — только по меткам самого проекта.
 */
describe('project-tests/pyramid', () => {
  let root = '';
  let appData = '';
  const now = '2026-09-27T10:00:00.000Z';

  const put = (file: string, text: string): void => {
    const path = join(root, ...file.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };

  const TWO_TESTS = `import { it, expect } from 'vitest';
describe('сумма', () => {
  it('складывает', () => expect(1 + 1).toBe(2));
  test('вычитает', () => expect(2 - 1).toBe(1));
  for (const n of [1, 2]) it(\`умножает \${n}\`, () => {});
});
`;

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-pyramid-')));
    appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-pyramid-data-')));
  });

  afterEach(() => {
    for (const target of [root, appData]) {
      rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('файлы *.test.ts без каркаса в проекте — не известно, а не ноль', () => {
    put('package.json', JSON.stringify({ name: 'app', dependencies: { react: '1' } }));
    put('src/a.test.ts', TWO_TESTS);
    put('pyproject.toml', '[tool.black]\nline-length = 100\n');
    put('tests/test_x.py', 'def test_one():\n    pass\n');

    const pyramid = buildPyramid(root, { appData, now });
    expect(pyramid.frameworks).toEqual([]);
    expect(pyramid.code).toBeUndefined();
    expect(pyramid.unit).toBeUndefined();
    expect(pyramid.split).toBe(false);
    expect(pyramid.e2e).toBeUndefined();
    expect(pyramid.checkedAt).toBe(now);
  });

  it('vitest из package.json: счёт кода без деления; e2e, зависимости и спеки Playwright — не в нём', () => {
    put('package.json', JSON.stringify({ devDependencies: { vitest: '4' } }));
    put('src/a.test.ts', TWO_TESTS);
    put('src/__tests__/b.ts', "it('один', () => {});\n");
    // F-158: помощник в __tests__ без единого теста — не тестовый файл.
    put('src/__tests__/helpers.ts', 'export const fixture = 1;\n');
    put('src/plain.ts', "it('не тест: файл не тестовый', () => {});\n");
    put('node_modules/lib/c.test.ts', "it('чужой', () => {});\n");
    put('dist/d.test.js', "it('собранный', () => {});\n");
    put(
      'src/visual.spec.ts',
      "import { test } from '@playwright/test';\ntest('экран', async () => {});\n",
    );
    createE2eFolder(appData, root, now);
    put(
      'e2e/login.spec.ts',
      "import { test } from '@playwright/test';\ntest('вход', async () => {});\ntest('выход', async () => {});\n",
    );

    const pyramid = buildPyramid(root, { appData, now });
    expect(pyramid.frameworks).toEqual([{ name: 'vitest', source: 'package.json' }]);
    expect(pyramid.split).toBe(false);
    expect(pyramid.code).toEqual({ files: 2, tests: 3, dynamic: 1 });
    expect(pyramid.e2e).toMatchObject({ dir: 'e2e', files: 1, tests: 2 });
    expect(pyramid.truncated).toBe(false);
  });

  it('метки проекта делят модульные и интеграционные: имя, каталог', () => {
    put('vitest.config.ts', 'export default {};\n');
    put('src/a.test.ts', TWO_TESTS);
    put('src/db.integration.test.ts', "it('пишет в базу', () => {});\n");
    put('tests/integration/api.test.ts', "it('отвечает', () => {});\nit('падает', () => {});\n");

    const pyramid = buildPyramid(root, { appData, now });
    expect(pyramid.frameworks).toEqual([{ name: 'vitest', source: 'vitest.config.ts' }]);
    expect(pyramid.split).toBe(true);
    expect(pyramid.unit).toEqual({ files: 1, tests: 2, dynamic: 1 });
    expect(pyramid.integration).toEqual({ files: 2, tests: 3, dynamic: 0 });
    expect(pyramid.code).toBeUndefined();
  });

  it('pytest из pyproject и метка @pytest.mark.integration', () => {
    put('pyproject.toml', '[project]\nname = "app"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n');
    put(
      'tests/test_math.py',
      'def test_add():\n    pass\n\ndef test_sub():\n    pass\n\ndef helper():\n    pass\n',
    );
    put(
      'tests/test_db.py',
      'import pytest\n\n@pytest.mark.integration\ndef test_write():\n    pass\n',
    );
    put('src/module.py', 'def test_like_name():\n    pass\n');

    const pyramid = buildPyramid(root, { appData, now });
    expect(pyramid.frameworks).toEqual([{ name: 'pytest', source: 'pyproject.toml' }]);
    expect(pyramid.unit).toEqual({ files: 1, tests: 2, dynamic: 0 });
    expect(pyramid.integration).toEqual({ files: 1, tests: 1, dynamic: 0 });
  });

  it('go.mod: функции Test*(t *testing.T), тег сборки integration', () => {
    put('go.mod', 'module example.com/app\n\ngo 1.22\n');
    put(
      'pkg/sum_test.go',
      'package pkg\n\nimport "testing"\n\nfunc TestSum(t *testing.T) {}\nfunc TestSub(t *testing.T) {}\nfunc TestMain(m *testing.M) {}\nfunc helper() {}\n',
    );
    put(
      'pkg/db_test.go',
      '//go:build integration\n\npackage pkg\n\nimport "testing"\n\nfunc TestDB(t *testing.T) {}\n',
    );

    const pyramid = buildPyramid(root, { appData, now });
    expect(pyramid.frameworks).toEqual([{ name: 'go', source: 'go.mod' }]);
    expect(pyramid.unit).toEqual({ files: 1, tests: 2, dynamic: 0 });
    expect(pyramid.integration).toEqual({ files: 1, tests: 1, dynamic: 0 });
  });

  it('обход глубже потолка — счёт помечен нижней границей', () => {
    put('package.json', JSON.stringify({ jest: { testEnvironment: 'node' } }));
    put(
      `${Array.from({ length: 14 }, (_, i) => `d${i}`).join('/')}/deep.test.js`,
      "it('x', () => {});\n",
    );

    const pyramid = buildPyramid(root, { appData, now });
    expect(pyramid.frameworks).toEqual([{ name: 'jest', source: 'package.json' }]);
    expect(pyramid.truncated).toBe(true);
    expect(pyramid.code?.files).toBe(0);
  });

  it('одна глубокая ветка не обнуляет счёт соседних каталогов', () => {
    put('package.json', JSON.stringify({ devDependencies: { vitest: '4' } }));
    put(`a/${Array.from({ length: 13 }, (_, i) => `d${i}`).join('/')}/x.txt`, 'x');
    put(
      'z/foo.test.ts',
      "import { it } from 'vitest';\nit('one', () => {});\nit('two', () => {});\n",
    );

    const pyramid = buildPyramid(root, { appData, now });
    expect(pyramid.truncated).toBe(true);
    expect(pyramid.code).toEqual({ files: 1, tests: 2, dynamic: 0 });
  });
});
