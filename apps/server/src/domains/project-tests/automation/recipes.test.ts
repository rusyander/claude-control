import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { automationRecipes } from './recipes.ts';
import { automationCommand } from './automation.ts';

/**
 * Рецепты команды прогона по файлам проекта: какой стек, из какого каталога,
 * куда отчёт и чего не хватает на машине. Программы на машине — подставная
 * проверка: вопрос теста — что рецепт скажет при их наличии и отсутствии.
 */
describe('project-tests/automation/recipes: готовые команды бэкенда', () => {
  let root = '';
  const put = (path: string, body = ''): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  const all = () => true;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-recipes-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('Go в корне: go test -json по пакетам кейсов, отчёт переводит панель', () => {
    put('go.mod', 'module example.com/shop\n');
    put('internal/orders/orders_test.go', 'package orders\n');
    const [recipe] = automationRecipes(root, all);
    expect(recipe).toMatchObject({
      id: 'go:',
      stack: 'go',
      dir: '',
      evidence: ['go.mod'],
      tests: 1,
      wholeSuite: false,
      automation: {
        command: 'go test -json {packages} > {report}',
        format: 'go-test-json',
      },
    });
    expect(recipe?.missing).toBeUndefined();
    // Выбор группы сужает прогон до пакетов её файлов; без выбора — весь модуль.
    const narrowed = automationCommand(
      root,
      recipe!.automation,
      ['internal/orders/a_test.go'],
      'r.json',
    );
    expect(narrowed.line).toBe('go test -json ./internal/orders > r.json');
    expect(automationCommand(root, recipe!.automation, [], 'r.json').line).toBe(
      'go test -json ./... > r.json',
    );
  });

  it('модуль без тестов рецепта не даёт: прогонять нечего', () => {
    put('go.mod', 'module example.com/shop\n');
    put('main.go', 'package main\n');
    expect(automationRecipes(root, all)).toEqual([]);
  });

  it('pytest в подкаталоге с uv: переход в каталог, весь набор, pytest подтянут uv', () => {
    put('backend/pyproject.toml', '[project]\nname="api"\n\n[tool.pytest.ini_options]\n');
    put('backend/uv.lock', '');
    put('backend/tests/test_orders.py', 'def test_x(): pass\n');
    const [recipe] = automationRecipes(root, all);
    expect(recipe).toMatchObject({
      id: 'pytest:backend',
      dir: 'backend',
      tool: 'uv',
      wholeSuite: true,
      automation: { command: 'cd backend && uv run --with pytest pytest --junitxml={report}' },
    });
    expect(recipe?.evidence).toEqual(['backend/pyproject.toml', 'backend/uv.lock']);
  });

  it('pytest в .venv без pytest — назван до прогона, с командой установки в это окружение', () => {
    put('pytest.ini', '[pytest]\n');
    put('tests/test_a.py', '');
    const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
    put(python, '');
    const [recipe] = automationRecipes(root, all);
    expect(recipe).toMatchObject({ stack: 'pytest', tool: 'pytest', missing: true });
    expect(recipe?.install).toContain('-m pip install pytest');
    expect(recipe?.automation.command).toContain('-m pytest --junitxml={report} {paths}');
  });

  it('test_*.py без признаков pytest и проекта Python — не рецепт', () => {
    put('scripts/test_helper.py', '');
    expect(automationRecipes(root, all)).toEqual([]);
  });

  it('подпроект Gradle с обёрткой в корне: задачи с путём, каталог отчётов, cleanTest', () => {
    put('gradlew', '');
    put('gradlew.bat', '');
    put('settings.gradle', "include 'svc'\n");
    put('svc/build.gradle', "plugins { id 'java' }\n");
    put('svc/src/test/java/com/shop/OrderTest.java', 'class OrderTest {}\n');
    const [recipe] = automationRecipes(root, all);
    const wrapper = process.platform === 'win32' ? 'gradlew' : './gradlew';
    expect(recipe).toMatchObject({
      id: 'gradle:svc',
      dir: 'svc',
      wholeSuite: true,
      automation: {
        command: `${wrapper} :svc:cleanTest :svc:test`,
        report: 'svc/build/test-results/test/',
      },
    });
    expect(recipe?.automation.format).toBeUndefined();
  });

  it('Maven без обёртки и без mvn — рецепт есть, программа названа', () => {
    put('api/pom.xml', '<project/>');
    put('api/src/test/java/com/shop/PayTest.java', '');
    const [recipe] = automationRecipes(root, () => false);
    expect(recipe).toMatchObject({
      id: 'maven:api',
      tool: 'mvn',
      missing: true,
      install: 'https://maven.apache.org/install.html',
      automation: {
        command: 'cd api && mvn -B -fae test',
        report: 'api/target/surefire-reports/',
      },
    });
  });

  it('Cargo: вывод вместе с потоком ошибок, у workspace — все члены', () => {
    put('Cargo.toml', '[workspace]\nmembers = ["core"]\n');
    put('core/Cargo.toml', '[package]\nname = "core"\n');
    put('core/src/lib.rs', '#[cfg(test)]\nmod tests {\n  #[test]\n  fn ok() {}\n}\n');
    const recipes = automationRecipes(root, all);
    expect(recipes.map((recipe) => recipe.id)).toEqual(['cargo:', 'cargo:core']);
    expect(recipes[0]?.automation).toMatchObject({
      command: 'cargo test --workspace --no-fail-fast > {report} 2>&1',
      format: 'cargo-test',
    });
    expect(recipes[1]?.automation.command).toBe(
      'cd core && cargo test --no-fail-fast > {report} 2>&1',
    );
  });

  it('много go.mod: один рецепт на все модули; с выбором — только модули и пакеты выбранного', () => {
    put('api/go.mod', 'module example.com/api\n');
    put('api/auth/auth_test.go', 'package auth\n');
    put('svc/go.mod', 'module example.com/svc\n');
    put('svc/orders/orders_test.go', 'package orders\n');
    put('svc/store/store_test.go', 'package store\n');
    const recipes = automationRecipes(root, all);
    expect(recipes.map((recipe) => recipe.id)).toEqual(['go:*', 'go:api', 'go:svc']);
    const own = recipes[0]?.automation ?? { command: '' };
    expect(own).toMatchObject({ command: '{go-modules}', format: 'go-test-json' });
    // Каждое звено в скобках: cmd читает `A || echo - && B` как `A || (echo - && B)`,
    // и после зелёного первого модуля остальные не запускались.
    expect(automationCommand(root, own, [], 'r.json', true).line).toBe(
      '(go test -C api -json ./... > r.json || echo -) && (go test -C svc -json ./... >> r.json || echo -)',
    );
    // Кейс-набор каталога (`file` кончается `/`) и обычный файл теста — оба к пакету.
    const narrowed = automationCommand(
      root,
      own,
      ['svc/orders/', 'svc/store/store_test.go'],
      'r.json',
    );
    expect(narrowed.line).toBe('go test -C svc -json ./orders ./store > r.json || echo -');
  });

  it('каталоги сборки и зависимостей не обходятся', () => {
    put('node_modules/pkg/go.mod', 'module x\n');
    put('node_modules/pkg/a_test.go', '');
    put('target/Cargo.toml', '[package]\n');
    expect(automationRecipes(root, all)).toEqual([]);
  });
});
