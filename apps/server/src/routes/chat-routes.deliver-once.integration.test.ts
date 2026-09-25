import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { createHandoffPlanner } from './chat/handoff-routes.ts';
import { registerChatRunRoutes } from './chat/run-routes.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import { HandoffChains } from '../domains/chat/ChatHandoff.ts';
import { sandboxRoot } from '../domains/chat/ChatArtifacts.ts';
import type { ChatLink } from '../lib/app-store/app-store.types.ts';

/**
 * Доставка — не чаще раза на круг цепочки (решение владельца, W3-3, открытый
 * вопрос 3 WP9f). Человек написал в законченный чат правок — ход кончился, и
 * планировщик заводил ВТОРОЕ звено доставки той же работы: второй пуш, второе
 * описание MR, подписка на ветер. Второй раз доставка заводится, только когда
 * человек сам её попросил.
 *
 * Путь настоящий: маршрут отправки сообщения → реестр → планировщик звеньев →
 * связи в хранилище на диске. Подменён только процесс CLI.
 */

const CHAT = 'чат-правки-доставка';

const FIX_LINK: ChatLink = {
  parentChatId: 'родитель',
  createdAt: '2026-09-25T10:00:00.000Z',
  title: 'Переименования',
  branch: 'split/rename',
  groupIndex: 0,
  model: 'sonnet',
  effort: 'medium',
  kind: 'mechanical',
  lowered: true,
  stage: 'fix',
  ceilingModel: 'claude-opus-5',
  ceilingEffort: 'high',
  workModel: 'sonnet',
  workEffort: 'medium',
};

describe('звено доставки — раз на круг, повтор — по просьбе человека', () => {
  let root: string;
  let work: string;
  let app: FastifyInstance;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let ended: { stage?: string; status: string }[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-deliver-once-'));
    work = join(root, 'copy');
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    store = new AppStore(join(root, 'agentdeck'));
    ended = [];
    registry = new ChatRunRegistry((): RunLike => ({
      start: async (options, onEvent) => {
        onEvent({ kind: 'text', text: options.prompt.includes('доставка') ? 'MR: !9' : 'Готово.' });
        onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 's' });
      },
      stop: () => undefined,
    }));
    registry.setHandoffPlanner(
      createHandoffPlanner({
        runs: registry,
        chains: new HandoffChains(),
        session: new ChatSession(registry),
        selfBaseUrl: 'http://127.0.0.1:5178',
        cascade: {
          linkOf: (aliases) => aliases.map((key) => store.getChatLink(key)).find(Boolean),
          saveLink: (chatId, link) => store.setChatLink(chatId, link),
          markReviewed: () => undefined,
          hasWork: () => true,
          settings: () => ({ taskSplitInitiative: true, handoffInitiative: false }),
        },
        split: {
          onTriageFinished: () => undefined,
          onChainEnded: (link, outcome) =>
            void ended.push({
              ...(link.stage ? { stage: link.stage } : {}),
              status: outcome.status,
            }),
          delivers: () => true,
        },
      }),
    );
    const ctx = {
      store,
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
          appData: join(root, 'agentdeck'),
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerChatRunRoutes(app, ctx, registry, new ChatSession(registry));
    await app.ready();
    store.setChatLink(CHAT, FIX_LINK);
  });

  afterEach(async () => {
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(join(sandboxRoot(), CHAT), { recursive: true, force: true });
  });

  /** Сообщение человека в чат правок — и дождаться звеньев, которые оно завело. */
  async function say(prompt: string): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: CHAT, prompt, projectPath: work },
    });
    expect(response.statusCode).toBe(200);
    await new Promise((done) => setTimeout(done, 50));
  }

  const delivers = (): ChatLink[] =>
    Object.values(store.getChatLinks()).filter((link) => link.stage === 'deliver');

  it('второе сообщение в законченный чат правок второй доставки не заводит', async () => {
    await say('Поправь по замечаниям ревью');
    expect(delivers()).toHaveLength(1);

    await say('А тесты точно прошли?');

    // Ни звена, ни события: круг уже доставлен. Итог хода группе — как обычно.
    expect(delivers()).toHaveLength(1);
    expect(store.getChatLink(CHAT)?.deliveredAt).toBeTruthy();
    expect(ended.at(-1)).toEqual({ stage: 'fix', status: 'done' });
  });

  it('человек просит доставить снова — доставка заводится ещё раз', async () => {
    await say('Поправь по замечаниям ревью');
    await say('Доставь ещё раз: MR не обновился');

    expect(delivers()).toHaveLength(2);
  });
});
