import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAutomation } from '../automation/automation.ts';
import { goTestJsonToJUnit } from '../automation/native-reports.ts';
import { importResults } from '../import-results/import-results.ts';
import { isVagueCase } from '../lint/lint.ts';
import { readGroups, writeGroup } from '../store/store.ts';
import {
  adoptRunCommand,
  discoverSuites,
  suiteKeysOf,
  syncSuites,
  syncSuitesOnce,
} from './suites.ts';

/**
 * Каталоги с тестами — кейсы-наборы. Настоящая файловая система во временном
 * каталоге; результаты идут настоящим путём `go test -json` → JUnit панели →
 * импорт, без запуска самого Go.
 */

const NOW = '2026-10-15T20:00:00.000Z';

describe('кейсы-наборы каталогов', () => {
  let root = '';
  const put = (path: string, text = ''): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const cases = () => readGroups(root).flatMap((group) => group.cases);
  const caseOf = (dir: string) => cases().find((item) => item.automation?.file === `${dir}/`);
  const goEvent = (Package: string, Test: string, Action: string, Output?: string) =>
    JSON.stringify({ Action, Package, Test, ...(Output ? { Output } : {}) });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-suites-'));
    put('svc/go.mod', 'module example.com/svc\n\ngo 1.22\n');
    put('svc/internal/auth/auth_test.go');
    put('svc/internal/auth/token_test.go');
    put('svc/internal/store/store_test.go');
    put('svc/main.go');
    put('web/package.json', '{}');
    put('web/src/features/Chat/ui/Message/Message.test.tsx');
    put('web/src/features/Chat/model/thread.test.ts');
    put('web/src/app/app.test.ts');
    put('admin/package.json', '{}');
    put('admin/src/app/app.test.ts');
    put('py/pytest.ini', '[pytest]\n');
    put('py/tests/unit/test_parse.py');
    put('web/node_modules/lib/x.test.js');
    put('.agent/archive/copy/a_test.go');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('находит каталоги по стекам, с ключом, каким прогон называет владельца', () => {
    const { suites } = discoverSuites(root);
    const view = suites.map((item) => `${item.stack} ${item.dir} ${item.key} ${item.files}`);
    expect(view).toEqual([
      'js admin/src/app src/app 1',
      'pytest py/tests/unit tests.unit 1',
      'go svc/internal/auth example.com/svc/internal/auth 2',
      'go svc/internal/store example.com/svc/internal/store 1',
      'js web/src/app src/app 1',
      // Компонентная раскладка сводится к срезу: кейс на срез, а не на файл.
      'js web/src/features/Chat src/features/Chat 2',
    ]);
  });

  it('заводит кейс на каталог; повтор ничего не добавляет; пропавший каталог называется, кейс остаётся', () => {
    const first = syncSuites(root, NOW);
    expect(first.added).toBe(6);
    expect(caseOf('svc/internal/auth')).toMatchObject({
      title: 'Тесты каталога svc/internal/auth (Go)',
      section: 'svc/internal',
      codePaths: ['svc/internal/auth'],
      automation: { status: 'automated', suite: 'example.com/svc/internal/auth' },
    });
    expect(syncSuites(root, NOW).added).toBe(0);

    rmSync(join(root, 'svc', 'internal', 'store'), { recursive: true });
    const after = syncSuites(root, NOW);
    expect(after.added).toBe(0);
    expect(after.missing.map((item) => item.dir)).toEqual(['svc/internal/store']);
    expect(caseOf('svc/internal/store')).toBeDefined();
  });

  it('прогон Go: худший тест пакета — итог кейса, заметка со счётом; другой пакет — свой итог', () => {
    syncSuites(root, NOW);
    const stream = [
      goEvent('example.com/svc/internal/auth', 'TestLogin', 'pass'),
      goEvent(
        'example.com/svc/internal/auth',
        'TestRefresh',
        'output',
        '    token_test.go:12: expired\n',
      ),
      goEvent('example.com/svc/internal/auth', 'TestRefresh', 'fail'),
      goEvent('example.com/svc/internal/auth', 'TestLogout', 'pass'),
      goEvent('example.com/svc/internal/store', 'TestPut', 'pass'),
    ].join('\n');
    const result = importResults(root, {
      format: 'junit',
      content: goTestJsonToJUnit(stream),
      now: NOW,
    });
    expect(result.unmatched).toEqual([]);
    const auth = caseOf('svc/internal/auth');
    expect(auth?.status).toBe('failed');
    expect(auth?.note).toMatch(/^✗ 1\/3 · TestRefresh/);
    expect(caseOf('svc/internal/store')).toMatchObject({ status: 'passed', note: '✓ 1' });
  });

  it('пропуск теста автором не красит набор: прошёл хоть один — «прошёл», пропущено всё — «пропущен»', () => {
    syncSuites(root, NOW);
    const stream = [
      goEvent('example.com/svc/internal/store', 'TestPut', 'skip'),
      goEvent('example.com/svc/internal/store', 'TestGet', 'pass'),
      goEvent('example.com/svc/internal/auth', 'TestLogin', 'skip'),
      goEvent('example.com/svc/internal/auth', 'TestRefresh', 'skip'),
    ].join('\n');
    importResults(root, { format: 'junit', content: goTestJsonToJUnit(stream), now: NOW });
    expect(caseOf('svc/internal/store')).toMatchObject({ status: 'passed', note: '✓ 1' });
    expect(caseOf('svc/internal/auth')?.status).toBe('skipped');
  });

  it('текст кейса — из названий тестов; нетронутый переписывается за тестами, правленый — нет', () => {
    put(
      'web/src/features/Chat/model/thread.test.ts',
      "describe('Лента чата', () => {\n  it('держит порядок сообщений после перезагрузки', () => {});\n" +
        '  it.skip("показывает \'печатает…\', пока агент отвечает", () => {});\n});\n',
    );
    put(
      'svc/internal/auth/auth_test.go',
      'package auth\n\nfunc TestLogin_ExpiredToken(t *testing.T) {\n' +
        '\tfor _, tc := range []struct{ name string }{{name: "refresh token rotates"}} {\n' +
        '\t\tt.Run(tc.name, func(t *testing.T) {})\n\t}\n}\n',
    );
    put(
      'py/tests/unit/test_parse.py',
      '"""Разбор конфигурации клиента."""\n\n\ndef test_reads_yaml(\n    tmp_path,\n) -> None:\n' +
        '    """Читает YAML с комментариями."""\n\n\ndef test_empty():\n    pass\n\n\n' +
        'def test_merge():\n    """Сливает профиль\n    с базовым конфигом. Подробности ниже."""\n',
    );
    syncSuites(root, NOW);
    const chat = caseOf('web/src/features/Chat');
    expect(chat?.title).toBe('web/src/features/Chat: Лента чата');
    // Шаги — по пути файла: model/thread раньше ui/Message.
    expect(chat?.steps).toEqual([
      {
        action: 'Прогнать thread.test.ts (2)',
        expected:
          "Проходят: держит порядок сообщений после перезагрузки; показывает 'печатает…', пока агент отвечает",
      },
      {
        action: 'Прогнать Message.test.tsx',
        expected: 'В отчёте прогона нет упавших тестов из Message.test.tsx',
      },
    ]);
    expect(chat?.expected).toMatch(/^Все проверки каталога \(2\) проходят/);
    expect(chat?.oracle).toMatch(/JUnit/);
    // Свой текст панели линтер «пустым ожиданием» не назовёт — даже у файла без названий.
    expect(
      cases()
        .filter(isVagueCase)
        .map((item) => item.automation?.file),
    ).toEqual([]);
    // Строка табличного теста — проверка, имя функции — её контекст.
    expect(caseOf('svc/internal/auth')?.steps[0]?.expected).toBe(
      'Проходят: Login: expired token — refresh token rotates',
    );
    const py = caseOf('py/tests/unit');
    expect(py?.purpose).toContain('Разбор конфигурации клиента.');
    // Проверок мало — шаг на каждую: поведение действием, доказывающий тест ожиданием;
    // docstring в несколько строк читается до конца первой мысли.
    expect(py?.steps).toEqual([
      {
        action: 'Проверить: Читает YAML с комментариями',
        expected: 'Проходит test_reads_yaml в test_parse.py',
      },
      { action: 'Проверить: Empty', expected: 'Проходит test_empty в test_parse.py' },
      {
        action: 'Проверить: Сливает профиль с базовым конфигом',
        expected: 'Проходит test_merge в test_parse.py',
      },
    ]);

    // Новый тест в каталоге — нетронутый кейс переписывается сам.
    put(
      'web/src/features/Chat/model/draft.test.ts',
      "it('хранит черновик поля ввода', () => {});\n",
    );
    expect(syncSuites(root, NOW).refreshed).toBe(1);
    expect(caseOf('web/src/features/Chat')?.steps.map((step) => step.action)).toContain(
      'Прогнать draft.test.ts (1)',
    );
    // Кейс поправил человек — панель его больше не трогает.
    const group = readGroups(root).find((item) => item.cases.some((c) => c.id === py?.id));
    writeGroup(root, {
      ...group!,
      cases: group!.cases.map((c) => (c.id === py?.id ? { ...c, expected: 'Своё ожидание' } : c)),
    });
    put('py/tests/unit/test_more.py', 'def test_more():\n    pass\n');
    expect(syncSuites(root, NOW).refreshed).toBe(0);
    expect(caseOf('py/tests/unit')?.expected).toBe('Своё ожидание');
  });

  it('табличный тест — одно поведение: шаг на функцию, строки — в ожидании; заголовок короткий', () => {
    const rows = Array.from({ length: 10 }, (_, i) => `{name: "срок ${i + 1} мин"}`).join(', ');
    put(
      'svc/internal/store/store_test.go',
      `package store\n\nfunc TestLoad_ClientTimeout(t *testing.T) {\n\tfor _, tc := range []row{${rows}} {}\n}\n\n` +
        'func TestPutKeepsOrder(t *testing.T) {}\n\nfunc TestGetMissing(t *testing.T) {}\n',
    );
    syncSuites(root, NOW);
    const store = caseOf('svc/internal/store');
    expect(store?.title).toBe('svc/internal/store: Load: client timeout (10) (+2)');
    expect(store?.steps.map((step) => step.action)).toEqual([
      'Проверить: Load: client timeout',
      'Проверить: Put keeps order',
      'Проверить: Get missing',
    ]);
    expect(store?.steps[0]?.expected).toBe(
      'Проходит TestLoad_ClientTimeout в store_test.go: срок 1 мин; срок 2 мин; срок 3 мин; ' +
        'срок 4 мин; срок 5 мин; срок 6 мин; срок 7 мин; срок 8 мин; …и ещё 2',
    );
    expect(store?.purpose).toContain('проверок: 12, файлов: 1');
  });

  it('кейс первой версии (один шаг «Прогнать тесты каталога») переписывается в текст по тестам', () => {
    put(
      'svc/internal/store/store_test.go',
      'package store\n\nfunc TestPutKeepsOrder(t *testing.T) {}\n',
    );
    writeGroup(root, {
      id: 'suites-svc',
      title: 'Наборы тестов: svc',
      file: 'suites-svc.tests.json',
      cases: [
        {
          id: 'suites-svc-001',
          type: 'case',
          title: 'Тесты каталога svc/internal/store (Go)',
          steps: [
            {
              action: 'Прогнать тесты каталога svc/internal/store',
              expected: 'Ни одного провала, пакет собирается',
            },
          ],
          expected: 'Все тесты каталога проходят',
          automation: {
            status: 'automated',
            file: 'svc/internal/store/',
            suite: 'example.com/svc/internal/store',
          },
          status: 'passed',
          source: 'agent',
        },
      ],
    });
    expect(syncSuites(root, NOW).refreshed).toBe(1);
    const store = caseOf('svc/internal/store');
    expect(store).toMatchObject({ id: 'suites-svc-001', status: 'passed' });
    expect(store?.steps).toEqual([
      {
        action: 'Проверить: Put keeps order',
        expected: 'Проходит TestPutKeepsOrder в store_test.go',
      },
    ]);
    expect(store?.automation?.suiteDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('сборка не прошла: каталогу — свои строки ошибки, а не соседа по общей зависимости', () => {
    syncSuites(root, NOW);
    // Форма потока — как у Go 1.24+ при недостающей записи go.sum: вывод лежит
    // под ImportPath зависимости, секции подписаны пакетом, FailedBuild — на первую.
    const build = (ImportPath: string, Output: string) =>
      JSON.stringify({ ImportPath, Action: 'build-output', Output });
    const fail = (Package: string, FailedBuild: string) =>
      JSON.stringify({ Action: 'fail', Package, Elapsed: 0, FailedBuild });
    const auth = 'example.com/svc/internal/auth';
    const store = 'example.com/svc/internal/store';
    const stream = [
      build('github.com/x/otel', `# ${auth}\n`),
      build('github.com/x/otel', 'auth.go:3:2: missing go.sum entry for github.com/x/otel\n'),
      build('github.com/x/otel', `# ${store}\n`),
      build('github.com/x/otel', 'store.go:4:2: missing go.sum entry for github.com/x/otel\n'),
      build('github.com/lib/pq', `# ${store}\n`),
      build('github.com/lib/pq', 'store.go:5:2: missing go.sum entry for github.com/lib/pq\n'),
      fail(auth, 'github.com/x/otel'),
      fail(store, 'github.com/x/otel'),
    ].join('\n');
    importResults(root, { format: 'junit', content: goTestJsonToJUnit(stream), now: NOW });
    const authNote = caseOf('svc/internal/auth')?.note ?? '';
    const storeNote = caseOf('svc/internal/store')?.note ?? '';
    expect(authNote).toContain('auth.go:3:2');
    expect(authNote).not.toContain('store.go');
    expect(storeNote).toContain('store.go:4:2');
    expect(storeNote).toContain('github.com/lib/pq');
    expect(storeNote).not.toContain('auth.go');
  });

  it('кейс на сам тест сильнее набора каталога', () => {
    syncSuites(root, NOW);
    writeGroup(root, {
      id: 'login',
      title: 'Вход',
      file: 'login.tests.json',
      cases: [
        {
          id: 'login-001',
          type: 'case',
          title: 'Вход',
          steps: [],
          automation: { status: 'automated', testName: 'TestLogin' },
          source: 'agent',
          status: 'unknown',
        },
      ],
    });
    const stream = [
      goEvent('example.com/svc/internal/auth', 'TestLogin', 'fail'),
      goEvent('example.com/svc/internal/auth', 'TestLogout', 'pass'),
    ].join('\n');
    importResults(root, { format: 'junit', content: goTestJsonToJUnit(stream), now: NOW });
    expect(cases().find((item) => item.id === 'login-001')?.status).toBe('failed');
    expect(caseOf('svc/internal/auth')).toMatchObject({ status: 'passed', note: '✓ 1' });
  });

  it('JS: одинаковый путь в двух пакетах не угадывается; путь от корня проекта — однозначен', () => {
    syncSuites(root, NOW);
    const junit = (classname: string) =>
      `<testsuites><testsuite name="s"><testcase classname="${classname}" name="renders"><failure message="boom"/></testcase></testsuite></testsuites>`;
    const ambiguous = importResults(root, {
      format: 'junit',
      content: junit('src/app/app.test.ts'),
      now: NOW,
    });
    expect(ambiguous.matched).toBe(0);
    expect(caseOf('web/src/app')?.status).toBe('unknown');
    expect(caseOf('admin/src/app')?.status).toBe('unknown');

    importResults(root, { format: 'junit', content: junit('web/src/app/app.test.ts'), now: NOW });
    expect(caseOf('web/src/app')?.status).toBe('failed');
    expect(caseOf('admin/src/app')?.status).toBe('unknown');

    // Единственный в проекте путь от корня пакета узнаётся и так.
    importResults(root, {
      format: 'junit',
      content: junit('src/features/Chat/ui/Message/Message.test.tsx'),
      now: NOW,
    });
    expect(caseOf('web/src/features/Chat')?.status).toBe('failed');
  });

  it('ключи владельца: путь — к предкам, файл — и к корню пакета, имя через точку — без класса и модуля', () => {
    expect(suiteKeysOf('example.com/svc/internal/auth')).toEqual([
      'example.com/svc/internal/auth',
      'example.com/svc/internal',
      'example.com/svc',
      'example.com',
    ]);
    expect(suiteKeysOf('app.test.ts')).toEqual(['app.test.ts', '.']);
    expect(suiteKeysOf('tests.unit.test_parse.TestParse')).toEqual([
      'tests.unit.test_parse.TestParse',
      'tests.unit.test_parse',
      'tests.unit',
    ]);
  });

  it('команда прогона: нет своей — рецепт с программой на машине и с большим числом тестов; своя не трогается', () => {
    const noGo = (tool: string) => tool !== 'go';
    expect(adoptRunCommand(root, true, () => true)).toBe('go:svc');
    expect(readAutomation(root)).toEqual({});
    expect(adoptRunCommand(root, false, noGo)).toMatch(/^pytest:py/);
    expect(readAutomation(root).automation?.command).toContain('pytest');
    // Своя команда уже есть — второй вызов ничего не меняет.
    expect(adoptRunCommand(root, false, () => true)).toBeUndefined();
    expect(readAutomation(root).automation?.command).toContain('pytest');
    // Сломанную руками не чинит молча.
    writeFileSync(join(root, '.agent', 'tests', 'automation.json'), '[1]');
    expect(adoptRunCommand(root, false, () => true)).toBeUndefined();
  });

  it('сам — один раз и только туда, где git файлов не увидит', () => {
    const appData = mkdtempSync(join(tmpdir(), 'cc-suites-app-'));
    // Глобальный игнор машины мог бы прятать .agent: гит теста видит только свой репозиторий.
    const saved = { global: process.env.GIT_CONFIG_GLOBAL, xdg: process.env.XDG_CONFIG_HOME };
    process.env.GIT_CONFIG_GLOBAL = join(appData, 'no-gitconfig');
    process.env.XDG_CONFIG_HOME = join(appData, 'xdg');
    execFileSync('git', ['init', '-q'], { cwd: root });
    try {
      // Репозиторий не прячет .agent — сам панель не пишет.
      expect(syncSuitesOnce(appData, root, NOW)).toBeUndefined();
      expect(existsSync(join(root, '.agent', 'tests'))).toBe(false);
      writeFileSync(join(root, '.git', 'info', 'exclude'), '.agent/\n');
      expect(syncSuitesOnce(appData, root, NOW)?.added).toBe(6);
      // Второй раз — нет: дальше новые каталоги заводит агент или tests-cli suites.
      rmSync(join(root, '.agent'), { recursive: true });
      expect(syncSuitesOnce(appData, root, NOW)).toBeUndefined();
      // Проект, где кейсы уже ведут, сам наборами не засыпается.
      const curated = mkdtempSync(join(tmpdir(), 'cc-suites-curated-'));
      try {
        mkdirSync(join(curated, 'pkg'), { recursive: true });
        writeFileSync(join(curated, 'pkg', 'package.json'), '{}');
        writeFileSync(join(curated, 'pkg', 'a.test.ts'), '');
        writeGroup(curated, {
          id: 'own',
          title: 'Свои',
          file: 'own.tests.json',
          cases: [
            {
              id: 'own-001',
              type: 'case',
              title: 'Свой',
              steps: [],
              status: 'unknown',
              source: 'human',
            },
          ],
        });
        expect(syncSuitesOnce(appData, curated, NOW)).toBeUndefined();
        expect(readGroups(curated).map((group) => group.id)).toEqual(['own']);
      } finally {
        rmSync(curated, { recursive: true, force: true });
      }
    } finally {
      for (const [name, value] of [
        ['GIT_CONFIG_GLOBAL', saved.global],
        ['XDG_CONFIG_HOME', saved.xdg],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(appData, { recursive: true, force: true });
    }
  });
});
