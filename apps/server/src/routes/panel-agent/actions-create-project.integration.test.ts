import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectAdded } from '@agentdeck/contracts';
import type { PanelActionResult, PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerAccessGate } from '../../lib/access-gate.ts';
import { registerEmptyBodyGuard } from '../../lib/empty-body.ts';
import { createEventHub } from '../../lib/event-hub.ts';
import { allowedOrigins } from '../../lib/origin-guard.ts';
import { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { ProjectTestManualRegistry, ProjectTestRunRegistry } from '../../domains/project-tests.ts';
import { registerProjectRoutes } from '../project-routes.ts';
import { registerProjectTestsRoutes } from '../project-tests-routes.ts';
import { registerPanelAgentRoutes } from './panel-agent-routes.ts';

/**
 * `create_project` — не только запись в реестре: маршрут добавления сводит
 * свою папку e2e в кейсы или заводит заготовку со строкой в
 * `.git/info/exclude`. Карточка обязана назвать это ДО клика, а итог — дойти
 * до модели целиком (у действия нет `shape`, режущего тело ответа).
 */
const ORIGIN = 'http://localhost:8888';

describe('panel-agent create_project: папка e2e на карточке и в итоге', () => {
  let appData = '';
  let project = '';
  let app: FastifyInstance;
  let pending: PanelPendingActions;

  const boot = async (withTests: boolean): Promise<void> => {
    const store = new AppStore(appData);
    const ctx = {
      store,
      backupDir: join(appData, 'backups'),
      location: {
        paths: { root: appData, appData, settings: join(appData, 'settings.json') },
      },
    } as unknown as ServerContext;
    const access = {
      allowedOrigins: allowedOrigins(8888),
      requiresToken: () => false,
      expectedToken: () => '',
    };
    pending = new PanelPendingActions(10_000);
    app = Fastify();
    registerAccessGate(app, access);
    registerEmptyBodyGuard(app);
    registerProjectRoutes(app, ctx);
    if (withTests) {
      registerProjectTestsRoutes(
        app,
        ctx,
        new ProjectTestRunRegistry(),
        new ProjectTestManualRegistry(),
      );
    }
    registerPanelAgentRoutes(app, ctx, { hub: createEventHub(), pending, access });
    await app.ready();
  };

  beforeEach(() => {
    appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-create-project-data-')));
    project = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-create-project-')));
  });

  afterEach(async () => {
    pending.cancelAll();
    await app.close();
    for (const dir of [appData, project]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  const call = (input: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/agent/actions/create_project',
      headers: { [PANEL_AGENT_HEADER]: '1' },
      payload: { input, conversationId: 'conv-create' },
    });

  const waitPending = async (): Promise<PanelPendingAction> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const [first] = (await app.inject({ method: 'GET', url: '/api/agent/pending' })).json<
        PanelPendingAction[]
      >();
      if (first) return first;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('карточка так и не появилась');
  };

  const approve = (id: string) =>
    app.inject({
      method: 'POST',
      url: `/api/agent/pending/${id}`,
      headers: { origin: ORIGIN },
      payload: { decision: 'approve' },
    });

  const e2eField = (card: PanelPendingAction) =>
    card.preview.fields.find((item) => item.labelCode === 'label-e2e-folder');

  it('своей папки нет, проект под git — карточка называет заготовку и строку exclude, итог доходит до модели', async () => {
    await boot(true);
    spawnSync('git', ['init', '-q'], { cwd: project });
    const running = call({ path: project });
    const card = await waitPending();
    expect(e2eField(card)).toMatchObject({
      valueCode: 'value-e2e-onboard-create',
      valueParams: { dir: 'e2e' },
    });
    expect(e2eField(card)?.value).toContain('.git/info/exclude');
    // До клика в проекте ничего не появилось: карточка лишь называет исход.
    expect(existsSync(join(project, 'e2e'))).toBe(false);

    await approve(card.id);
    const result = (await running).json<PanelActionResult>();
    expect(result.outcome).toBe('done');
    expect((result.result as ProjectAdded).e2e).toEqual({
      state: 'created',
      dir: 'e2e',
      excluded: true,
    });
    expect(existsSync(join(project, 'e2e', 'playwright.config.ts'))).toBe(true);
    expect(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8')).toContain('/e2e');
  });

  it('F-290: непригодный путь — отказ агенту по-английски, до карточки', async () => {
    await boot(false);
    for (const path of ['relative/dir', join(project, 'nope')]) {
      const result = (await call({ path })).json<PanelActionResult>();
      expect(result.outcome).toBe('failed');
      expect(result.message).toContain('Ask the human');
      expect((result.message ?? '').replace(path, '')).not.toMatch(/[а-яё]/i);
    }
  });

  it('проект не под git — заготовка без обещания строки exclude', async () => {
    await boot(true);
    const running = call({ path: project });
    const card = await waitPending();
    expect(e2eField(card)).toMatchObject({ valueCode: 'value-e2e-onboard-create-plain' });
    expect(e2eField(card)?.value).not.toContain('exclude');
    pending.cancelAll();
    await running;
  });

  it('своя папка с тестами — карточка называет сверку в кейсы с числом файлов', async () => {
    await boot(true);
    mkdirSync(join(project, 'tests', 'e2e'), { recursive: true });
    writeFileSync(join(project, 'playwright.config.ts'), 'export default {};\n');
    writeFileSync(join(project, 'tests', 'e2e', 'login.spec.ts'), "test('вход', () => {});\n");
    writeFileSync(join(project, 'tests', 'e2e', 'cart.spec.ts'), "test('корзина', () => {});\n");
    const running = call({ path: project });
    const card = await waitPending();
    expect(e2eField(card)).toMatchObject({
      valueCode: 'value-e2e-onboard-sync',
      valueParams: { dir: 'tests/e2e', count: 2 },
    });

    await approve(card.id);
    const result = (await running).json<PanelActionResult>();
    expect((result.result as ProjectAdded).e2e).toMatchObject({
      state: 'found',
      dir: 'tests/e2e',
      sync: { tests: 2 },
    });
  });

  it('своя папка без тестов — остаётся как есть', async () => {
    await boot(true);
    mkdirSync(join(project, 'e2e'), { recursive: true });
    writeFileSync(join(project, 'playwright.config.ts'), 'export default {};\n');
    const running = call({ path: project });
    const card = await waitPending();
    expect(e2eField(card)).toMatchObject({
      valueCode: 'value-e2e-onboard-keep',
      valueParams: { dir: 'e2e' },
    });
    pending.cancelAll();
    await running;
  });

  it('вид папки не прочёлся — общая строка обоих исходов, а не молчание', async () => {
    await boot(false);
    const running = call({ path: project });
    const card = await waitPending();
    expect(e2eField(card)).toMatchObject({ valueCode: 'value-e2e-onboard-maybe' });
    pending.cancelAll();
    await running;
  });
});
