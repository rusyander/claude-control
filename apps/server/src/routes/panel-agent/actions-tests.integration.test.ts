import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PanelActionResult, PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import type { ProjectTestsView } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerAccessGate } from '../../lib/access-gate.ts';
import { registerEmptyBodyGuard } from '../../lib/empty-body.ts';
import { createEventHub, type EventHub } from '../../lib/event-hub.ts';
import { allowedOrigins } from '../../lib/origin-guard.ts';
import { resetCliLookupCache } from '../../providers/detect.ts';
import { ProjectTestManualRegistry, ProjectTestRunRegistry } from '../../domains/project-tests.ts';
import { PlatformGateway } from '../../domains/platform/gateway/listener.ts';
import { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { registerProjectTestsRoutes } from '../project-tests-routes.ts';
import { registerPlatformRoutes } from '../platform-routes.ts';
import { describeProviders } from '../../providers/registry.ts';
import { registerPanelAgentRoutes } from './panel-agent-routes.ts';

/**
 * Действия «Тестирование» (А5) на настоящих маршрутах раздела тестов и
 * настоящих файлах проекта `.agent/tests/`. Запуск агента тестов идёт в
 * ФАЛЬШИВЫЙ `claude` на PATH; доказательство — снимок процесса, файл группы,
 * черновик и запись прогона на диске, а не текст ответа действия.
 */
const isWindows = process.platform === 'win32';
const ORIGIN = 'http://localhost:8888';
const DRAFT_RUN = 'a1b2c3d4-0000-4000-8000-00000000a005';

const FAKE = `
import { writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
writeFileSync(process.env.CC_FAKE_DUMP, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  stdin: Buffer.concat(chunks).toString('utf8'),
}));
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 'fake-tests-session', model: 'fake', tools: [] });
setTimeout(() => {
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'fake-tests-session', total_cost_usd: 0, duration_ms: 1 });
}, Number(process.env.CC_FAKE_DELAY ?? 300));
`;

const testCase = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'case',
  title,
  steps: [{ action: 'Открыть', expected: 'Открыто' }],
  status: 'unknown',
  source: 'human',
  ...extra,
});

describe('panel-agent actions: tests', () => {
  let appData: string;
  let projectDir: string;
  let bin: string;
  let dumpFile: string;
  let store: AppStore;
  let hub: EventHub;
  let frames: Array<Record<string, unknown>>;
  let pending: PanelPendingActions;
  let gateway: PlatformGateway;
  let runs: ProjectTestRunRegistry;
  let app: FastifyInstance;
  const savedPath = process.env.PATH;
  const savedDump = process.env.CC_FAKE_DUMP;

  const testsDir = (): string => join(projectDir, '.agent', 'tests');
  const groupFile = (): string => join(testsDir(), 'gui.tests.json');

  beforeEach(async () => {
    appData = mkdtempSync(join(tmpdir(), 'cc-agent-a5-appdata-'));
    projectDir = mkdtempSync(join(tmpdir(), 'cc-agent-a5-project-'));
    bin = mkdtempSync(join(tmpdir(), 'cc-agent-a5-bin-'));
    dumpFile = join(bin, 'dump.json');
    const script = join(bin, 'fake-claude.mjs');
    writeFileSync(script, FAKE, 'utf8');
    if (isWindows) {
      writeFileSync(
        join(bin, 'claude.cmd'),
        `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
      );
      // Только фальшивый CLI и System32: настоящий `claude.exe` дальше по PATH
      // запустился бы вместо фальшивого.
      const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
      process.env.PATH = `${bin}${delimiter}${system32}`;
    } else {
      writeFileSync(
        join(bin, 'claude'),
        `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
        {
          mode: 0o755,
        },
      );
      process.env.PATH = `${bin}${delimiter}/usr/bin${delimiter}/bin`;
    }
    process.env.CC_FAKE_DUMP = dumpFile;
    resetCliLookupCache();

    mkdirSync(join(testsDir(), 'drafts'), { recursive: true });
    writeFileSync(
      groupFile(),
      JSON.stringify(
        {
          version: 1,
          title: 'GUI',
          cases: [
            testCase('gui-001', 'Вход в панель', {
              links: [{ type: 'requirement', url: 'https://acme.atlassian.net/browse/QA-42' }],
              status: 'passed',
            }),
            testCase('gui-002', 'Выход из панели'),
          ],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(testsDir(), 'drafts', `${DRAFT_RUN}.draft.json`),
      JSON.stringify({
        version: 1,
        runId: DRAFT_RUN,
        createdAt: '2026-09-17T09:00:00.000Z',
        items: [
          { op: 'add', groupId: 'gui', caseId: 'gui-003', case: testCase('gui-003', 'Смена темы') },
          {
            op: 'add',
            groupId: 'gui',
            caseId: 'gui-004',
            case: testCase('gui-004', 'Поиск по чатам'),
          },
        ],
      }),
    );

    store = new AppStore(appData);
    hub = createEventHub();
    frames = [];
    hub.subscribe((payload) => frames.push(JSON.parse(payload) as Record<string, unknown>));
    pending = new PanelPendingActions(10_000);
    gateway = new PlatformGateway();
    runs = new ProjectTestRunRegistry();
    const ctx = {
      store,
      location: { paths: { root: appData, appData } },
      backupDir: join(appData, 'backups'),
    } as unknown as ServerContext;
    const access = {
      allowedOrigins: allowedOrigins(8888),
      requiresToken: () => false,
      expectedToken: () => '',
    };
    app = Fastify();
    registerAccessGate(app, access);
    registerEmptyBodyGuard(app);
    registerProjectTestsRoutes(app, ctx, runs, new ProjectTestManualRegistry());
    registerPlatformRoutes(app, ctx, gateway);
    // Провайдер в карточке прогона — из реестра провайдеров, а не строкой; тот же
    // обработчик, что у `config-routes.ts` (весь модуль требует путей конфигурации).
    app.get('/api/providers', () => describeProviders(store));
    registerPanelAgentRoutes(app, ctx, { hub, pending, access });
    await app.ready();
  });

  afterEach(async () => {
    pending.cancelAll();
    runs.stop(projectDir);
    await gateway.stop();
    await app.close();
    process.env.PATH = savedPath;
    if (savedDump === undefined) delete process.env.CC_FAKE_DUMP;
    else process.env.CC_FAKE_DUMP = savedDump;
    resetCliLookupCache();
    await new Promise((done) => setTimeout(done, 200));
    for (const dir of [appData, projectDir, bin]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  const call = (name: string, input: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/agent/actions/${name}`,
      headers: { [PANEL_AGENT_HEADER]: '1' },
      payload: { input, conversationId: 'conv-a5' },
    });

  const listPending = async (): Promise<PanelPendingAction[]> =>
    (await app.inject({ method: 'GET', url: '/api/agent/pending' })).json();

  const waitPending = async (): Promise<PanelPendingAction> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const [first] = await listPending();
      if (first) return first;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('карточка так и не появилась');
  };

  const decide = (id: string, decision: 'approve' | 'reject') =>
    app.inject({
      method: 'POST',
      url: `/api/agent/pending/${id}`,
      headers: { origin: ORIGIN },
      payload: { decision },
    });

  const field = (card: PanelPendingAction, label: string): string | undefined =>
    card.preview.fields.find((item) => item.label === label)?.value;

  const view = async (): Promise<ProjectTestsView> =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/project-tests?path=${encodeURIComponent(projectDir)}`,
      })
    ).json();

  it('list_test_groups — группы, счётчики и ждущий черновик из вида раздела', async () => {
    const body = (
      await call('list_test_groups', { projectPath: projectDir })
    ).json<PanelActionResult>();
    expect(body.outcome).toBe('done');
    expect(body.result).toMatchObject({
      groups: [{ id: 'gui', title: 'GUI', cases: 2 }],
      drafts: [{ runId: DRAFT_RUN, status: 'pending', total: 2, pending: 2 }],
    });
    expect(await listPending()).toEqual([]);
  });

  it('list_cases — кейсы группы; неверный каталог — failed с текстом маршрута', async () => {
    const body = (
      await call('list_cases', { projectPath: projectDir, groupId: 'gui' })
    ).json<PanelActionResult>();
    expect(body.result).toMatchObject({
      groups: [
        {
          id: 'gui',
          cases: [
            { id: 'gui-001', title: 'Вход в панель', status: 'passed' },
            { id: 'gui-002', title: 'Выход из панели', status: 'unknown' },
          ],
        },
      ],
    });
    const wrong = (
      await call('list_cases', { projectPath: join(projectDir, 'missing') })
    ).json<PanelActionResult>();
    expect(wrong).toMatchObject({ outcome: 'failed', status: 400 });
    expect(wrong.message).toContain('не существует');
  });

  it('coverage — требование из ссылки кейса', async () => {
    const body = (
      await call('coverage', { projectPath: projectDir, linksOnly: true })
    ).json<PanelActionResult>();
    expect(body.outcome).toBe('done');
    const result = body.result as { items: Array<{ key: string; cases: unknown[] }> };
    expect(result.items).toMatchObject([{ key: 'QA-42' }]);
    expect(result.items[0]?.cases).toHaveLength(1);
  });

  it('last_run — пусто без истории, затем последний прогон без массива результатов', async () => {
    const empty = (await call('last_run', { projectPath: projectDir })).json<PanelActionResult>();
    expect(empty).toMatchObject({ outcome: 'done', result: { run: null } });

    const runsDir = join(testsDir(), 'runs');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, '20260917100000-aaaa.run.json'),
      JSON.stringify({
        id: 'run-a5',
        mode: 'run',
        actor: 'agent',
        status: 'done',
        startedAt: '2026-09-17T10:00:00.000Z',
        results: [
          { pointId: 'p1', groupId: 'gui', caseId: 'gui-001', status: 'passed' },
          { pointId: 'p2', groupId: 'gui', caseId: 'gui-002', status: 'failed' },
        ],
      }),
    );
    const body = (await call('last_run', { projectPath: projectDir })).json<PanelActionResult>();
    const run = (body.result as { run: Record<string, unknown> }).run;
    expect(run).toMatchObject({
      id: 'run-a5',
      summary: { total: 2, passed: 1, failed: 1 },
      failed: [{ groupId: 'gui', caseId: 'gui-002' }],
    });
    expect(run).not.toHaveProperty('results');
  });

  it('draft_cases: карточка показывает тела кейсов целиком; отказ не трогает файл группы', async () => {
    const before = readFileSync(groupFile(), 'utf8');
    const running = call('draft_cases', { projectPath: projectDir, runId: DRAFT_RUN });
    const card = await waitPending();
    expect(card).toMatchObject({ name: 'draft_cases', risk: 'change' });
    expect(card.preview.summary).toContain('2');
    expect(card.preview.truncated).toBeUndefined();
    // Тело целиком, а не заголовок: `update` переписывает шаги и ожидания.
    const draftFile = JSON.parse(
      readFileSync(join(testsDir(), 'drafts', `${DRAFT_RUN}.draft.json`), 'utf8'),
    ) as { items: Array<{ case: Record<string, unknown> }> };
    const third = field(card, 'Добавить · gui/gui-003') ?? '';
    // Поля результата прогона приёмка `add` не пишет (D4) — в карточке их нет.
    const { status: _status, ...described } = draftFile.items[0]!.case;
    expect(JSON.parse(third)).toEqual(described);
    expect(field(card, 'Добавить · gui/gui-004')).toContain('Поиск по чатам');

    await decide(card.id, 'reject');
    expect((await running).json<PanelActionResult>().outcome).toBe('rejected');
    expect(readFileSync(groupFile(), 'utf8')).toBe(before);
  });

  it('draft_cases: approve пишет выбранный кейс настоящим маршрутом приёмки', async () => {
    const running = call('draft_cases', {
      projectPath: projectDir,
      runId: DRAFT_RUN,
      caseIds: ['gui-004'],
    });
    const card = await waitPending();
    expect(field(card, 'Добавить · gui/gui-004')).toContain('Поиск по чатам');
    expect(field(card, 'Добавить · gui/gui-003')).toBeUndefined();

    await decide(card.id, 'approve');
    const result = (await running).json<PanelActionResult>();
    expect(result).toMatchObject({
      outcome: 'done',
      status: 200,
      page: { route: '/tests', focus: 'library' },
    });
    // Файл группы на диске — то, что увидит человек.
    const group = JSON.parse(readFileSync(groupFile(), 'utf8')) as {
      cases: Array<{ id: string; title: string }>;
    };
    expect(group.cases.map((item) => item.id)).toEqual(['gui-001', 'gui-002', 'gui-004']);
    const draft = (await view()).drafts?.find((item) => item.runId === DRAFT_RUN);
    expect(draft).toMatchObject({ accepted: 1, pending: 1 });
    expect(store.isTestsAutoAccept(projectDir)).toBe(false);
  });

  it('draft_cases: карточка не показывает полей прогона, которые приёмка не пишет (D4)', async () => {
    const runId = 'gen-d4';
    writeFileSync(
      join(testsDir(), 'drafts', `${runId}.draft.json`),
      JSON.stringify({
        version: 1,
        runId,
        createdAt: '2026-09-17T09:00:00.000Z',
        items: [
          {
            op: 'add',
            groupId: 'gui',
            caseId: 'gui-005',
            case: testCase('gui-005', 'Экспорт журнала', {
              status: 'passed',
              note: 'агент сам отметил: прошло',
              lastRunAt: '2026-09-17T08:00:00.000Z',
              lastRunId: 'run-fake',
            }),
          },
        ],
      }),
    );
    const running = call('draft_cases', { projectPath: projectDir, runId });
    const card = await waitPending();
    const shown = JSON.parse(field(card, 'Добавить · gui/gui-005') ?? '{}') as Record<
      string,
      unknown
    >;
    expect(shown.title).toBe('Экспорт журнала');
    for (const key of ['note', 'lastRunAt', 'lastRunId', 'status'])
      expect(shown).not.toHaveProperty(key);

    await decide(card.id, 'approve');
    expect((await running).json<PanelActionResult>().outcome).toBe('done');
    const written = (
      JSON.parse(readFileSync(groupFile(), 'utf8')) as { cases: Array<Record<string, unknown>> }
    ).cases.find((item) => item.id === 'gui-005');
    // Карточка — ровно то, что легло: заметки агента в файле нет.
    expect(written).toBeDefined();
    expect(written).not.toHaveProperty('note');
    expect(written).not.toHaveProperty('lastRunAt');
  });

  it('draft_cases: нечего писать или нет черновика — отказ без карточки', async () => {
    const missing = (
      await call('draft_cases', { projectPath: projectDir, runId: 'no-such-draft' })
    ).json<PanelActionResult>();
    expect(missing.outcome).toBe('failed');
    const none = (
      await call('draft_cases', { projectPath: projectDir, runId: DRAFT_RUN, caseIds: ['gui-999'] })
    ).json<PanelActionResult>();
    expect(none.outcome).toBe('failed');
    expect(none.message).toContain('has no cases gui-999');
    expect(await listPending()).toEqual([]);
  });

  it('run_tests: карточка — число кейсов и провайдер; отказ не запускает агента', async () => {
    const running = call('run_tests', { projectPath: projectDir, groupId: 'gui' });
    const card = await waitPending();
    expect(card).toMatchObject({ name: 'run_tests', risk: 'danger' });
    expect(field(card, 'Кейсов в отборе')).toBe('2');
    expect(field(card, 'Провайдер')).toBe('Claude Code');
    expect(field(card, 'Модель')).toBe('по умолчанию CLI');
    expect(card.preview.summary).toContain('2 кейс');
    // А9 D4: сводка и подписи кодом с подстановками.
    expect(card.preview).toMatchObject({
      summaryCode: 'summary-run-tests-run',
      summaryParams: { count: 2 },
    });
    for (const item of card.preview.fields) expect(item.labelCode).toBeDefined();

    await decide(card.id, 'reject');
    expect((await running).json<PanelActionResult>().outcome).toBe('rejected');
    expect(existsSync(dumpFile)).toBe(false);
    expect((await view()).run).toBeUndefined();
    expect(existsSync(join(testsDir(), 'runs'))).toBe(false);
  });

  it('run_tests: несуществующие id кейсов и окружения — отказ до карточки', async () => {
    const unknown = (
      await call('run_tests', { projectPath: projectDir, caseIds: ['gui-002', 'gui-777'] })
    ).json<PanelActionResult>();
    expect(unknown.outcome).toBe('failed');
    expect(unknown.message).toContain('gui-777');
    const env = (
      await call('run_tests', { projectPath: projectDir, environmentId: 'no-such-env' })
    ).json<PanelActionResult>();
    expect(env.outcome).toBe('failed');
    expect(env.message).toContain('no-such-env');
    expect(await listPending()).toEqual([]);
    expect(existsSync(dumpFile)).toBe(false);
  });

  it('run_tests: approve запускает агента тестов — процесс, запись прогона на диске', async () => {
    const running = call('run_tests', { projectPath: projectDir, caseIds: ['gui-002'] });
    const card = await waitPending();
    expect(field(card, 'Кейсов в отборе')).toBe('1');

    await decide(card.id, 'approve');
    const result = (await running).json<PanelActionResult>();
    expect(result).toMatchObject({
      outcome: 'done',
      status: 200,
      result: { run: { mode: 'run', status: 'running' } },
      page: { route: '/tests', focus: 'runs' },
    });
    const runId = (result.result as { run: { id: string } }).run.id;

    // Дождаться, пока фальшивый CLI отработает и реестр допишет запись.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await view()).run?.status !== 'running') break;
      await new Promise((done) => setTimeout(done, 100));
    }
    const dump = JSON.parse(readFileSync(dumpFile, 'utf8')) as { cwd: string; stdin: string };
    expect(dump.cwd.toLowerCase()).toBe(projectDir.toLowerCase());
    expect(dump.stdin).toContain('gui-002');
    const last = (await call('last_run', { projectPath: projectDir })).json<PanelActionResult>();
    expect(last.result).toMatchObject({ run: { id: runId, mode: 'run' } });
  });

  it('карточка устарела: файл группы изменён после показа — stale_preview, файл как у человека', async () => {
    const running = call('draft_cases', { projectPath: projectDir, runId: DRAFT_RUN });
    const card = await waitPending();
    const edited = readFileSync(groupFile(), 'utf8').replace('Выход из панели', 'Выход (человек)');
    writeFileSync(groupFile(), edited);
    await decide(card.id, 'approve');
    expect((await running).json<PanelActionResult>()).toMatchObject({
      outcome: 'failed',
      messageCode: 'stale_preview',
    });
    expect(readFileSync(groupFile(), 'utf8')).toBe(edited);
    expect((await view()).drafts?.find((item) => item.runId === DRAFT_RUN)).toMatchObject({
      pending: 2,
    });

    // Отбор прогона: человек добавил кейс в группу — «2 кейса» в карточке уже неправда.
    const launching = call('run_tests', { projectPath: projectDir, groupId: 'gui' });
    const runCard = await waitPending();
    expect(field(runCard, 'Кейсов в отборе')).toBe('2');
    const group = JSON.parse(readFileSync(groupFile(), 'utf8')) as { cases: unknown[] };
    group.cases.push(testCase('gui-009', 'Добавил человек'));
    writeFileSync(groupFile(), JSON.stringify(group, null, 2));
    await decide(runCard.id, 'approve');
    expect((await launching).json<PanelActionResult>()).toMatchObject({
      outcome: 'failed',
      messageCode: 'stale_preview',
    });
    expect(existsSync(dumpFile)).toBe(false);
    expect((await view()).run).toBeUndefined();
  });
  it('list_test_runs / read_test_run / lint_tests — история и замечания маршрутами раздела', async () => {
    const runsDir = join(testsDir(), 'runs');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, '20260917100000-bbbb.run.json'),
      JSON.stringify({
        id: 'run-wa',
        mode: 'run',
        actor: 'agent',
        status: 'done',
        startedAt: '2026-09-17T10:00:00.000Z',
        results: [{ pointId: 'p1', groupId: 'gui', caseId: 'gui-001', status: 'passed' }],
      }),
    );
    const list = (
      await call('list_test_runs', { projectPath: projectDir })
    ).json<PanelActionResult>();
    expect(list).toMatchObject({
      outcome: 'done',
      result: { runs: [{ id: 'run-wa', results: 1 }] },
    });
    const one = (
      await call('read_test_run', { projectPath: projectDir, runId: 'run-wa' })
    ).json<PanelActionResult>();
    expect(one.result).toMatchObject({ run: { id: 'run-wa', results: [{ caseId: 'gui-001' }] } });
    const missing = (
      await call('read_test_run', { projectPath: projectDir, runId: 'nope' })
    ).json<PanelActionResult>();
    expect(missing).toMatchObject({ outcome: 'failed', status: 404 });
    const lint = (await call('lint_tests', { projectPath: projectDir })).json<PanelActionResult>();
    expect(lint.outcome).toBe('done');
    expect(lint.result).toBeTypeOf('object');
  });

  it('delete_test_case: карточка — тело кейса; отказ не трогает файл, approve удаляет из файла группы', async () => {
    const before = readFileSync(groupFile(), 'utf8');
    const rejected = call('delete_test_case', {
      projectPath: projectDir,
      groupId: 'gui',
      caseId: 'gui-002',
    });
    const card = await waitPending();
    expect(card).toMatchObject({ name: 'delete_test_case', risk: 'danger' });
    expect(card.preview.diff).toContain('-  "title": "Выход из панели"');
    expect(card.preview.summaryCode).toBe('summary-delete-test-case');
    await decide(card.id, 'reject');
    expect((await rejected).json<PanelActionResult>().outcome).toBe('rejected');
    expect(readFileSync(groupFile(), 'utf8')).toBe(before);

    const running = call('delete_test_case', {
      projectPath: projectDir,
      groupId: 'gui',
      caseId: 'gui-002',
    });
    await decide((await waitPending()).id, 'approve');
    expect((await running).json<PanelActionResult>()).toMatchObject({
      outcome: 'done',
      result: { deleted: true },
    });
    const group = JSON.parse(readFileSync(groupFile(), 'utf8')) as { cases: Array<{ id: string }> };
    expect(group.cases.map((item) => item.id)).toEqual(['gui-001']);

    const gone = (
      await call('delete_test_case', { projectPath: projectDir, groupId: 'gui', caseId: 'gui-002' })
    ).json<PanelActionResult>();
    expect(gone).toMatchObject({ outcome: 'failed' });
    expect(gone.message).toContain('gui-002');
  });

  it('stop_tests: без прогона — отказ без карточки; идущий прогон останавливается по approve', async () => {
    const idle = (await call('stop_tests', { projectPath: projectDir })).json<PanelActionResult>();
    expect(idle).toMatchObject({ outcome: 'failed' });
    expect(idle.message).toContain('No test run');

    process.env.CC_FAKE_DELAY = '60000';
    try {
      const start = call('run_tests', { projectPath: projectDir, caseIds: ['gui-002'] });
      await decide((await waitPending()).id, 'approve');
      expect((await start).json<PanelActionResult>().outcome).toBe('done');
      expect((await view()).run?.status).toBe('running');

      const stopping = call('stop_tests', { projectPath: projectDir });
      const card = await waitPending();
      expect(card).toMatchObject({ name: 'stop_tests', risk: 'change' });
      expect(card.preview.diff).toContain('+  "status": "stopped"');
      await decide(card.id, 'approve');
      const stopped = (await stopping).json<PanelActionResult>();
      expect(stopped.outcome).toBe('done');
      expect((await view()).run?.status).not.toBe('running');
    } finally {
      delete process.env.CC_FAKE_DELAY;
    }
  });
});
