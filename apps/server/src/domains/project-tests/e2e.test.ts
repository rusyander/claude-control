import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSpec } from './e2e-parse.ts';
import {
  e2eChangedSince,
  fullTestName,
  groupIdOfFile,
  onboardE2e,
  syncE2eFolder,
} from './e2e-sync.ts';
import { createE2eFolder, e2eFolderView, removeE2eFolder } from './e2e-folder.ts';
import { e2eChatLine } from './e2e-chat.ts';
import { readGroups } from './store.ts';
import { isWritable, runScope, describeScope } from './run-permissions.ts';
import { buildPrompt } from './prompt.ts';

/**
 * Папка e2e: разбор спек без запуска, сверка с кейсами, заведение и уборка
 * папки на настоящем репозитории во временном каталоге.
 *
 * Главное свойство уборки проверяется снимком байтов ВСЕГО проекта вне `.git`
 * плюс файла исключений: «вернули как было» без снимка — это надежда.
 */

const SPEC = `import { test, expect } from '@playwright/test';

test.describe('Вход', () => {
  test('[auth-001] вход по паролю @smoke', async ({ page }) => {
    // Given пользователь зарегистрирован
    // When вводит логин и пароль
    // And нажимает «Войти»
    // Then видит свой профиль
    await page.goto('/');
  });

  test('неверный пароль', { tag: ['@regression'] }, async ({ page }) => {
    // Дано: открыта форма входа
    // Когда: вводит неверный пароль
    // Тогда: видит ошибку
    await expect(page.getByRole('alert')).toBeVisible();
  });

  for (const role of ['admin', 'user']) {
    test(\`роль \${role}\`, async () => {});
  }

  // test('закомментированный', () => {});
  const text = "test('в строке', () => {})";
});
`;

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Остаётся в temp — на результат не влияет.
  }
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/** Байты проекта вне `.git` и файл исключений — то, что уборка обязана вернуть. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path === join(root, '.git')) continue;
        out[`${relative(root, path)}/`] = 'dir';
        walk(path);
      } else out[relative(root, path)] = readFileSync(path, 'latin1');
    }
  };
  walk(root);
  const exclude = join(root, '.git', 'info', 'exclude');
  out['.git/info/exclude'] = existsSync(exclude) ? readFileSync(exclude, 'latin1') : '<none>';
  out['.git/info/'] = existsSync(join(root, '.git', 'info')) ? 'dir' : '<none>';
  return out;
}

describe('parseSpec', () => {
  const spec = parseSpec(SPEC);

  it('находит тесты с describe, меткой id и тегами; строки и комментарии не тесты', () => {
    expect(spec.tests.map((item) => item.title)).toEqual([
      '[auth-001] вход по паролю @smoke',
      'неверный пароль',
    ]);
    expect(spec.topDescribe).toBe('Вход');
    const [first, second] = spec.tests;
    expect(first?.id).toBe('auth-001');
    expect(first?.tags).toEqual(['smoke']);
    expect(first?.caseTitle).toBe('вход по паролю');
    expect(first?.titlePath).toEqual(['Вход']);
    expect(second?.id).toBeUndefined();
    expect(second?.tags).toEqual(['regression']);
  });

  it('Given/When/Then — по-английски и по-русски, And продолжает шаг', () => {
    const [first, second] = spec.tests;
    expect(first?.precondition).toBe('пользователь зарегистрирован');
    expect(first?.steps).toEqual(['вводит логин и пароль', 'нажимает «Войти»']);
    expect(first?.expected).toBe('видит свой профиль');
    expect(second?.precondition).toBe('открыта форма входа');
    expect(second?.steps).toEqual(['вводит неверный пароль']);
    expect(second?.expected).toBe('видит ошибку');
  });

  it('имя из шаблона с подстановкой не угадывается, а называется пропущенным', () => {
    expect(spec.skipped).toEqual([{ line: 20, reason: 'dynamic-title' }]);
  });

  /** F-318. Обратная кавычка в регулярке открывала «строку» и прятала следующие тесты. */
  it('кавычки внутри регулярки не прячут следующие тесты; деление — не регулярка', () => {
    const text = [
      "test('[b-001] first', async () => { const s = x.replace(/`/g, ''); });",
      "test('[b-002] second', async () => { const r = /['\"]/.test(y); });",
      "test('[b-003] third', async () => { const half = total / 2 / 1; });",
      "test('[b-004] fourth', async () => {});",
    ].join('\n');
    expect(parseSpec(text).tests.map((test) => test.id)).toEqual([
      'b-001',
      'b-002',
      'b-003',
      'b-004',
    ]);
  });

  it('test.step важнее комментариев', () => {
    const parsed = parseSpec(
      "it('x', async () => { // When комментарий\n await test.step('открыть', () => {}); });",
    );
    expect(parsed.tests[0]?.steps).toEqual(['открыть']);
  });

  it('полное имя — как у junit Playwright; группа — по имени файла', () => {
    expect(fullTestName(spec.tests[0]!)).toBe('Вход › [auth-001] вход по паролю @smoke');
    expect(groupIdOfFile('e2e/auth/login.spec.ts')).toBe('login');
    expect(groupIdOfFile('tests/e2e/Checkout Flow.e2e.ts')).toBe('checkout-flow');
    expect(groupIdOfFile('e2e/__x.spec.ts')).toBe('x');
  });
});

describe('папка e2e на настоящем репозитории', () => {
  let root = '';
  let appData = '';
  const now = '2026-09-26T10:00:00.000Z';

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-e2e-')));
    appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-e2e-data-')));
    git(root, 'init', '-q');
    writeFileSync(join(root, 'README.md'), '# app\n');
  });

  afterEach(() => {
    dropTemp(root);
    dropTemp(appData);
  });

  it('заводит e2e/, прячет от git, а уборка возвращает проект байт в байт', () => {
    const before = snapshot(root);
    expect(e2eFolderView(root, appData).state).toBe('missing');

    const created = createE2eFolder(appData, root, now);
    expect(created).toMatchObject({ state: 'created', dir: 'e2e', excluded: true, git: true });
    expect(existsSync(join(root, 'e2e', 'playwright.config.ts'))).toBe(true);
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toMatch(/^\/e2e$/m);
    // Скрыта: git не видит ни одного файла папки.
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).not.toContain('e2e/');

    // Повтор ничего не пишет: папка уже есть.
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'latin1');
    createE2eFolder(appData, root, now);
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'latin1')).toBe(exclude);

    expect(removeE2eFolder(appData, root, false).state).toBe('missing');
    expect(snapshot(root)).toEqual(before);
  });

  it('чужой файл в заведённой папке: без force — 409 со счётом, с force — байт в байт', () => {
    const before = snapshot(root);
    createE2eFolder(appData, root, now);
    writeFileSync(join(root, 'e2e', 'auth.spec.ts'), SPEC);
    let failure: unknown;
    try {
      removeE2eFolder(appData, root, false);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ statusCode: 409, messageCode: 'e2e-folder-not-empty' });
    expect(existsSync(join(root, 'e2e', 'auth.spec.ts'))).toBe(true);
    removeE2eFolder(appData, root, true);
    expect(snapshot(root)).toEqual(before);
  });

  it('файл исключений правили после панели — снимаются только свои строки', () => {
    createE2eFolder(appData, root, now);
    const file = join(root, '.git', 'info', 'exclude');
    writeFileSync(file, `${readFileSync(file, 'latin1')}/local-notes/\n`, 'latin1');
    removeE2eFolder(appData, root, false);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('/local-notes/');
    expect(text).not.toMatch(/^\/e2e$/m);
  });

  /** F-314. Своя строка `/e2e` человека, бывшая до панели, — не наша. */
  it('файл исключений правили после панели — своя строка /e2e человека остаётся', () => {
    const file = join(root, '.git', 'info', 'exclude');
    writeFileSync(file, '# my excludes\n/e2e\n', 'latin1');
    createE2eFolder(appData, root, now);
    writeFileSync(file, `${readFileSync(file, 'latin1')}/local-notes/\n`, 'latin1');
    removeE2eFolder(appData, root, false);
    expect(readFileSync(file, 'latin1')).toBe('# my excludes\n/e2e\n/local-notes/\n');
  });

  /** F-315. Ссылка на каталог в заготовке — чужое, 409, а не EISDIR и 500. */
  it('ссылка на каталог в заведённой папке — 409 со счётом', () => {
    createE2eFolder(appData, root, now);
    const outside = join(appData, 'linked-dir');
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'e2e', 'linked'), 'junction');
    let failure: unknown;
    try {
      removeE2eFolder(appData, root, false);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ statusCode: 409, messageCode: 'e2e-folder-not-empty' });
    expect(existsSync(outside)).toBe(true);
  });

  it('своя папка проекта берётся как есть и не убирается панелью', () => {
    mkdirSync(join(root, 'tests', 'e2e'), { recursive: true });
    writeFileSync(join(root, 'tests', 'e2e', 'auth.spec.ts'), SPEC);
    const before = snapshot(root);
    const view = createE2eFolder(appData, root, now);
    expect(view).toMatchObject({
      state: 'found',
      dir: 'tests/e2e',
      framework: 'playwright',
      specs: 1,
    });
    expect(snapshot(root)).toEqual(before);
    expect(() => removeE2eFolder(appData, root, false)).toThrow(/не панель/);
  });

  it('testDir из конфига Playwright важнее обычного имени', () => {
    mkdirSync(join(root, 'e2e'));
    mkdirSync(join(root, 'qa', 'flows'), { recursive: true });
    writeFileSync(join(root, 'playwright.config.ts'), "export default { testDir: './qa/flows' };");
    const view = e2eFolderView(root, appData);
    expect(view).toMatchObject({ dir: 'qa/flows', origin: 'config', candidates: ['e2e'] });
  });

  it('сверка: новые тесты — кейсы, метка сохраняет id, второй проход не меняет ни байта', () => {
    mkdirSync(join(root, 'e2e'));
    writeFileSync(join(root, 'e2e', 'auth.spec.ts'), SPEC);
    const first = syncE2eFolder(root, now, { appData });
    expect(first).toMatchObject({ dir: 'e2e', files: 1, tests: 2, added: 2, groups: ['auth'] });
    const [group] = readGroups(root);
    expect(group?.title).toBe('Вход');
    expect(group?.cases.map((item) => item.id)).toEqual(['auth-001', 'auth-002']);
    expect(group?.cases[0]).toMatchObject({
      title: 'вход по паролю',
      tags: ['smoke'],
      precondition: 'пользователь зарегистрирован',
      expected: 'видит свой профиль',
      automation: {
        status: 'automated',
        file: 'e2e/auth.spec.ts',
        externalId: 'auth-001',
        testName: 'Вход › [auth-001] вход по паролю @smoke',
      },
    });

    const file = join(root, '.agent', 'tests', 'auth.tests.json');
    const bytes = readFileSync(file, 'latin1');
    const mtime = statSync(file).mtimeMs;
    const second = syncE2eFolder(root, '2026-09-27T10:00:00.000Z', { appData });
    expect(second).toMatchObject({ added: 0, linked: 0 });
    expect(readFileSync(file, 'latin1')).toBe(bytes);
    expect(statSync(file).mtimeMs).toBe(mtime);
  });

  /** F-347. Вывод раннера внутри папки не повод для сверки: время его каталогов не в счёт. */
  it('e2eChangedSince: новый вывод раннера в __pycache__ — «не менялась»', () => {
    mkdirSync(join(root, 'e2e', '__pycache__'), { recursive: true });
    writeFileSync(join(root, 'e2e', 'auth.spec.ts'), SPEC);
    const old = new Date(Date.now() - 3_600_000);
    for (const path of ['e2e', 'e2e/__pycache__', 'e2e/auth.spec.ts']) {
      utimesSync(join(root, path), old, old);
    }
    const since = Date.now() - 60_000;
    mkdirSync(join(root, 'e2e', '__pycache__', 'auth-run'));
    expect(e2eChangedSince(root, 'e2e', since)).toBe(false);
    writeFileSync(join(root, 'e2e', 'auth.spec.ts'), `${SPEC}\n`);
    expect(e2eChangedSince(root, 'e2e', since)).toBe(true);
  });

  /** F-320. Одна метка `[id]` в двух файлах давала два кейса с одним id в двух группах. */
  it('одна метка в двух файлах — разные id кейсов, повторная сверка ничего не меняет', () => {
    mkdirSync(join(root, 'e2e'));
    const spec = (title: string) =>
      `import { test } from '@playwright/test';\ntest('[dup-001] ${title}', async () => {});\n`;
    writeFileSync(join(root, 'e2e', 'alpha.spec.ts'), spec('alpha'));
    writeFileSync(join(root, 'e2e', 'beta.spec.ts'), spec('beta'));
    syncE2eFolder(root, now, { appData });
    const ids = readGroups(root).flatMap((group) => group.cases.map((item) => item.id));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);

    const files = ['alpha', 'beta'].map((name) =>
      readFileSync(join(root, '.agent', 'tests', `${name}.tests.json`), 'latin1'),
    );
    const again = syncE2eFolder(root, '2026-09-27T10:00:00.000Z', { appData });
    expect(again).toMatchObject({ added: 0, linked: 0 });
    expect(
      ['alpha', 'beta'].map((name) =>
        readFileSync(join(root, '.agent', 'tests', `${name}.tests.json`), 'latin1'),
      ),
    ).toEqual(files);
  });

  it('сверка не переписывает описание человека и называет исчезнувший тест', () => {
    mkdirSync(join(root, 'e2e'));
    writeFileSync(join(root, 'e2e', 'auth.spec.ts'), SPEC);
    syncE2eFolder(root, now, { appData });
    const file = join(root, '.agent', 'tests', 'auth.tests.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.cases[0].expected = 'написано человеком';
    data.cases[0].precondition = 'условие от человека';
    writeFileSync(file, JSON.stringify(data));
    writeFileSync(
      join(root, 'e2e', 'auth.spec.ts'),
      SPEC.replace(/test\('неверный пароль'[\s\S]*?\n {2}\}\);\n/, ''),
    );
    const again = syncE2eFolder(root, now, { appData });
    expect(again.missing).toEqual([
      { groupId: 'auth', caseId: 'auth-002', file: 'e2e/auth.spec.ts' },
    ]);
    const [group] = readGroups(root);
    expect(group?.cases[0]?.expected).toBe('написано человеком');
    expect(group?.cases[0]?.precondition).toBe('условие от человека');
    expect(group?.cases).toHaveLength(2);
  });

  it('метка не по порядку становится id кейса как есть, тест без метки — следующим номером', () => {
    mkdirSync(join(root, 'e2e'));
    writeFileSync(
      join(root, 'e2e', 'auth.spec.ts'),
      "test('[auth-042] выход', async () => {});\ntest('смена пароля', async () => {});\n",
    );
    syncE2eFolder(root, now, { appData });
    expect(readGroups(root)[0]?.cases.map((item) => item.id)).toEqual(['auth-042', 'auth-002']);
  });

  it('файла исключений не было — уборка его не оставляет', () => {
    rmSync(join(root, '.git', 'info', 'exclude'), { force: true });
    const before = snapshot(root);
    createE2eFolder(appData, root, now);
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toMatch(/^\/e2e$/m);
    removeE2eFolder(appData, root, false);
    expect(snapshot(root)).toEqual(before);
  });

  it('нет папки — сверка отказывает кодом', () => {
    expect(() => syncE2eFolder(root, now, { appData })).toThrow(
      expect.objectContaining({ messageCode: 'e2e-missing' }),
    );
  });

  it('добавление проекта: своя папка — сразу в кейсы, нет — панель заводит свою', () => {
    mkdirSync(join(root, 'e2e'));
    writeFileSync(join(root, 'e2e', 'auth.spec.ts'), SPEC);
    expect(onboardE2e(appData, root, now)).toMatchObject({
      state: 'found',
      sync: { added: 2 },
    });

    const empty = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-e2e-empty-')));
    try {
      git(empty, 'init', '-q');
      expect(onboardE2e(appData, empty, now)).toEqual({
        state: 'created',
        dir: 'e2e',
        excluded: true,
      });
      expect(onboardE2e('', join(empty, 'nope'), now)).toBeUndefined();
      expect(e2eFolderView(empty, appData)).toMatchObject({ state: 'created', excluded: true });
    } finally {
      dropTemp(empty);
    }
  });
});

describe('генерация с кодом тестов', () => {
  it('права: папка e2e открыта только генерации с e2e, код приложения закрыт', () => {
    const root = join(tmpdir(), 'cc-e2e-scope');
    const scope = runScope(root, 'generate', [], 'e2e');
    expect(isWritable(scope, join(root, 'e2e', 'auth.spec.ts'))).toBe(true);
    expect(isWritable(scope, join(root, '.agent', 'tests', 'drafts', 'x.draft.json'))).toBe(true);
    expect(isWritable(scope, join(root, '.agent', 'tests', 'gui.tests.json'))).toBe(false);
    expect(isWritable(scope, join(root, 'src', 'app.ts'))).toBe(false);
    expect(describeScope(scope)).toContain('e2e/');
    // Без e2e у генерации прав на папку нет, как и у прогона.
    expect(isWritable(runScope(root, 'generate'), join(root, 'e2e', 'a.spec.ts'))).toBe(false);
    expect(isWritable(runScope(root, 'run', [], 'e2e'), join(root, 'e2e', 'a.spec.ts'))).toBe(
      false,
    );
  });

  it('задание называет папку, метку id, Given/When/Then, отчёт junit и стенд', () => {
    const prompt = buildPrompt(
      [],
      { projectPath: '/p', mode: 'generate', e2e: true },
      {
        shared: [],
        environment: { id: 'stage', title: 'Стенд', baseUrl: 'https://stage.example.com' },
        e2e: { dir: 'e2e', framework: 'playwright', junit: 'results/junit.xml' },
      },
    );
    expect(prompt).toContain('real playwright tests into e2e/');
    expect(prompt).toContain('[<caseId>]');
    expect(prompt).toContain('"// Given"');
    expect(prompt).toContain('e2e/results/junit.xml');
    expect(prompt).toContain('https://stage.example.com');
    expect(prompt).toContain('@smoke');
    expect(prompt).toContain('<groupId>.spec.ts');
    expect(prompt).toContain('write it in the language of the case texts');
    // F-358: без готовой команды путь отчёта называется абсолютным И дан
    // абсолютным — относительный Playwright разрешает от каталога конфига.
    expect(prompt).toContain('writing /p/e2e/results/junit.xml (an absolute path)');
    const plain = buildPrompt([], { projectPath: '/p', mode: 'generate' }, { shared: [] });
    expect(plain).not.toContain('E2E TESTS');
  });

  it('задание для pytest: файл test_<группа>.py, id и имя кейса — в docstring, «# Given»', () => {
    const prompt = buildPrompt(
      [],
      { projectPath: '/p', mode: 'generate', e2e: true },
      { shared: [], e2e: { dir: 'tests/e2e', framework: 'pytest', junit: 'results/junit.xml' } },
    );
    expect(prompt).toContain('tests/e2e/test_<groupId>.py');
    expect(prompt).toContain('"""[<caseId>] <what it proves>"""');
    expect(prompt).toContain('"# Given"');
    expect(prompt).toContain('@pytest.mark.smoke');
    expect(prompt).not.toContain('.spec.ts');
  });

  it('строка чата: одна строка, папка, команды сверки и прогона, вопрос без адреса стенда', () => {
    const line = e2eChatLine({
      root: '/work/app',
      folder: {
        state: 'created',
        dir: 'e2e',
        framework: 'playwright',
        specs: 2,
        excluded: true,
        git: true,
      },
      cliPath: '/panel/tools/tests-cli.mjs',
      hasStandUrl: true,
    });
    expect(line).not.toContain('\n');
    expect(line).toContain('e2e folder "e2e" (playwright, 2 spec files, created by the panel');
    expect(line).toContain('node "/panel/tools/tests-cli.mjs" sync --project "/work/app"');
    expect(line).not.toContain('the stand URL');
    const missing = e2eChatLine({
      root: '/work/app',
      folder: { state: 'missing', framework: 'unknown', specs: 0, excluded: false, git: false },
      cliPath: '/cli.mjs',
      hasStandUrl: false,
    });
    expect(missing).toContain('no e2e folder yet');
    expect(missing).toContain('the stand URL');
    // Без папки агент её не заводит молча, а спрашивает в том же вопросе.
    expect(missing).toContain('do not create one on your own');
    expect(missing).toMatch(/Ask the user once[^.]*whether tests belong in this Tests section/);
    expect(line).not.toContain('whether tests belong');
    // Нет прав на команды — честное «не могу» и команда человеку.
    expect(line).toContain('hand the user the exact command');
  });
});
