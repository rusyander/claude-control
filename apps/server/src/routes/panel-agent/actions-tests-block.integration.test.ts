import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { PanelActionResult, PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import type { ProjectTestsView } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerAccessGate } from '../../lib/access-gate.ts';
import { registerEmptyBodyGuard } from '../../lib/empty-body.ts';
import { createEventHub, type EventHub } from '../../lib/event-hub.ts';
import { allowedOrigins } from '../../lib/origin-guard.ts';
import {
  E2eRunRegistry,
  ProjectTestManualRegistry,
  ProjectTestRunRegistry,
} from '../../domains/project-tests.ts';
import { encodePng } from '../../domains/project-tests/png.ts';
import { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { registerProjectTestsRoutes } from '../project-tests-routes.ts';
import { registerProjectRoutes } from '../project-routes.ts';
import { registerPanelAgentRoutes } from './panel-agent-routes.ts';
import { TESTS_BLOCK_ACTIONS } from './actions-tests-block.ts';

/**
 * Действия блока «Тестирование» сверх первого набора — отчёты, планы, ручной
 * прогон, эталоны, автотесты папки e2e, обвязка библиотеки — на настоящих
 * маршрутах раздела тестов и настоящих файлах временного проекта. Доказательство
 * — файлы `.agent/tests/` и вид раздела после одобрения, отказ до карточки и
 * «устаревшая карточка» при правке между показом и кликом; не текст ответа.
 */
const ORIGIN = 'http://localhost:8888';
const DRAFT_RUN = 'b2c3d4e5-0000-4000-8000-00000000b004';

const testCase = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'case',
  title,
  steps: [{ action: 'Открыть', expected: 'Открыто' }],
  status: 'unknown',
  source: 'human',
  ...extra,
});

/** Содержимое папки целиком: путь → sha256. Равенство до и после = ничего не записано. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    out[relative(root, file)] = createHash('sha256').update(readFileSync(file)).digest('hex');
  }
  return out;
}

function png(color: number): string {
  const data = new Uint8Array(4 * 4 * 4).fill(color);
  for (let index = 3; index < data.length; index += 4) data[index] = 255;
  return encodePng({ width: 4, height: 4, data }).toString('base64');
}

describe('panel-agent actions: Testing block (plans, manual, baselines, e2e, reports, setup)', () => {
  let appData: string;
  let projectDir: string;
  let store: AppStore;
  let hub: EventHub;
  let pending: PanelPendingActions;
  let runs: ProjectTestRunRegistry;
  let e2eRuns: E2eRunRegistry;
  let app: FastifyInstance;

  const testsDir = (): string => join(projectDir, '.agent', 'tests');
  const groupFile = (): string => join(testsDir(), 'gui.tests.json');
  const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

  beforeEach(async () => {
    appData = mkdtempSync(join(tmpdir(), 'cc-agent-u4b-appdata-'));
    projectDir = mkdtempSync(join(tmpdir(), 'cc-agent-u4b-project-'));
    mkdirSync(join(testsDir(), 'drafts'), { recursive: true });
    writeFileSync(
      groupFile(),
      JSON.stringify({
        version: 1,
        title: 'GUI',
        cases: [
          testCase('gui-001', 'Вход в панель', {
            priority: 'blocker',
            duration: 2,
            automation: { status: 'automated', file: 'tests/login.check.mjs' },
          }),
          testCase('gui-002', 'Выход из панели', { priority: 'high', duration: 3 }),
          testCase('gui-003', 'Смена темы', { priority: 'low', duration: 5 }),
        ],
      }),
    );
    writeFileSync(
      join(testsDir(), 'other.tests.json'),
      JSON.stringify({ version: 1, title: 'Other', cases: [] }),
    );

    store = new AppStore(appData);
    store.addProject({ id: 'p-u4b', name: 'U4b', path: projectDir });
    hub = createEventHub();
    pending = new PanelPendingActions(10_000);
    runs = new ProjectTestRunRegistry();
    e2eRuns = new E2eRunRegistry();
    const ctx = {
      store,
      location: {
        paths: { root: appData, appData, settings: join(appData, 'settings.json') },
      },
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
    registerProjectRoutes(app, ctx);
    registerProjectTestsRoutes(app, ctx, runs, new ProjectTestManualRegistry(), { e2eRuns });
    registerPanelAgentRoutes(app, ctx, { hub, pending, access });
    await app.ready();
  });

  afterEach(async () => {
    pending.cancelAll();
    e2eRuns.stop(projectDir);
    await app.close();
    await new Promise((done) => setTimeout(done, 200));
    for (const dir of [appData, projectDir]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  const call = (name: string, input: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/agent/actions/${name}`,
      headers: { [PANEL_AGENT_HEADER]: '1' },
      payload: { input, conversationId: 'conv-u4b' },
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

  /** Вызов с карточкой: решение человека, карточка и итог действия. */
  const decided = async (
    name: string,
    input: unknown,
    decision: 'approve' | 'reject' = 'approve',
    between?: () => Promise<void>,
  ): Promise<{ card: PanelPendingAction; result: PanelActionResult }> => {
    const answer = call(name, input);
    const card = await waitPending();
    if (between) await between();
    expect((await decide(card.id, decision)).statusCode).toBe(200);
    return { card, result: (await answer).json<PanelActionResult>() };
  };

  const read = async (input: Record<string, unknown>) =>
    (
      await call('read_tests_report', { projectPath: projectDir, ...input })
    ).json<PanelActionResult>();

  /** Правка «из окна» — тем же маршрутом, с Origin панели. */
  const human = (method: 'POST' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { origin: ORIGIN },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const view = async (): Promise<ProjectTestsView> =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/project-tests?path=${encodeURIComponent(projectDir)}`,
      })
    ).json();

  const groupCases = () => readJson<{ cases: Array<Record<string, unknown>> }>(groupFile()).cases;

  it('unknown action name and bad kind — refused without a card', async () => {
    const unknown = (
      await call('read_tests_reports', { projectPath: projectDir, kind: 'report' })
    ).json<PanelActionResult>();
    expect(unknown.outcome).toBe('unknown');
    const invalid = (await read({ kind: 'secrets' })).outcome;
    expect(invalid).toBe('invalid');
    const noPlan = await read({ kind: 'plan-points' });
    expect(noPlan).toMatchObject({ outcome: 'failed' });
    expect(noPlan.message).toContain('needs planId');
    expect(await listPending()).toEqual([]);
  });

  it('a folder the panel does not know — every action refused before a card, nothing written', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cc-agent-u4b-outside-'));
    try {
      const tests = join(outside, '.agent', 'tests');
      mkdirSync(join(tests, 'drafts'), { recursive: true });
      writeFileSync(join(tests, 'gui.tests.json'), readFileSync(groupFile()));
      writeFileSync(
        join(tests, 'automation.json'),
        JSON.stringify({ command: `node -e "require('fs').writeFileSync('ran.txt','ok')"` }),
      );
      const inputs: Record<string, Record<string, unknown>> = {
        read_tests_report: { kind: 'report' },
        save_test_plan: { title: 'Чужой план' },
        delete_test_plan: { planId: 'plan-1' },
        build_test_plan: { recipe: 'smoke' },
        start_manual_run: { groupId: 'gui' },
        record_manual_result: { caseId: 'gui-001', status: 'passed' },
        finish_manual_run: {},
        cancel_manual_run: {},
        attach_test_note: { caseId: 'gui-002', name: 'note.txt', text: 'x' },
        accept_baseline: { caseId: 'gui-001', pointId: 'p-1' },
        sync_e2e_tests: {},
        run_e2e_tests: {},
        stop_e2e_tests: {},
        save_shared_step: { title: 'Шаг', steps: [{ action: 'Открыть' }] },
        delete_shared_step: { stepId: 's-1' },
        save_test_environment: { title: 'Stage' },
        delete_test_environment: { environmentId: 'e-1' },
        save_test_schema: { attributes: [], statuses: [] },
        save_test_view: { title: 'Фильтр', filter: {} },
        delete_test_view: { viewId: 'v-1' },
        install_test_convention: {},
        bulk_edit_cases: { groupId: 'gui', caseIds: ['gui-001'], action: 'tag', value: 'x' },
        bulk_delete_cases: { groupId: 'gui', caseIds: ['gui-001'] },
        set_draft_auto_accept: { enabled: true },
        rollback_draft: { runId: DRAFT_RUN },
      };
      // Каждое действие блока проверено: новое без входа здесь роняет тест.
      expect(Object.keys(inputs).sort()).toEqual(TESTS_BLOCK_ACTIONS.map((a) => a.name).sort());
      const before = snapshot(outside);
      const seen: Record<string, unknown> = {};
      const refused: Record<string, unknown> = {};
      for (const [name, input] of Object.entries(inputs)) {
        const answer = call(name, { projectPath: outside, ...input });
        let settled = false;
        void answer.finally(() => (settled = true));
        let carded = false;
        while (!settled) {
          const cards = await listPending();
          for (const card of cards) {
            carded = true;
            await decide(card.id, 'reject');
          }
          await new Promise((done) => setTimeout(done, 10));
        }
        const result = (await answer).json<PanelActionResult>();
        const notRegistered = (result.message ?? '').includes('not registered');
        seen[name] = { carded, outcome: result.outcome, notRegistered };
        refused[name] = { carded: false, outcome: 'failed', notRegistered: true };
      }
      expect(seen).toEqual(refused);
      expect(snapshot(outside)).toEqual(before);
      expect(existsSync(join(outside, 'ran.txt'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('read_tests_report — every kind reads through its route; secrets of an environment stay names', async () => {
    await human('POST', '/api/project-tests/environment', {
      path: projectDir,
      environment: {
        title: 'Stage',
        baseUrl: 'https://stage.example.com',
        secrets: [{ name: 'QA_PASSWORD' }],
      },
    });
    await human('POST', '/api/project-tests/plan', {
      path: projectDir,
      plan: { title: 'Регресс', caseIds: ['gui-001', 'gui-002'] },
    });
    const kinds = [
      'report',
      'impact',
      'flaky',
      'quarantine',
      'risk',
      'taxonomy',
      'pyramid',
      'release',
      'plans',
      'manual',
      'baselines',
      'e2e',
      'e2e-run',
      'library-setup',
    ];
    for (const kind of kinds) {
      const body = await read({ kind });
      expect({ kind, outcome: body.outcome }).toEqual({ kind, outcome: 'done' });
    }
    const plans = (await read({ kind: 'plans' })).result as { plans: Array<{ id: string }> };
    expect(plans.plans).toHaveLength(1);
    const points = (await read({ kind: 'plan-points', planId: plans.plans[0]!.id })).result as {
      points: Array<{ caseId: string }>;
    };
    expect(points.points.map((point) => point.caseId).sort()).toEqual(['gui-001', 'gui-002']);
    const setup = (await read({ kind: 'library-setup' })).result as {
      environments: Array<{ title: string; secrets?: Array<{ name: string }> }>;
    };
    expect(setup.environments).toMatchObject([
      { title: 'Stage', secrets: [{ name: 'QA_PASSWORD' }] },
    ]);
    const history = await read({ kind: 'case-history', groupId: 'gui', caseId: 'gui-001' });
    expect(history.outcome).toBe('done');
    const gitHistory = await read({ kind: 'group-history', groupId: 'gui' });
    expect(gitHistory).toMatchObject({ outcome: 'done', result: { entries: [] } });
    // Чтение — без карточки.
    expect(await listPending()).toEqual([]);
  });

  it('save_test_plan: new plan by card, edit merges with disk, locked plan refused before a card', async () => {
    const rejected = await decided(
      'save_test_plan',
      { projectPath: projectDir, title: 'Дым', caseIds: ['gui-001'] },
      'reject',
    );
    expect(rejected.card).toMatchObject({ name: 'save_test_plan', risk: 'change' });
    expect(rejected.result.outcome).toBe('rejected');
    expect((await view()).plans).toEqual([]);

    const created = await decided('save_test_plan', {
      projectPath: projectDir,
      title: 'Дым',
      caseIds: ['gui-001'],
      tags: ['smoke'],
    });
    expect(created.card.preview.summary).toBe('Создать тест-план «Дым»');
    expect(created.result.outcome).toBe('done');
    const planId = (created.result.result as { planId: string }).planId;
    expect(existsSync(join(testsDir(), 'plans', `${planId}.plan.json`))).toBe(true);

    // Правка названия не стирает состав: маршрут пишет план целиком, действие сливает.
    const edited = await decided('save_test_plan', {
      projectPath: projectDir,
      planId,
      title: 'Дымовой',
      locked: true,
    });
    expect(edited.card.preview.summary).toBe('Изменить тест-план «Дымовой»');
    const saved = readJson<Record<string, unknown>>(
      join(testsDir(), 'plans', `${planId}.plan.json`),
    );
    expect(saved).toMatchObject({
      title: 'Дымовой',
      caseIds: ['gui-001'],
      tags: ['smoke'],
      locked: true,
    });

    const locked = (
      await call('save_test_plan', { projectPath: projectDir, planId, title: 'Иначе' })
    ).json<PanelActionResult>();
    expect(locked.outcome).toBe('failed');
    expect(locked.message).toContain('locked');
    const missing = (
      await call('save_test_plan', { projectPath: projectDir, planId: 'nope', title: 'X' })
    ).json<PanelActionResult>();
    expect(missing.message).toContain('not found');
    expect(await listPending()).toEqual([]);
  });

  it('build_test_plan: card reads the preview and writes nothing; approve saves; stale when the library moved', async () => {
    const plansDir = join(testsDir(), 'plans');
    const planFiles = () => (existsSync(plansDir) ? readdirSync(plansDir) : []);
    const stale = await decided(
      'build_test_plan',
      { projectPath: projectDir, recipe: 'smoke', budget: 5, title: 'Дым 5' },
      'approve',
      async () => {
        // Карточка висит — плана на диске ещё нет: сборка карточки только читает.
        expect(planFiles()).toEqual([]);
        // Человек убирает кейс в архив между показом и кликом — отбор другой.
        await human('POST', '/api/project-tests/bulk', {
          path: projectDir,
          groupId: 'gui',
          caseIds: ['gui-002'],
          action: 'archive',
        });
      },
    );
    expect(stale.result).toMatchObject({ outcome: 'failed', messageCode: 'stale_preview' });
    expect(planFiles()).toEqual([]);

    const rejected = await decided(
      'build_test_plan',
      { projectPath: projectDir, recipe: 'smoke', budget: 5, title: 'Дым 5' },
      'reject',
    );
    expect(rejected.result.outcome).toBe('rejected');
    expect(planFiles()).toEqual([]);

    const built = await decided('build_test_plan', {
      projectPath: projectDir,
      recipe: 'smoke',
      budget: 5,
      title: 'Дым 5',
    });
    expect(built.card).toMatchObject({ name: 'build_test_plan', risk: 'change' });
    expect(built.card.preview.fields.map((field) => field.value)).toContain(
      'дым под бюджет времени',
    );
    expect(built.card.preview.diff).toContain('gui/gui-001');
    expect(built.result).toMatchObject({ outcome: 'done' });
    const result = built.result.result as { planId: string; picked: number };
    expect(result.picked).toBeGreaterThan(0);
    expect((await view()).plans.map((plan) => plan.id)).toEqual([result.planId]);
    expect(planFiles()).toEqual([`${result.planId}.plan.json`]);

    const refused = (
      await call('build_test_plan', { projectPath: projectDir, recipe: 'flaky' })
    ).json<PanelActionResult>();
    // Прогонов нет — нестабильных нет: пустой план не предлагается, карточки нет.
    expect(refused.outcome).toBe('failed');
    expect(refused.message).toContain('picked no cases');
    expect(await listPending()).toEqual([]);
  });

  it('delete_test_plan: danger card, approve removes the file; unknown id refused', async () => {
    await human('POST', '/api/project-tests/plan', { path: projectDir, plan: { title: 'Старый' } });
    const planId = (await view()).plans[0]!.id;
    const { card, result } = await decided('delete_test_plan', { projectPath: projectDir, planId });
    expect(card).toMatchObject({ risk: 'danger' });
    expect(result).toMatchObject({ outcome: 'done' });
    expect((await view()).plans).toEqual([]);
    const missing = (
      await call('delete_test_plan', { projectPath: projectDir, planId })
    ).json<PanelActionResult>();
    expect(missing.outcome).toBe('failed');
  });

  it('manual run: start → record (by case) → finish; the case file and the run record carry the result', async () => {
    const started = await decided('start_manual_run', { projectPath: projectDir, groupId: 'gui' });
    expect(started.card.preview.summary).toBe('Начать ручной прогон: 3 прохода');
    const session = started.result.result as { runId: string; points: Array<{ caseId: string }> };
    expect(session.points).toHaveLength(3);

    const again = (
      await call('start_manual_run', { projectPath: projectDir, groupId: 'gui' })
    ).json<PanelActionResult>();
    expect(again.outcome).toBe('failed');
    expect(again.message).toContain('already going');

    const marked = await decided('record_manual_result', {
      projectPath: projectDir,
      caseId: 'gui-002',
      status: 'failed',
      note: 'Кнопка «Выйти» молчит',
    });
    expect(marked.card.preview.summary).toBe('Отметить «Выход из панели»: провален');
    expect(marked.card.preview.summaryParamsEn).toEqual({
      title: 'Выход из панели',
      status: 'failed',
    });
    expect(marked.result.result).toMatchObject({ marked: 1, total: 3 });
    expect(groupCases().find((item) => item.id === 'gui-002')).toMatchObject({
      status: 'failed',
      note: 'Кнопка «Выйти» молчит',
    });

    const finished = await decided('finish_manual_run', { projectPath: projectDir });
    expect(finished.card.preview.summary).toBe('Завершить ручной прогон: отмечено 1 из 3');
    expect(finished.result.outcome).toBe('done');
    const record = readdirSync(join(testsDir(), 'runs'))
      .filter((name) => name.endsWith('.run.json'))
      .map((name) => readJson<{ id: string; status: string }>(join(testsDir(), 'runs', name)))
      .find((item) => item.id === session.runId);
    expect(record?.status).toBe('done');

    const none = (
      await call('record_manual_result', {
        projectPath: projectDir,
        caseId: 'gui-001',
        status: 'passed',
      })
    ).json<PanelActionResult>();
    expect(none.message).toContain('No manual run');
  });

  it('manual run: a mark by the human between card and click makes the card stale; cancel keeps marks', async () => {
    const started = await decided('start_manual_run', {
      projectPath: projectDir,
      caseIds: ['gui-001', 'gui:gui-003'],
    });
    const { runId, points } = started.result.result as {
      runId: string;
      points: Array<{ pointId: string; caseId: string }>;
    };
    expect(points.map((point) => point.caseId)).toEqual(['gui-001', 'gui-003']);
    const stale = await decided(
      'record_manual_result',
      { projectPath: projectDir, pointId: points[0]!.pointId, status: 'passed' },
      'approve',
      async () => {
        await human('POST', '/api/project-tests/manual/result', {
          path: projectDir,
          runId,
          pointId: points[0]!.pointId,
          status: 'blocked',
        });
      },
    );
    expect(stale.result).toMatchObject({ outcome: 'failed', messageCode: 'stale_preview' });
    expect(groupCases().find((item) => item.id === 'gui-001')).toMatchObject({ status: 'blocked' });

    const cancelled = await decided('cancel_manual_run', { projectPath: projectDir });
    expect(cancelled.card.preview.summary).toContain('отмечено 1 из 2');
    expect(cancelled.result.outcome).toBe('done');
    expect((await read({ kind: 'manual' })).result).toEqual({});
    expect(groupCases().find((item) => item.id === 'gui-001')).toMatchObject({ status: 'blocked' });
  });

  it('attach_test_note: text evidence lands in the case folder; a live secret is refused before a card', async () => {
    const { card, result } = await decided(
      'attach_test_note',
      {
        projectPath: projectDir,
        caseId: 'gui-002',
        name: 'console.log',
        text: 'TypeError: logout is not a function\n    at click',
      },
      'approve',
      // Человек думает дольше секунды: время в имени файла — время карточки, не клика.
      () => new Promise((done) => setTimeout(done, 1_100)),
    );
    expect(card.preview.summary).toBe('Приложить «console.log» к кейсу «Выход из панели»');
    const file = (result.result as { file: string }).file;
    expect(file).toMatch(/attachments\/gui-002\/\d+-console\.log$/);
    // Карточка называет ровно тот файл, что лёг на диск.
    const shown = /^\+\+\+ b\/(.+)$/m.exec(card.preview.diff ?? '')?.[1];
    expect(shown).toBe(file);
    expect(readFileSync(join(projectDir, file), 'utf8')).toContain('logout is not a function');

    const secret = (
      await call('attach_test_note', {
        projectPath: projectDir,
        caseId: 'gui-002',
        name: 'env.txt',
        text: 'token=ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
      })
    ).json<PanelActionResult>();
    expect(secret.outcome).toBe('failed');
    expect(secret.message).toContain('Secret values are never accepted');
    const binary = (
      await call('attach_test_note', {
        projectPath: projectDir,
        caseId: 'gui-002',
        name: 'a.png',
        text: 'x',
      })
    ).json<PanelActionResult>();
    expect(binary.outcome).toBe('invalid');
    expect(await listPending()).toEqual([]);
  });

  it('accept_baseline: the differing snapshot replaces the baseline (danger); nothing to accept is refused', async () => {
    const snap = (color: number) =>
      human('POST', '/api/project-tests/baseline', {
        path: projectDir,
        caseId: 'gui-003',
        pointId: 'p-default',
        contentBase64: png(color),
      });
    expect((await snap(20)).statusCode).toBe(200);
    const nothing = (
      await call('accept_baseline', {
        projectPath: projectDir,
        caseId: 'gui-003',
        pointId: 'p-default',
      })
    ).json<PanelActionResult>();
    expect(nothing.outcome).toBe('failed');
    expect(nothing.message).toContain('Nothing to accept');

    expect((await snap(200)).json()).toMatchObject({ baseline: { status: 'diff' } });
    const { card, result } = await decided('accept_baseline', {
      projectPath: projectDir,
      caseId: 'gui-003',
      pointId: 'p-default',
    });
    expect(card).toMatchObject({ risk: 'danger' });
    expect(card.preview.fields.map((field) => field.label)).toContain('Расхождение с эталоном');
    expect(result.result).toMatchObject({ status: 'match' });
    const baselines = (await read({ kind: 'baselines', caseId: 'gui-003' })).result as {
      baselines: Array<{ status: string; actualFile?: string }>;
    };
    expect(baselines.baselines).toMatchObject([{ status: 'match' }]);
    expect(baselines.baselines[0]?.actualFile).toBeUndefined();
  });

  it('sync_e2e_tests: new spec in the e2e folder becomes a case; no folder — refused before a card', async () => {
    const refused = (
      await call('sync_e2e_tests', { projectPath: projectDir })
    ).json<PanelActionResult>();
    expect(refused.outcome).toBe('failed');
    expect(refused.message).toContain('no e2e folder');

    expect((await human('POST', '/api/project-tests/e2e', { path: projectDir })).statusCode).toBe(
      200,
    );
    const folder = (await read({ kind: 'e2e' })).result as { dir: string };
    writeFileSync(
      join(projectDir, folder.dir, 'logout.spec.ts'),
      "import { test } from '@playwright/test';\ntest('logs out', async () => {});\n",
    );
    const { card, result } = await decided('sync_e2e_tests', { projectPath: projectDir });
    expect(card.preview.summary).toBe(`Сверить тесты папки ${folder.dir} с кейсами`);
    expect(result.outcome).toBe('done');
    expect(result.result).toMatchObject({ added: 1 });
  });

  it('run_e2e_tests / stop_e2e_tests: the project command runs on the machine, stop ends it; nothing running — refused', async () => {
    const noRun = (
      await call('stop_e2e_tests', { projectPath: projectDir })
    ).json<PanelActionResult>();
    expect(noRun.outcome).toBe('failed');
    expect(noRun.message).toContain('No autotest run');

    const marker = join(projectDir, 'ran.txt');
    writeFileSync(
      join(testsDir(), 'automation.json'),
      JSON.stringify({
        command: `node -e "require('fs').writeFileSync('ran.txt','ok');setTimeout(()=>{},30000)"`,
      }),
    );
    const { card, result } = await decided('run_e2e_tests', { projectPath: projectDir });
    expect(card).toMatchObject({ risk: 'danger' });
    expect(card.preview.summary).toBe('Прогнать все автотесты проекта');
    expect(card.preview.fields.map((field) => field.value)).toContain(
      `node -e "require('fs').writeFileSync('ran.txt','ok');setTimeout(()=>{},30000)"`,
    );
    expect(result.result).toMatchObject({ run: { status: 'running' } });
    for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt += 1) {
      await new Promise((done) => setTimeout(done, 100));
    }
    expect(readFileSync(marker, 'utf8')).toBe('ok');

    const twice = (
      await call('run_e2e_tests', { projectPath: projectDir })
    ).json<PanelActionResult>();
    expect(twice.message).toContain('already running');

    const stopped = await decided('stop_e2e_tests', { projectPath: projectDir });
    expect(stopped.result.result).toMatchObject({ run: { status: 'stopped' } });
    const some = (
      await call('run_e2e_tests', { projectPath: projectDir, caseIds: ['gui-002'] })
    ).json<PanelActionResult>();
    expect(some.message).toContain('has an autotest');
  });

  it('shared steps: create, edit keeps the steps on disk, delete', async () => {
    const created = await decided('save_shared_step', {
      projectPath: projectDir,
      title: 'Войти',
      steps: [{ action: 'Открыть /login', expected: 'Форма входа' }],
    });
    const stepId = (created.result.result as { stepId: string }).stepId;
    expect(stepId).toBeTruthy();
    await decided('save_shared_step', {
      projectPath: projectDir,
      stepId,
      description: 'Общий вход',
    });
    expect((await view()).sharedSteps).toMatchObject([
      {
        id: stepId,
        title: 'Войти',
        description: 'Общий вход',
        steps: [{ action: 'Открыть /login' }],
      },
    ]);
    const deleted = await decided('delete_shared_step', { projectPath: projectDir, stepId });
    expect(deleted.card.risk).toBe('danger');
    expect((await view()).sharedSteps).toEqual([]);
    const fresh = (
      await call('save_shared_step', { projectPath: projectDir, title: 'Без шагов' })
    ).json<PanelActionResult>();
    expect(fresh.message).toContain('needs a title and steps');
  });

  it('environments: edit keeps credential names from disk; literal secret refused; plan in use needs force', async () => {
    await human('POST', '/api/project-tests/environment', {
      path: projectDir,
      environment: {
        title: 'Stage',
        baseUrl: 'https://stage.example.com',
        secrets: [{ name: 'QA_PASSWORD' }],
      },
    });
    const environmentId = (await view()).environments[0]!.id;
    await decided('save_test_environment', {
      projectPath: projectDir,
      environmentId,
      browser: 'chromium',
    });
    expect((await view()).environments[0]).toMatchObject({
      id: environmentId,
      baseUrl: 'https://stage.example.com',
      browser: 'chromium',
      secrets: [{ name: 'QA_PASSWORD' }],
    });
    const leaked = (
      await call('save_test_environment', {
        projectPath: projectDir,
        title: 'Prod',
        baseUrl: 'https://admin:' + 'Sup3rS3cretPassw0rd!x' + '@prod.example.com',
      })
    ).json<PanelActionResult>();
    expect(leaked.outcome).toBe('failed');
    expect(leaked.message).toContain('Secret values are never accepted');

    await human('POST', '/api/project-tests/plan', {
      path: projectDir,
      plan: { title: 'На стейдже', environmentIds: [environmentId] },
    });
    const used = (
      await call('delete_test_environment', { projectPath: projectDir, environmentId })
    ).json<PanelActionResult>();
    expect(used.message).toContain('На стейдже');
    const forced = await decided('delete_test_environment', {
      projectPath: projectDir,
      environmentId,
      force: true,
    });
    expect(forced.card.preview.fields.map((field) => field.label)).toContain(
      'На него ссылаются планы',
    );
    expect((await view()).environments).toEqual([]);

    const created = await decided('save_test_environment', {
      projectPath: projectDir,
      title: 'Local',
    });
    expect(created.result.result).toMatchObject({ environmentId: 'local' });
  });

  it('save_test_schema and saved filters: whole schema replaced; filter saved and deleted', async () => {
    const schema = await decided('save_test_schema', {
      projectPath: projectDir,
      attributes: [
        { id: 'component', title: 'Компонент', type: 'select', options: ['web', 'api'] },
      ],
      statuses: [{ id: 'retest', title: 'Перепроверить', group: 'failed' }],
    });
    expect(schema.card.preview.diff).toContain('component');
    expect((await view()).schema).toMatchObject({
      attributes: [{ key: 'component', type: 'select', options: ['web', 'api'] }],
      statuses: [{ id: 'retest', group: 'failed' }],
    });
    // Модель читает поле тем же именем, каким пишет, и без маски секретов.
    expect(schema.result.result).toMatchObject({ attributes: [{ id: 'component' }] });
    const setup = (await read({ kind: 'library-setup' })).result as {
      schema: { attributes: Array<{ id: string }> };
    };
    expect(setup.schema.attributes).toMatchObject([{ id: 'component', title: 'Компонент' }]);
    const badSelect = await decided('save_test_schema', {
      projectPath: projectDir,
      attributes: [{ id: 'area2', title: 'Зона', type: 'select' }],
      statuses: [],
    });
    expect(badSelect.result.outcome).toBe('failed');

    const saved = await decided('save_test_view', {
      projectPath: projectDir,
      title: 'Блокеры',
      filter: { priorities: ['blocker'] },
    });
    const viewId = (saved.result.result as { viewId: string }).viewId;
    expect((await view()).views).toMatchObject([
      { id: viewId, filter: { priorities: ['blocker'] } },
    ]);
    await decided('save_test_view', { projectPath: projectDir, viewId, title: 'Только блокеры' });
    expect((await view()).views).toMatchObject([
      { id: viewId, title: 'Только блокеры', filter: { priorities: ['blocker'] } },
    ]);
    await decided('delete_test_view', { projectPath: projectDir, viewId });
    expect((await view()).views).toEqual([]);
  });

  it('install_test_convention: the block lands in the project instructions once', async () => {
    const { card, result } = await decided('install_test_convention', { projectPath: projectDir });
    expect(card.preview.summary).toBe('Вписать соглашение о кейсах в инструкции проекта');
    expect(result.result).toEqual({ hasConvention: true });
    const files = readdirSync(projectDir).filter((name) => /^(CLAUDE|AGENTS)\.md$/.test(name));
    expect(files).toHaveLength(1);
    const again = (
      await call('install_test_convention', { projectPath: projectDir })
    ).json<PanelActionResult>();
    expect(again.message).toContain('already');
  });

  it('bulk_edit_cases / bulk_delete_cases: tag and move written; missing value and foreign ids refused', async () => {
    const tagged = await decided('bulk_edit_cases', {
      projectPath: projectDir,
      groupId: 'gui',
      caseIds: ['gui-001', 'gui-002'],
      action: 'tag',
      value: 'smoke',
    });
    expect(tagged.card.preview.summary).toBe('Изменить 2 кейса разом');
    expect(tagged.result.result).toEqual({ touched: 2 });
    expect(
      groupCases().filter((item) => (item.tags as string[] | undefined)?.includes('smoke')),
    ).toHaveLength(2);

    const noValue = (
      await call('bulk_edit_cases', {
        projectPath: projectDir,
        groupId: 'gui',
        caseIds: ['gui-001'],
        action: 'priority',
      })
    ).json<PanelActionResult>();
    expect(noValue.message).toContain('needs a value');
    const foreign = (
      await call('bulk_edit_cases', {
        projectPath: projectDir,
        groupId: 'gui',
        caseIds: ['gui-999'],
        action: 'archive',
      })
    ).json<PanelActionResult>();
    expect(foreign.message).toContain('gui-999');

    await decided('bulk_edit_cases', {
      projectPath: projectDir,
      groupId: 'gui',
      caseIds: ['gui-003'],
      action: 'move',
      value: 'other',
    });
    expect(
      readJson<{ cases: Array<{ id: string }> }>(join(testsDir(), 'other.tests.json')).cases,
    ).toMatchObject([{ id: 'gui-003' }]);

    const removed = await decided('bulk_delete_cases', {
      projectPath: projectDir,
      groupId: 'gui',
      caseIds: ['gui-002'],
    });
    expect(removed.card.risk).toBe('danger');
    expect(removed.result.result).toEqual({ deleted: 1 });
    expect(groupCases().map((item) => item.id)).toEqual(['gui-001']);
  });

  it('set_draft_auto_accept and rollback_draft: toggle written; accepted draft undone', async () => {
    const on = await decided('set_draft_auto_accept', { projectPath: projectDir, enabled: true });
    expect(on.result.result).toEqual({ autoAccept: true });
    expect((await view()).autoAcceptDrafts).toBe(true);
    const same = (
      await call('set_draft_auto_accept', { projectPath: projectDir, enabled: true })
    ).json<PanelActionResult>();
    expect(same.message).toContain('Nothing would change');

    writeFileSync(
      join(testsDir(), 'drafts', `${DRAFT_RUN}.draft.json`),
      JSON.stringify({
        version: 1,
        runId: DRAFT_RUN,
        createdAt: '2026-09-28T09:00:00.000Z',
        items: [
          { op: 'add', groupId: 'gui', caseId: 'gui-010', case: testCase('gui-010', 'Новый кейс') },
        ],
      }),
    );
    const noAccepted = (
      await call('rollback_draft', { projectPath: projectDir, runId: DRAFT_RUN })
    ).json<PanelActionResult>();
    expect(noAccepted.message).toContain('no accepted cases');
    expect(
      (
        await human('POST', '/api/project-tests/draft/apply', {
          path: projectDir,
          runId: DRAFT_RUN,
        })
      ).statusCode,
    ).toBe(200);
    expect(groupCases().map((item) => item.id)).toContain('gui-010');

    const undone = await decided('rollback_draft', { projectPath: projectDir, runId: DRAFT_RUN });
    expect(undone.card.risk).toBe('danger');
    expect(undone.result.result).toMatchObject({ removed: 1 });
    expect(groupCases().map((item) => item.id)).not.toContain('gui-010');
  });
});
