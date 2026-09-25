import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderChatSummary } from '@agentdeck/contracts';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { ProviderChatService } from '../domains/provider-chat.ts';
import type { ProviderChatRunEvent, ProviderChatRunLike } from '../domains/provider-chat.ts';
import { HandoffChains } from '../domains/chat/ChatHandoff.ts';
import {
  SplitConveyor,
  type SplitConveyorDeps,
  type SplitConveyorStore,
} from '../domains/chat/split-conveyor.ts';
import { pauseOnForeignStop } from './chat/split-control-routes.ts';
import { registerProviderChatRoutes } from './provider-chat-routes.ts';

/**
 * «Стоп» в чате группы ЧУЖОГО CLI — пауза группы, как у Claude (журнал 89c,
 * открытый вопрос 1 WP9e). Раньше кнопка гасила прогон, а группа оставалась
 * «работает»: место в очереди держала, повтор сбоя её будил, хаб врал.
 *
 * Путь настоящий: маршрут остановки → служба чужих чатов → слушатель → конвейер
 * → хранилище на диске. Подменён только процесс CLI (идёт, пока не остановят).
 */

/** Первые реплики истории каждого запуска: там едут инициативы панели. */
const prefixes: string[] = [];

class HangingRun implements ProviderChatRunLike {
  private done?: () => void;

  start(options: unknown, _onEvent: (event: ProviderChatRunEvent) => void): Promise<void> {
    prefixes.push((options as { systemPrefix?: string }).systemPrefix ?? '');
    return new Promise<void>((resolve) => {
      this.done = resolve;
    });
  }

  stop(): void {
    this.done?.();
  }
}

describe('чужой CLI: «Стоп» в чате группы — пауза группы', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;
  let chats: ProviderChatService;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-pstop-'));
    const appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    store = new AppStore(appData);
    store.updateSettings({ provider: 'codex' });
    const plans: SplitConveyorStore = {
      get: (parent) => store.getSplitPlan(parent),
      set: (record) => store.setSplitPlan(record),
      findByTriage: (ids) => store.findSplitPlanByTriage(ids),
      all: () => store.getSplitPlans(),
    };
    const conveyor = new SplitConveyor({
      store: plans,
      log: () => undefined,
    } as unknown as SplitConveyorDeps);
    chats = new ProviderChatService(() => new HangingRun());
    // Та же связка, что в `bootstrap/runtime.ts`.
    chats.setHumanStopListener(pauseOnForeignStop(store, conveyor));
    app = Fastify();
    const ctx = {
      location: { paths: { root, appData } },
      store,
      models: { current: () => ({ models: [] }) },
      backupDir: join(appData, 'backups'),
    } as unknown as ServerContext;
    registerProviderChatRoutes(app, ctx, chats, new HandoffChains());
    await app.ready();
  });

  afterEach(async () => {
    chats.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** Разговор с идущим ответом; `group` — сделать его чатом группы разделения. */
  async function running(group: boolean, send = true): Promise<string> {
    const chat = (
      await app.inject({ method: 'POST', url: '/api/provider-chat/chats', payload: {} })
    ).json<ProviderChatSummary>();
    const key = foreignChatKey('codex', chat.id);
    if (group) {
      store.setSplitPlan({
        parentChatId: 'codex:parent',
        projectPath: root,
        createdAt: '2026-09-25T10:00:00.000Z',
        order: [0],
        request: {},
        proposal: { groups: [{ title: 'Раз', branch: 'feature/one', tasks: ['PROJ-1'] }] },
        groups: [
          {
            index: 0,
            title: 'Раз',
            branch: 'feature/one',
            after: [],
            status: 'started',
            chatId: key,
          },
        ],
      });
      store.setChatLink(key, {
        parentChatId: 'codex:parent',
        createdAt: '2026-09-25T10:00:00.000Z',
        branch: 'feature/one',
        groupIndex: 0,
        stage: 'work',
      });
    }
    if (send) {
      await app.inject({
        method: 'POST',
        url: `/api/provider-chat/chats/${chat.id}/send`,
        payload: { text: 'Работай' },
      });
    }
    return chat.id;
  }

  it('ответ человека в чат группы не несёт инструкции разделения', async () => {
    prefixes.length = 0;
    await running(true);
    await running(false);

    expect(prefixes).toHaveLength(2);
    expect(prefixes[0]).not.toContain('agentdeck:split');
    // Обычный разговор её получает — проверка умеет краснеть.
    expect(prefixes[1]).toContain('agentdeck:split');
  });

  it('остановленная группа встаёт на паузу, а не остаётся «работает»', async () => {
    const id = await running(true);

    const response = await app.inject({
      method: 'POST',
      url: `/api/provider-chat/chats/${id}/stop`,
    });

    expect(response.json<{ stopped: boolean }>().stopped).toBe(true);
    const group = store.getSplitPlan('codex:parent')?.groups[0];
    expect(group?.status).toBe('paused');
    expect(group?.pausedAt).toBeTruthy();
  });

  it('обычный разговор чужого CLI останавливается, как раньше, и групп не трогает', async () => {
    const id = await running(false);

    const response = await app.inject({
      method: 'POST',
      url: `/api/provider-chat/chats/${id}/stop`,
    });

    expect(response.json<{ stopped: boolean }>().stopped).toBe(true);
    expect(store.getSplitPlans()).toEqual({});
  });

  it('гасить нечего — и паузы нет: кнопка без идущего хода группу не трогает', async () => {
    const id = await running(true, false);

    const response = await app.inject({
      method: 'POST',
      url: `/api/provider-chat/chats/${id}/stop`,
    });

    expect(response.json<{ stopped: boolean }>().stopped).toBe(false);
    expect(store.getSplitPlan('codex:parent')?.groups[0]?.status).toBe('started');
  });
});
