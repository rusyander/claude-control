import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { panelHomeDir } from '../../lib/brand.mjs';
import { readGroups } from '../../domains/project-tests/store/store.ts';
import { createE2eFolder } from '../../domains/project-tests/e2e-folder/e2e-folder.ts';
import { E2eRunRegistry } from '../../domains/project-tests/e2e-run/e2e-run.ts';
import { ProjectTestRunRegistry } from '../../domains/project-tests/runs/runs.ts';
import {
  installFakeRunners,
  markRunnerInstalled,
} from '../../domains/project-tests/__fixtures__/fake-runners.ts';
import {
  projectTestsBusy,
  testsChatFinished,
  testsChatNote,
  testsCliPath,
  wireTestsChatNote,
} from './tests-chat-wiring.ts';

/**
 * Что агент чата узнаёт о тестах проекта. Старт чата папку не заводит никому
 * (решение владельца: добавление, кнопка, первая генерация e2e) — на диск не
 * пишется ничего; свои чаты панели строки не получают вовсе.
 */
function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Остаётся в temp.
  }
}

describe('bootstrap/tests-chat-wiring', () => {
  let root = '';
  let appData = '';

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-chat-e2e-')));
    appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-chat-e2e-data-')));
    spawnSync('git', ['init', '-q'], { cwd: root });
  });

  afterEach(() => {
    dropTemp(root);
    dropTemp(appData);
  });

  /**
   * Аудит: старт чата заводил e2e/ в любом проекте реестра без папки — против
   * решения владельца (только добавление, кнопка, первая генерация e2e).
   */
  it('старт чата папку не заводит: без неё — подсказка, на диске ничего', () => {
    const note = testsChatNote({ appData, chatRuns: {} as never }, root);
    expect(existsSync(join(root, 'e2e'))).toBe(false);
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).not.toContain('agentdeck');
    expect(note).toContain('no e2e folder yet');
  });

  it('папка, заведённая панелью, названа в строке вместе с командами', () => {
    createE2eFolder(appData, root, '2026-09-26T10:00:00.000Z');
    const note = testsChatNote({ appData, chatRuns: {} as never }, root);
    expect(note).toContain('e2e folder "e2e"');
    expect(note).toContain('created by the panel and hidden from git');
    expect(note).toContain(`node "${testsCliPath()}" sync --project "${root}"`);
    expect(existsSync(testsCliPath())).toBe(true);
  });

  /**
   * Догфуд: у проекта со своими скриптами строка советовала завести e2e/ с
   * Playwright — агент писал проекту чужой каркас вместо его проверок.
   */
  it('своя команда проекта без папки с тестами: строка называет её и привязку, без Playwright', () => {
    mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
    const command = 'node tools/qa/junit-run.mjs {files}';
    writeFileSync(
      join(root, '.agent', 'tests', 'automation.json'),
      JSON.stringify({ version: 1, command }),
    );
    const note = testsChatNote({ appData, chatRuns: {} as never }, root) ?? '';
    expect(note).toContain(`"${command}"`);
    expect(note).toContain('"automation": {"status": "automated", "file"');
    expect(note).toContain(`node "${testsCliPath()}" run --project "${root}" [--group <group>]`);
    expect(note).not.toMatch(/create "e2e\/"|Playwright config/);
    expect(note).not.toMatch(/[\r\n]/);

    // Пустая заготовка панели не перебивает свою команду; папка с тестами — перебивает.
    createE2eFolder(appData, root, '2026-09-26T10:00:00.000Z');
    expect(testsChatNote({ appData, chatRuns: {} as never }, root)).toContain(`"${command}"`);
    writeFileSync(join(root, 'e2e', 'auth.spec.ts'), "test('[auth-001] вход', () => {});\n");
    const folderNote = testsChatNote({ appData, chatRuns: {} as never }, root) ?? '';
    expect(folderNote).toContain('e2e folder "e2e"');
    expect(folderNote).not.toContain(command);
  });

  it('чаты самой панели и несуществующий каталог строки не получают', () => {
    const deps = { appData, chatRuns: {} as never };
    expect(testsChatNote(deps, join(panelHomeDir(), 'sandbox'))).toBeUndefined();
    expect(testsChatNote(deps, join(root, 'nope'))).toBeUndefined();
  });

  it('существующий каталог внутри дома панели строки не получает и ничего не заводит', () => {
    // Дом панели подменён на временный: настоящий ~/.agentdeck тест не трогает.
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-chat-e2e-home-')));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const inside = join(panelHomeDir(), 'sandboxes', 'box');
      expect(inside.startsWith(home)).toBe(true);
      mkdirSync(inside, { recursive: true });
      const deps = { appData, chatRuns: {} as never };
      expect(testsChatNote(deps, inside)).toBeUndefined();
      expect(existsSync(join(inside, 'e2e'))).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      dropTemp(home);
    }
  });

  it('подключается к реестру чатов одним слушателем по каталогу', () => {
    let resolve: ((cwd: string) => string | undefined) | undefined;
    wireTestsChatNote({
      appData,
      chatRuns: { setWorkspaceNote: (fn) => (resolve = fn) },
    });
    expect(resolve?.(root)).toContain('QA workspace of this project');
  });

  it('чужие CLI получают тот же решатель; конец хода отдаётся наружу', () => {
    let claude: ((cwd: string) => string | undefined) | undefined;
    let foreign: ((cwd: string) => string | undefined) | undefined;
    const wired = wireTestsChatNote({
      appData,
      chatRuns: { setWorkspaceNote: (fn) => (claude = fn) },
      providerChats: { setWorkspaceNote: (fn) => (foreign = fn) },
    });
    expect(foreign?.(root)).toBe(claude?.(root));
    expect(foreign?.(root)).toContain('QA workspace of this project');
    // Папки нет — сверять нечего, и конец хода ничего не пишет.
    expect(wired.finished(root, Date.now() - 60_000)).toBeUndefined();
  });

  it('конец хода: агент написал тест — кейс заведён; идёт прогон — сверка ждёт', () => {
    const deps = { appData, chatRuns: {} as never };
    createE2eFolder(appData, root, '2026-09-26T10:00:00.000Z');
    const startedAt = Date.now();
    writeFileSync(
      join(root, 'e2e', 'cart.spec.ts'),
      "import { test } from '@playwright/test';\ntest('[cart-001] в корзину', async () => {});\n",
    );
    expect(testsChatFinished({ ...deps, isBusy: () => true }, root, startedAt)).toBeUndefined();
    expect(readGroups(root)).toEqual([]);

    expect(testsChatFinished(deps, root, startedAt)).toMatchObject({ added: 1, groups: ['cart'] });
    expect(readGroups(root)[0]?.cases[0]?.id).toBe('cart-001');
    expect(testsChatFinished(deps, undefined, startedAt)).toBeUndefined();
  });

  // Ревью 28.09 (F-143): сбой до сверки (`isBusy`, поиск проекта) вылетал из
  // планировщика конца хода — доставка итога и надзор повторов пропускались.
  it('сбой проверки занятости не вылетает из конца хода', () => {
    const logged: string[] = [];
    const deps = {
      appData,
      chatRuns: {} as never,
      isBusy: () => {
        throw new Error('boom');
      },
      log: (message: string) => logged.push(message),
    };
    createE2eFolder(appData, root, '2026-09-26T10:00:00.000Z');
    expect(() => testsChatFinished(deps, root, Date.now())).not.toThrow();
    expect(logged).toHaveLength(1);
  });

  /**
   * Конец хода чата сверял папку посреди автотестов: занятость смотрела только
   * прогон агента, а путь сравнивался точно — cwd чата бывает написан иначе.
   */
  it('конец хода ждёт идущие автотесты — и по другому написанию пути', async () => {
    const fake = installFakeRunners();
    const savedMode = process.env.FAKE_E2E_MODE;
    process.env.FAKE_E2E_MODE = 'hang';
    const e2eRuns = new E2eRunRegistry();
    try {
      createE2eFolder(appData, root, '2026-09-26T10:00:00.000Z');
      markRunnerInstalled(join(root, 'e2e'), 'playwright');
      writeFileSync(
        join(root, 'e2e', 'seed.spec.ts'),
        "import { test } from '@playwright/test';\ntest('[seed-001] есть', async () => {});\n",
      );
      e2eRuns.start({ root, appData });
      const startedAt = Date.now() - 1000;
      writeFileSync(
        join(root, 'e2e', 'cart.spec.ts'),
        "import { test } from '@playwright/test';\ntest('[cart-001] в корзину', async () => {});\n",
      );
      const deps = {
        appData,
        chatRuns: {} as never,
        isBusy: projectTestsBusy(new ProjectTestRunRegistry(), e2eRuns),
      };
      expect(testsChatFinished(deps, root.replace(/\\/g, '/'), startedAt)).toBeUndefined();
      expect(testsChatFinished(deps, root, startedAt)).toBeUndefined();
      expect(readGroups(root)).toEqual([]);
    } finally {
      e2eRuns.stopAll();
      await vi.waitFor(() => expect(e2eRuns.get(root)?.finishedAt).toBeDefined(), {
        timeout: 20_000,
      });
      if (savedMode === undefined) delete process.env.FAKE_E2E_MODE;
      else process.env.FAKE_E2E_MODE = savedMode;
      fake.restore();
      dropTemp(fake.bin);
    }
  });

  it('копия ветки со ссылкой на папку оригинала говорит и сверяет от имени оригинала', () => {
    const deps = { appData, chatRuns: {} as never };
    createE2eFolder(appData, root, '2026-09-26T10:00:00.000Z');
    const copy = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-chat-e2e-copy-')));
    try {
      symlinkSync(
        join(root, 'e2e'),
        join(copy, 'e2e'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const note = testsChatNote(deps, copy);
      expect(note).toContain(`--project "${root}"`);
      expect(note).not.toContain(copy);
      const startedAt = Date.now();
      writeFileSync(
        join(copy, 'e2e', 'pay.spec.ts'),
        "import { test } from '@playwright/test';\ntest('оплата', async () => {});\n",
      );
      expect(testsChatFinished(deps, copy, startedAt)).toMatchObject({ added: 1 });
      // Кейс — у оригинала; в копии каталога тестов не появилось.
      expect(readGroups(root).map((group) => group.id)).toEqual(['pay']);
      expect(existsSync(join(copy, '.claude'))).toBe(false);
    } finally {
      // Снимается сама ссылка: рекурсивное удаление вычистило бы папку оригинала.
      if (process.platform === 'win32') rmdirSync(join(copy, 'e2e'));
      else unlinkSync(join(copy, 'e2e'));
      dropTemp(copy);
    }
  });

  /**
   * Своя команда проекта гоняет КОД каталога: в копии ветки с пустой связанной
   * заготовкой строка называла `run --project "<оригинал>"`, и тесты шли по
   * оригиналу, а не по правкам копии.
   */
  it('копия ветки со своей командой проекта: команда и строка — от имени копии', () => {
    const deps = { appData, chatRuns: {} as never };
    createE2eFolder(appData, root, '2026-09-26T10:00:00.000Z');
    const automation = JSON.stringify({ command: 'npm test -- {files}' });
    const copy = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-chat-e2e-copy-')));
    try {
      for (const dir of [root, copy]) {
        mkdirSync(join(dir, '.agent', 'tests'), { recursive: true });
        writeFileSync(join(dir, '.agent', 'tests', 'automation.json'), automation);
      }
      symlinkSync(
        join(root, 'e2e'),
        join(copy, 'e2e'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const note = testsChatNote(deps, copy);
      expect(note).toContain('"npm test -- {files}"');
      expect(note).toContain(`run --project "${copy}"`);
      expect(note).not.toContain(`--project "${root}"`);
    } finally {
      if (process.platform === 'win32') rmdirSync(join(copy, 'e2e'));
      else unlinkSync(join(copy, 'e2e'));
      dropTemp(copy);
    }
  });
});
