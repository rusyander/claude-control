import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestsView } from '@agentdeck/contracts';
import type { ServerContext } from '../../context.ts';
import {
  ProjectTestManualRegistry,
  ProjectTestRunRegistry,
} from '../../domains/project-tests/project-tests.ts';
import { registerProjectTestsRoutes } from './project-tests-routes.ts';
import { QwenTestsRun } from '../../domains/project-tests/agent/qwen-run.ts';
import { createGroup, upsertCase } from '../../domains/project-tests/store/store.ts';

/**
 * Поиск CLI в PATH — подменён только для Qwen и Codex: ответ «есть ли CLI на
 * этой машине» не должен решать исход теста. Прочие имена ищутся по-настоящему.
 */
const detected = vi.hoisted(() => ({ found: new Set<string>() }));
vi.mock('../../providers/detect/detect.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../providers/detect/detect.ts')>();
  return {
    ...actual,
    detectCliOnPath: (command: string) =>
      /^(qwen|codex)(\.cmd|\.exe)?$/i.test(command)
        ? detected.found.has(command)
        : actual.detectCliOnPath(command),
  };
});

/**
 * Маршруты тест-кейсов. Прогон агента здесь не запускается: он спавнит
 * настоящий CLI, и проверять им нечего — важно другое. Чужой каталог не
 * читается, сломанная группа не роняет ответ, а правка кейса возвращает уже
 * пересобранный список, чтобы клиенту не приходилось делать второй запрос.
 */
describe('project-tests-routes', () => {
  let app: FastifyInstance;
  let project = '';
  let backupDir = '';
  let runs: ProjectTestRunRegistry;
  /** Активный провайдер панели; не задан — Claude по умолчанию. */
  let activeProvider: string | undefined;

  const view = async (path = project): Promise<ProjectTestsView> => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/project-tests?path=${encodeURIComponent(path)}`,
    });
    return response.json() as ProjectTestsView;
  };

  let ceilingBefore: string | undefined;

  beforeEach(async () => {
    // Проект теста — «вне репозитория»: git не поднимается выше temp. Без этого
    // temp внутри чужого репозитория делал дифф сравнимым, и маршрут запускал
    // настоящую генерацию — живой claude на машине прогона.
    ceilingBefore = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = realpathSync.native(tmpdir());
    project = mkdtempSync(join(tmpdir(), 'cc-tests-routes-'));
    activeProvider = undefined;
    backupDir = mkdtempSync(join(tmpdir(), 'cc-tests-backups-'));
    app = Fastify();
    runs = new ProjectTestRunRegistry();
    registerProjectTestsRoutes(
      app,
      // Реестр проектов пуст: имя копии соглашения строится из пути каталога.
      {
        backupDir,
        store: {
          getProjectByPath: () => undefined,
          isTestsAutoAccept: () => false,
          // Настройки спрашивают источники генерации: без них не ответить, что
          // Jira не подключена, — а это отказ прогона, а не поломка панели.
          getSettings: () => ({
            integrations: { jira: { enabled: false }, confluence: { enabled: false } },
            provider: activeProvider,
          }),
        },
        // Каталог данных панели нужен источникам генерации: в нём лежит токен
        // трекера, и без него «покрыть требование» не собралось бы.
        location: { paths: { appData: backupDir } },
      } as unknown as ServerContext,
      runs,
      new ProjectTestManualRegistry(),
    );
    await app.ready();
  });

  afterEach(async () => {
    if (ceilingBefore === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = ceilingBefore;
    await app.close();
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(backupDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('пустой проект отдаёт пустой список, а не ошибку', async () => {
    const body = await view();

    expect(body.dir).toBe('.agent/tests');
    expect(body.groups).toEqual([]);
    expect(body.run).toBeUndefined();
  });

  it('несуществующий каталог отклоняется', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/project-tests?path=${encodeURIComponent(join(project, 'нет-такого'))}`,
    });

    expect(response.statusCode).toBe(400);
  });

  it('заводит группу, добавляет кейс и возвращает список одним ответом', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/project-tests/group',
      payload: { path: project, id: 'gui', title: 'GUI' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/case',
      payload: {
        path: project,
        groupId: 'gui',
        testCase: { title: 'Отправить сообщение', steps: ['открыть чат', 'нажать «Отправить»'] },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ProjectTestsView;
    expect(body.groups[0]?.cases[0]).toMatchObject({
      title: 'Отправить сообщение',
      source: 'human',
      status: 'unknown',
    });
  });

  it('кейс без названия не создаётся', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/project-tests/group',
      payload: { path: project, id: 'gui' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/case',
      payload: { path: project, groupId: 'gui', testCase: { title: '   ', steps: [] } },
    });

    expect(response.statusCode).toBe(400);
  });

  it('сломанный файл группы приходит ошибкой ВНУТРИ группы, ответ остаётся рабочим', async () => {
    mkdirSync(join(project, '.agent', 'tests'), { recursive: true });
    writeFileSync(join(project, '.agent', 'tests', 'gui.tests.json'), '{ сломано');

    const body = await view();

    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]?.error).toBeTruthy();
  });

  // Выбор провайдера один на всю панель: прогон агента тестов через Claude при
  // выбранном другом CLI — это «молча через Claude», запрещённое владельцем
  // (07.10). Qwen Code и Codex идут сами, с проверкой прав; прочие — отказ.
  describe('агент на чужом CLI', () => {
    const withCase = async (): Promise<void> => {
      createGroup(project, 'gui');
      upsertCase(project, 'gui', { title: 'Вход', steps: ['x'] }, '2026-10-06T00:00:00.000Z');
    };
    const start = () =>
      app.inject({
        method: 'POST',
        url: '/api/project-tests/run',
        payload: { path: project, mode: 'run', groupId: 'gui' },
      });

    afterEach(() => {
      runs.stop(project);
      detected.found.clear();
      vi.restoreAllMocks();
    });

    it('Qwen Code в PATH — прогон начат его запуском, вид знает CLI', async () => {
      activeProvider = 'qwen';
      detected.found.add(process.platform === 'win32' ? 'qwen.cmd' : 'qwen');
      const qwen = vi
        .spyOn(QwenTestsRun.prototype, 'start')
        .mockImplementation(() => new Promise(() => {}));
      await withCase();

      const response = await start();

      expect(response.statusCode).toBe(200);
      await vi.waitFor(() => expect(qwen).toHaveBeenCalledTimes(1));
      expect((await view()).run).toMatchObject({ status: 'running', provider: 'qwen' });
    });

    it('CLI нет в PATH — 409 cli-not-found, прогон не начат', async () => {
      activeProvider = 'codex';
      await withCase();

      const response = await start();

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: 'cli_not_found',
        messageCode: 'tests-agent-cli-not-found',
        params: { provider: 'Codex (OpenAI)' },
      });
      expect((await view()).run).toBeUndefined();
    });

    it('агент тестов идёт через контур — 409 contour-foreign, прогон не начат', async () => {
      activeProvider = 'codex';
      detected.found.add(process.platform === 'win32' ? 'codex.cmd' : 'codex');
      runs.setPlatformRouting(() => ({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' } }));
      await withCase();

      const response = await start();

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: 'contour_foreign',
        messageCode: 'tests-agent-contour-foreign',
        params: { provider: 'Codex (OpenAI)' },
      });
      expect((await view()).run).toBeUndefined();
    });

    it('CLI без проверяемого запуска (Gemini) — 409 unsupported с именем CLI', async () => {
      activeProvider = 'gemini';
      await withCase();

      const response = await start();

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: 'provider_unsupported',
        messageCode: 'tests-agent-provider-unsupported',
        params: { provider: 'Gemini CLI' },
      });
      expect((await view()).run).toBeUndefined();
    });
  });

  it('прогон по проекту без кейсов не запускается', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/run',
      payload: { path: project, mode: 'run' },
    });

    expect(response.statusCode).toBe(400);
  });

  /**
   * Два режима, до которых у человека не было кнопки. Проверяются их отказы:
   * запуск с настоящим агентом здесь не делается — он спавнит CLI.
   */
  it('исследование без хартии не запускается: сессия без неё — блуждание', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/run',
      payload: { path: project, mode: 'explore' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('хартии');
    expect((await view()).run).toBeUndefined();
  });

  it('автоматизация набора, который весь в коде, отказывается с причиной', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/project-tests/group',
      payload: { path: project, id: 'gui', title: 'GUI' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/project-tests/case',
      payload: {
        path: project,
        groupId: 'gui',
        testCase: {
          title: 'Отправить сообщение',
          steps: ['нажать «Отправить»'],
          automation: { status: 'automated', file: 'e2e/send.spec.ts', testName: '[gui-001] send' },
        },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/run',
      payload: { path: project, mode: 'automate' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('automated');
  });

  /**
   * Источник генерации собирается ДО старта, и отказ обязан быть внятным: не
   * собрался — агент не запускается вовсе, а человек читает причину. Здесь это
   * проверяется на маршруте, потому что 500 вместо строки означал бы «панель
   * сломалась», хотя сломано ровно ничего.
   */
  it('«покрыть требование» без подключённой Jira отвечает причиной, а не 500', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/run',
      payload: { path: project, mode: 'generate', source: 'requirement', sourceRef: 'QA-42' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('Jira');
    // Прогон не начался: источник не собрался — начинать нечего.
    expect((await view()).run).toBeUndefined();
  });

  it('генерация по диффу вне репозитория называет диапазон, который не сравнился', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/run',
      payload: { path: project, mode: 'generate', source: 'diff' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('origin/main..HEAD');
  });

  const installConventionHere = async (): Promise<ProjectTestsView> =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/project-tests/convention',
        payload: { path: project },
      })
    ).json() as ProjectTestsView;

  it('соглашение вписывается в CLAUDE.md проекта один раз и видно в ответе', async () => {
    writeFileSync(join(project, 'CLAUDE.md'), '# Правила проекта\n', 'utf8');
    expect((await view()).hasConvention).toBe(false);

    expect((await installConventionHere()).hasConvention).toBe(true);

    const written = readFileSync(join(project, 'CLAUDE.md'), 'utf8');
    // Повтор ничего не добавляет: кнопку можно нажать дважды без последствий.
    await installConventionHere();
    expect(readFileSync(join(project, 'CLAUDE.md'), 'utf8')).toBe(written);
  });

  /**
   * Проект, живущий на `AGENTS.md` (П2.7). Имя файла инструкций — решение
   * человека: заведи панель рядом свой `CLAUDE.md`, и CLI начал бы читать его
   * ВМЕСТО прежнего файла — одно присутствие `CLAUDE.md` гасит `AGENTS.md`
   * молча, вместе со всеми правилами проекта.
   */
  it('в проекте на AGENTS.md пишет туда же и не заводит CLAUDE.md', async () => {
    writeFileSync(join(project, 'AGENTS.md'), '# Правила проекта\n', 'utf8');

    expect((await installConventionHere()).hasConvention).toBe(true);

    expect(readdirSync(project)).not.toContain('CLAUDE.md');
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toContain('# Правила проекта');
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8').length).toBeGreaterThan(
      '# Правила проекта\n'.length,
    );
  });

  it('соглашение дописывается в существующий CLAUDE.md с резервной копией, как PUT /rules', async () => {
    writeFileSync(join(project, 'CLAUDE.md'), '# Проект\n', 'utf8');
    expect(readdirSync(backupDir)).toHaveLength(0);

    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/convention',
      payload: { path: project },
    });
    expect(response.statusCode).toBe(200);

    const backups = readdirSync(backupDir);
    expect(backups).toHaveLength(1);
    // Имя ПРОЕКТНОЙ копии (`project-<ключ>-CLAUDE.md`), не пользовательской:
    // иначе она попадала бы в ленту истории и восстановление ~/.claude/CLAUDE.md.
    expect(backups[0]).toMatch(/^project-[0-9a-f]{12}-CLAUDE\.md\./);
    expect(readFileSync(join(backupDir, backups[0]!), 'utf8')).toBe('# Проект\n');
  });

  it('удаление несуществующей группы → 404, а не молчаливое ок', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/project-tests/group?path=${encodeURIComponent(project)}&id=nope`,
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { message: string }).message).toContain('nope');
  });

  it('чужой текст CLAUDE.md остаётся на месте', async () => {
    writeFileSync(
      join(project, 'CLAUDE.md'),
      ['# Мой проект', '', 'Что-то важное.', ''].join('\n'),
    );

    await app.inject({
      method: 'POST',
      url: '/api/project-tests/convention',
      payload: { path: project },
    });

    const written = readFileSync(join(project, 'CLAUDE.md'), 'utf8');
    expect(written.startsWith('# Мой проект')).toBe(true);
    expect(written).toContain('Что-то важное.');
    expect(written).toContain('.agent/tests/');
  });

  it('удаление кейса и группы отражается в ответе', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/project-tests/group',
      payload: { path: project, id: 'gui' },
    });
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/project-tests/case',
        payload: { path: project, groupId: 'gui', testCase: { title: 'Тест', steps: [] } },
      })
    ).json() as ProjectTestsView;
    const caseId = created.groups[0]?.cases[0]?.id ?? '';

    const afterCase = (
      await app.inject({
        method: 'DELETE',
        url: `/api/project-tests/case?path=${encodeURIComponent(project)}&groupId=gui&caseId=${caseId}`,
      })
    ).json() as ProjectTestsView;
    expect(afterCase.groups[0]?.cases).toEqual([]);

    const afterGroup = (
      await app.inject({
        method: 'DELETE',
        url: `/api/project-tests/group?path=${encodeURIComponent(project)}&id=gui`,
      })
    ).json() as ProjectTestsView;
    expect(afterGroup.groups).toEqual([]);
  });

  /**
   * Занятая прогоном группа. Настоящий прогон здесь не поднять — он спавнит CLI,
   * — поэтому реестру подменяется ровно один ответ: «эту группу держит вот этот
   * прогон». Проверяется то, что видит клиент: код 409 и id прогона, по которому
   * его видно в панели и можно остановить.
   */
  describe('группа занята прогоном', () => {
    const hold = (runId: string, groupId?: string): void => {
      runs.holds = (_path: string, asked?: string): string | undefined =>
        !groupId || !asked || asked === groupId ? runId : undefined;
    };

    const create = async (id: string): Promise<void> => {
      await app.inject({
        method: 'POST',
        url: '/api/project-tests/group',
        payload: { path: project, id },
      });
    };

    it('правка кейса во время прогона отклоняется с именем прогона', async () => {
      await create('gui');
      hold('run-42', 'gui');

      const response = await app.inject({
        method: 'POST',
        url: '/api/project-tests/case',
        payload: { path: project, groupId: 'gui', testCase: { title: 'Новый', steps: [] } },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ runId: 'run-42' });
      expect((response.json() as { message: string }).message).toContain('run-42');
      // Файл не тронут: отказ должен быть отказом, а не половиной записи.
      expect((await view()).groups[0]?.cases).toEqual([]);
    });

    it('прогон по соседней группе своей вкладке не мешает', async () => {
      await create('gui');
      await create('e2e');
      hold('run-42', 'e2e');

      const response = await app.inject({
        method: 'POST',
        url: '/api/project-tests/case',
        payload: { path: project, groupId: 'gui', testCase: { title: 'Новый', steps: [] } },
      });

      expect(response.statusCode).toBe(200);
    });

    it('перенос в занятую группу тоже отклоняется — пишут-то в приёмник', async () => {
      await create('gui');
      await create('e2e');
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/project-tests/case',
          payload: { path: project, groupId: 'gui', testCase: { title: 'Тест', steps: [] } },
        })
      ).json() as ProjectTestsView;
      const caseId = created.groups.find((group) => group.id === 'gui')?.cases[0]?.id ?? '';
      hold('run-9', 'e2e');

      const response = await app.inject({
        method: 'POST',
        url: '/api/project-tests/bulk',
        payload: { path: project, groupId: 'gui', caseIds: [caseId], action: 'move', value: 'e2e' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ runId: 'run-9' });
    });

    it('чтение раздела во время прогона работает — занят файл, а не вкладка', async () => {
      await create('gui');
      hold('run-42');

      const body = await view();

      expect(body.groups).toHaveLength(1);
    });
  });
});
