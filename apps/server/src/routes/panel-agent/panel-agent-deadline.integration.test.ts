import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import {
  PANEL_ACTION_CONFIRM_TIMEOUT_MS,
  PANEL_AGENT_FIXED_TOOL_TIMEOUT_MS,
  panelAgentConfirmTimeoutMs,
} from '@agentdeck/contracts/panel-agent';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerAccessGate } from '../../lib/access-gate/access-gate.ts';
import {
  BRIDGE_TOKEN_HEADER,
  createBridgeTokenLedger,
} from '../../lib/bridge-tokens/bridge-tokens.ts';
import { registerEmptyBodyGuard } from '../../lib/empty-body.ts';
import { createEventHub } from '../../lib/event-hub/event-hub.ts';
import { allowedOrigins } from '../../lib/origin-guard/origin-guard.ts';
import { PanelPendingActions } from '../../domains/panel-agent/pending/pending.ts';
import { createCoreAskPort } from '../../domains/core-ask/core-ask.ts';
import { startFakeCore, type FakeCore } from '../../domains/core-ask/__fixtures__/fake-core.ts';
import { registerProjectRoutes } from '../project-routes/project-routes.ts';
import { registerPanelAgentRoutes } from './panel-agent-routes/panel-agent-routes.ts';
import { registerPanelAgentRunRoutes } from './run-routes/run-routes.ts';

/**
 * Срок карточки в ходе агента — по CLI (Z-fix 4, 07.10.2026). Карточка Goose
 * обещала 10 минут, а вызов моста у Goose ждёт 300 с: через пять минут
 * карточку снимал обрыв, и срок в ней был неправдой.
 *
 * Ход идёт сессией ядра (этап 10, F2): CLI хода — поле `adapter` вопроса ядру; ядро —
 * заглушка на настоящем HTTP, её сессия зовёт панель тем же путём, что мост `panel.mjs`
 * (`POST /api/agent/actions/:name` с токеном моста по сокету). Свидетель — срок карточки,
 * которую увидел бы человек (`expiresAt − createdAt`).
 */
const ORIGIN = 'http://localhost:8888';

describe('срок карточки в ходе агента — по CLI', () => {
  let root: string;
  let projectDir: string;
  let store: AppStore;
  let pending: PanelPendingActions;
  let app: FastifyInstance;
  let base: string;
  let core: FakeCore;
  let bridgeStatus: number | undefined;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-agent-deadline-'));
    projectDir = join(root, 'project');
    mkdirSync(projectDir, { recursive: true });
    bridgeStatus = undefined;
    core = await startFakeCore({
      turn: async ({ fields, emit }) => {
        emit({
          kind: 'tool-call',
          data: { toolUseId: 't1', name: 'mcp__panel-bridge__create_project', input: {} },
        });
        const answer = await fetch(`${fields.panelBridge!.url}/api/agent/actions/create_project`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-agentdeck-agent': '1',
            [BRIDGE_TOKEN_HEADER]: fields.panelBridge!.token,
          },
          body: JSON.stringify({
            input: { path: projectDir, name: 'Демо' },
            conversationId: fields.panelBridge!.conversation,
          }),
        });
        bridgeStatus = answer.status;
        emit({ kind: 'tool-result', data: { toolUseId: 't1', isError: !answer.ok } });
        emit({ kind: 'assistant-text', data: { text: 'Отклонено.' } });
        emit({ kind: 'turn-end', data: { isError: false, numTurns: 1 } });
      },
    });

    const appData = join(root, 'appdata');
    store = new AppStore(appData);
    // Общий срок — как у панели (`runtime.ts`): ход сокращает его для своего CLI.
    pending = new PanelPendingActions(PANEL_ACTION_CONFIRM_TIMEOUT_MS);
    const ctx = {
      store,
      backupDir: join(appData, 'backups'),
      location: { paths: { appData } },
    } as unknown as ServerContext;
    const bridges = createBridgeTokenLedger();
    const access = {
      allowedOrigins: allowedOrigins(8888),
      requiresToken: () => false,
      expectedToken: () => '',
      bridges,
    };
    app = Fastify();
    registerAccessGate(app, access);
    registerEmptyBodyGuard(app);
    registerProjectRoutes(app, ctx);
    registerPanelAgentRoutes(app, ctx, { hub: createEventHub(), pending, access, bridges });
    // Адрес моста известен только после listen — маршрут хода берёт его поздно.
    let self = '';
    registerPanelAgentRunRoutes(app, ctx, {
      get selfBaseUrl() {
        return self;
      },
      ask: createCoreAskPort(() => core.home, core.identity),
      bridges,
      pending,
      pollMs: 20,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    self = base;
  });

  afterEach(async () => {
    pending.cancelAll();
    await app.close();
    await core.close();
    rmSync(root, { recursive: true, force: true });
  });

  const startRun = (): Promise<string> =>
    fetch(`${base}/api/agent/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'conv-deadline',
        context: { route: '/projects' },
        messages: [{ role: 'user', content: 'Заведи проект' }],
      }),
    }).then((response) => response.text());

  // Ход кончился без карточки — его кадры и есть объяснение, почему.
  const waitCard = async (done: Promise<string>) => {
    let payload: string | undefined;
    void done.then((text) => {
      payload = text;
    });
    for (let i = 0; i < 300 && payload === undefined; i += 1) {
      const [card] = pending.list();
      if (card) return card;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`карточка не появилась: ${payload ?? 'ход ещё идёт'}`);
  };

  it('Goose: карточка хода истекает раньше, чем Goose бросает вызов', async () => {
    store.updateSettings({ provider: 'goose' });
    const done = startRun();
    const card = await waitCard(done);
    const lifetime = Date.parse(card.expiresAt) - Date.parse(card.createdAt);

    // Срок — из одного места, и он меньше ожидания вызова у самого Goose.
    expect(lifetime).toBe(panelAgentConfirmTimeoutMs('goose'));
    expect(lifetime).toBeLessThan(PANEL_AGENT_FIXED_TOOL_TIMEOUT_MS.goose!);
    expect(lifetime).toBeLessThan(PANEL_ACTION_CONFIRM_TIMEOUT_MS);
    expect(card.conversationId).toBe('conv-deadline');
    // CLI хода — тот, что назван ядру.
    expect(core.asks[0]?.adapter).toBe('goose');

    const decided = await fetch(`${base}/api/agent/pending/${card.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ decision: 'reject' }),
    });
    expect(decided.status).toBe(200);
    expect(await done).toContain('"kind":"done"');
    expect(bridgeStatus).toBe(200);
    // Ход закончился — карточки разговора снова на общем сроке.
    const after = pending.create({
      name: 'save_rule',
      risk: 'change',
      conversationId: 'conv-deadline',
      preview: { summary: 'x', fields: [] },
    });
    expect(Date.parse(after.pending.expiresAt) - Date.parse(after.pending.createdAt)).toBe(
      PANEL_ACTION_CONFIRM_TIMEOUT_MS,
    );
    pending.cancel(after.pending.id);
    // Отклонено — проект не заведён.
    expect(store.getState().projects ?? []).toEqual([]);
  }, 60_000);

  it('Claude: карточка хода — на общем сроке', async () => {
    const done = startRun();
    const card = await waitCard(done);
    expect(Date.parse(card.expiresAt) - Date.parse(card.createdAt)).toBe(
      PANEL_ACTION_CONFIRM_TIMEOUT_MS,
    );
    pending.cancel(card.id);
    await done;
  }, 60_000);

  it('срок по CLI: у задающих ожидание — общий потолок, у Goose — на запас короче 300 с', () => {
    for (const dialect of ['claude', 'qwen', 'codex', 'gemini', 'opencode', 'kimi', undefined]) {
      expect(panelAgentConfirmTimeoutMs(dialect)).toBe(PANEL_ACTION_CONFIRM_TIMEOUT_MS);
    }
    expect(panelAgentConfirmTimeoutMs('goose')).toBe(4 * 60_000);
  });
});
