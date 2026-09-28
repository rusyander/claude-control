import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatRun, type ChatEvent } from '../chat/ChatRunner.ts';
import { draftFile } from './drafts.ts';
import { chooseE2eFolder, e2eFolderView } from './e2e-folder.ts';
import { ProjectTestRunRegistry } from './runs.ts';
import { readGroups } from './store.ts';
import { readRuns } from './runs-store.ts';

/**
 * Генерация с кодом тестов доводится до конца сама: черновик применяется без
 * галочки, тесты папки сводятся с кейсами, отчёт junit ставит статусы.
 *
 * Подменён только процесс CLI (`ChatRun.start`) — граница, за которой модель.
 * Всё, что после неё (черновик, сверка, разбор junit, запись групп), работает
 * по-настоящему на временном каталоге. Агент «пишет» ровно то, что велит ему
 * задание: черновик, спеку с меткой `[id]` и отчёт.
 */
const SPEC = `import { test } from '@playwright/test';
test.describe('Вход', () => {
  test('[auth-001] вход по паролю @smoke', async () => {
    // Given пользователь зарегистрирован
    // When вводит логин и пароль
    // Then видит профиль
  });
  test('[auth-002] неверный пароль @regression', async () => {
    // When вводит неверный пароль
    // Then видит ошибку
  });
});
`;

const JUNIT =
  '<testsuites><testsuite name="auth.spec.ts">' +
  '<testcase name="Вход › [auth-001] вход по паролю @smoke" classname="auth.spec.ts" time="1.2"/>' +
  '<testcase name="Вход › [auth-002] неверный пароль @regression" classname="auth.spec.ts" time="0.4">' +
  '<failure message="нет сообщения об ошибке"/></testcase>' +
  '</testsuite></testsuites>';

/** Путь отчёта, который команда из задания отдаёт раннеру. */
function reportOf(prompt: string): string {
  return join(/PLAYWRIGHT_JUNIT_OUTPUT_FILE="([^"]+)"/.exec(prompt)?.[1] ?? '');
}

describe('project-tests/runs: генерация с e2e', () => {
  let root = '';
  const registry = new ProjectTestRunRegistry();

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-tests-e2e-run-')));
    mkdirSync(join(root, 'e2e'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('черновик применён, спеки сведены, результаты junit легли на кейсы', async () => {
    let runId = '';
    let prompt = '';
    vi.spyOn(ChatRun.prototype, 'start').mockImplementation(async (options, onEvent) => {
      prompt = options.prompt;
      const file = join(root, draftFile(runId));
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          runId,
          source: 'code',
          createdAt: '2026-09-26T10:00:00.000Z',
          items: [
            {
              op: 'add',
              groupId: 'auth',
              caseId: 'auth-001',
              testCase: { id: 'auth-001', title: 'Вход по паролю', steps: ['ввести пароль'] },
              reason: 'критичный путь',
            },
          ],
        }),
      );
      writeFileSync(join(root, 'e2e', 'auth.spec.ts'), SPEC);
      mkdirSync(join(root, 'e2e', 'results'));
      // Отчёт пишет раннер туда, куда его направила команда из задания.
      writeFileSync(reportOf(prompt), JUNIT);
      (onEvent as (event: ChatEvent) => void)({ kind: 'done', sessionId: 's1' } as ChatEvent);
    });
    // Конфиг Playwright в папке — как у заготовки панели: по нему узнаётся каркас.
    writeFileSync(join(root, 'e2e', 'playwright.config.ts'), 'export default {};\n');

    const view = registry.start(
      { projectPath: root, mode: 'generate', e2e: true, autoAccept: false },
      new Date().toISOString(),
    );
    runId = view.id;
    await vi.waitFor(() => expect(registry.get(root)?.status).toBe('done'));

    expect(prompt).toContain('E2E TESTS');
    // Команда — та же, что у кнопки панели, с АБСОЛЮТНЫМ путём отчёта: путь от
    // корня Playwright разрешал от каталога конфига и писал в e2e/e2e/results.
    // Имя отчёта — своё у прогона (F-316): папку e2e копии делят с оригиналом.
    const posixRoot = root.split('\\').join('/');
    expect(prompt).toContain(
      `cd "${posixRoot}/e2e" && PLAYWRIGHT_JUNIT_OUTPUT_FILE="${posixRoot}/e2e/results/junit-${runId}.xml"`,
    );
    expect(prompt).toContain('npx --no-install playwright test --reporter=list,junit');
    expect(prompt).not.toContain('PLAYWRIGHT_JUNIT_OUTPUT_NAME=e2e/');
    const run = registry.get(root);
    // Галочка «принимать сразу» снята, а черновик применён: так решил владелец.
    expect(run?.draft).toMatchObject({ accepted: 1, auto: true });
    expect(run?.log).toContain('сверка папки e2e');
    expect(run?.log).toContain('легло на кейсы 2');
    // Отчёт со своим именем убран после разбора — иначе копились бы по одному на прогон.
    expect(existsSync(reportOf(prompt))).toBe(false);

    const auth = readGroups(root).find((group) => group.id === 'auth');
    const byId = new Map(auth?.cases.map((item) => [item.id, item]));
    // Кейс из черновика не задвоился: сверка нашла его по метке и привязала к коду.
    expect(auth?.cases.map((item) => item.id).sort()).toEqual(['auth-001', 'auth-002']);
    expect(byId.get('auth-001')).toMatchObject({
      title: 'Вход по паролю',
      status: 'passed',
      automation: { file: 'e2e/auth.spec.ts', externalId: 'auth-001' },
    });
    expect(byId.get('auth-002')).toMatchObject({ status: 'failed' });
    // Одна строка истории — сама генерация, и результаты отчёта в ней, а не в «импорте».
    const history = readRuns(root);
    expect(history.map((item) => item.mode)).toEqual(['generate']);
    expect(history[0]?.summary).toMatchObject({ passed: 1, failed: 1 });
    expect(byId.get('auth-001')?.lastRunId).toBe(runId);
  });

  /**
   * Монорепозиторий: папок e2e две, человек выбрал вторую. Карточка, заметка
   * чата и кнопка прогона берут выбранную, а генерация брала первую найденную
   * — спеки ложились не туда, куда показано.
   */
  it('генерация пишет спеки в папку, выбранную человеком', async () => {
    const appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-tests-e2e-pick-')));
    try {
      rmSync(join(root, 'e2e'), { recursive: true, force: true });
      for (const app of ['admin', 'shop']) {
        mkdirSync(join(root, 'apps', app, 'tests'), { recursive: true });
        writeFileSync(
          join(root, 'apps', app, 'playwright.config.ts'),
          "export default { testDir: './tests' };\n",
        );
        writeFileSync(join(root, 'apps', app, 'tests', 'a.spec.ts'), '');
      }
      expect(e2eFolderView(root, appData).dir).toBe('apps/admin/tests');
      chooseE2eFolder(appData, root, 'apps/shop/tests');
      let prompt = '';
      vi.spyOn(ChatRun.prototype, 'start').mockImplementation(async (options, onEvent) => {
        prompt = options.prompt;
        (onEvent as (event: ChatEvent) => void)({ kind: 'done', sessionId: 's1' } as ChatEvent);
      });

      registry.start(
        { projectPath: root, mode: 'generate', e2e: true },
        new Date().toISOString(),
        undefined,
        undefined,
        { appData },
      );
      await vi.waitFor(() => expect(registry.get(root)?.status).toBe('done'));

      expect(prompt).toContain('apps/shop/tests');
      expect(prompt).not.toContain('apps/admin/tests');
    } finally {
      rmSync(appData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  /**
   * F-316: копии проекта делят папку e2e оригинала ссылкой. Две генерации в
   * двух копиях сразу писали один `results/junit.xml`, и каждая ставила кейсам
   * результаты соседа. Отчёт соседа, свежий и по тем же тестам, этому прогону
   * не засчитывается.
   */
  it('свежий отчёт соседней копии в общей папке не выдаётся за результаты этого', async () => {
    let prompt = '';
    vi.spyOn(ChatRun.prototype, 'start').mockImplementation(async (options, onEvent) => {
      prompt = options.prompt;
      writeFileSync(join(root, 'e2e', 'auth.spec.ts'), SPEC);
      mkdirSync(join(root, 'e2e', 'results'));
      // Соседняя копия прогнала те же тесты и записала общий отчёт.
      writeFileSync(join(root, 'e2e', 'results', 'junit.xml'), JUNIT);
      (onEvent as (event: ChatEvent) => void)({ kind: 'done', sessionId: 's1' } as ChatEvent);
    });
    writeFileSync(join(root, 'e2e', 'playwright.config.ts'), 'export default {};\n');

    registry.start({ projectPath: root, mode: 'generate', e2e: true }, new Date().toISOString());
    await vi.waitFor(() => expect(registry.get(root)?.status).toBe('done'));

    expect(reportOf(prompt)).not.toBe(join(root, 'e2e', 'results', 'junit.xml'));
    expect(registry.get(root)?.log).toContain('нет — результаты не проставлены');
    const auth = readGroups(root).find((group) => group.id === 'auth');
    expect(auth?.cases.every((item) => item.status === 'unknown')).toBe(true);
  });

  it('отчёт от прошлого запуска не выдаётся за результаты этого', async () => {
    mkdirSync(join(root, 'e2e', 'results'));
    writeFileSync(join(root, 'e2e', 'results', 'junit.xml'), JUNIT);
    const old = new Date('2026-01-01T00:00:00.000Z');
    const { utimesSync } = await import('node:fs');
    utimesSync(join(root, 'e2e', 'results', 'junit.xml'), old, old);
    vi.spyOn(ChatRun.prototype, 'start').mockImplementation(async (_options, onEvent) => {
      writeFileSync(join(root, 'e2e', 'auth.spec.ts'), SPEC);
      (onEvent as (event: ChatEvent) => void)({ kind: 'done', sessionId: 's1' } as ChatEvent);
    });

    registry.start({ projectPath: root, mode: 'generate', e2e: true }, new Date().toISOString());
    await vi.waitFor(() => expect(registry.get(root)?.status).toBe('done'));

    expect(registry.get(root)?.log).toContain('свежего отчёта e2e/results/junit-');
    const auth = readGroups(root).find((group) => group.id === 'auth');
    expect(auth?.cases.every((item) => item.status === 'unknown')).toBe(true);
  });
});
