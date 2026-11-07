import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatMessagesPage, ChatSummary } from '@agentdeck/contracts';
import type { CarryApplyAnswer } from '@agentdeck/contracts/portable-carry';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { HandoffChains } from '../../domains/chat/ChatHandoff/ChatHandoff.ts';
import {
  coreChatBookPath,
  createCoreChatBook,
} from '../../domains/chat/core-run/core-chat-book.ts';
import { createCoreChatHistory } from '../../domains/chat/core-run/core-chat-history.ts';
import { CoreChatRun } from '../../domains/chat/core-run/core-run.ts';
import { coreWithTurns } from '../../domains/chat/core-run/__fixtures__/core-with-turns.ts';
import { createChat } from '../../domains/provider-chat/store/store.ts';
import { getActiveProviderId } from '../../providers/registry.ts';
import { registerChatRunRoutes } from '../chat/run-routes/run-routes.ts';
import { registerChatTranscriptRoutes } from '../chat/transcript-routes/transcript-routes.ts';
import { registerPortabilityCarryRoutes } from './portability-carry-routes.ts';

/**
 * Перенос незакрытой работы к чужому CLI (этап 11, волна 3, доводка): раньше он заводил задачу ядра
 * мимо реестра прогонов — ключ и id разговора были id задачи, записи в книге чата ядра не было, и
 * перенесённый разговор не попадал в список (боковая панель и `/api/chats/projects` телефона), не
 * открывался заново, его лента не читалась. Теперь он садится как перенос к Claude: прогон реестра
 * под ключом `new-…` → прогон ядра называет разговор id сеанса, книга помнит его.
 *
 * Настоящие: маршруты переноса, отправки и списка, хранилище разговоров чужих CLI, реестр,
 * `CoreChatRun`, файл книги, чтение истории. Подменено только ядро за HTTP (`coreWithTurns`).
 */

const ANSWER = 'готов';
const SESSION = 'qwen-carry-sess';
const TURN_AT = 1_793_989_152_846;

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 20));
  }
}

describe('перенос к чужому CLI садится как перенос к Claude', () => {
  const savedEnv = { ...process.env };
  let root: string;
  let work: string;
  let appData: string;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let app: FastifyInstance;
  let core: ReturnType<typeof coreWithTurns>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-carry-list-'));
    work = join(root, 'work');
    appData = join(root, 'agentdeck');
    const home = join(root, 'home');
    for (const dir of [work, appData, home, join(work, '.agent')])
      mkdirSync(dir, { recursive: true });
    for (const key of ['HOME', 'USERPROFILE']) process.env[key] = home;
    writeFileSync(join(work, '.agent', 'PROGRESS.md'), 'Состояние работы.\n', 'utf8');
    store = new AppStore(appData);
    core = coreWithTurns({ sessionId: SESSION, answer: ANSWER, turnAt: TURN_AT });
    const book = createCoreChatBook(coreChatBookPath(appData));
    registry = new ChatRunRegistry(
      () =>
        new CoreChatRun({
          port: core.port,
          book,
          pollMs: 5,
          activeCli: () => getActiveProviderId(store),
        }),
    );
    const ctx = {
      store,
      location: { paths: { root: join(home, '.claude'), appData } },
      backupDir: join(appData, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    const session = new ChatSession(registry);
    app = Fastify();
    registerChatRunRoutes(app, ctx, registry, session);
    registerPortabilityCarryRoutes(app, ctx, {
      runs: registry,
      chains: new HandoffChains(),
      session,
    });
    registerChatTranscriptRoutes(
      app,
      ctx,
      undefined,
      undefined,
      undefined,
      createCoreChatHistory(core.port, () => coreChatBookPath(appData)),
    );
    await app.ready();
  });

  afterEach(async () => {
    registry.stopAll();
    await app.close();
    for (const key of ['HOME', 'USERPROFILE']) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(root, { recursive: true, force: true });
  });

  const bookFile = (): Record<string, unknown> => {
    const file = coreChatBookPath(appData);
    return existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
      : {};
  };

  /** Разговор codex с одной репликой человека — источник переноса. */
  function codexChat(): string {
    const at = new Date().toISOString();
    const chat = createChat(appData, 'codex', { title: 'Переименование', workdir: work });
    const file = join(appData, 'provider-chats', 'codex', `${chat?.id}.jsonl`);
    const meta = { kind: 'meta', id: chat?.id, providerId: 'codex', title: 'Переименование' };
    const said = { kind: 'message', id: 'm1', role: 'user', content: 'переименуй foo в bar', at };
    writeFileSync(
      file,
      `${JSON.stringify({ ...meta, createdAt: at, workdir: work })}\n${JSON.stringify(said)}\n`,
    );
    return chat?.id as string;
  }

  it('Qwen активен: перенос отдаёт ключ new-…, прогон называет разговор сеансом ядра, книга его помнит; он в списке, лента читается, открытый заново — тот же шаг', async () => {
    store.updateSettings({ provider: 'qwen' });
    const source = codexChat();

    const reply = await app.inject({
      method: 'POST',
      url: '/api/portability/carry/apply',
      payload: { keys: [foreignChatKey('codex', source)] },
    });
    expect(reply.statusCode).toBe(200);
    const outcome = reply.json<CarryApplyAnswer>().outcomes[0];
    expect(outcome).toMatchObject({ carried: true, chainDepth: 1 });
    expect(outcome?.chatId).toMatch(/^new-/);

    await until(() => SESSION in bookFile());
    expect(core.calls.find((c) => c.kind === 'set-cli')?.fields).toMatchObject({ adapter: 'qwen' });
    expect(bookFile()[SESSION]).toMatchObject({ cli: 'qwen', taskId: 'stub-task-1', cwd: work });
    // Задание ушло модели целиком: опора, исходное задание, за ними инициатива панели.
    const request = core.estimates[0]?.request ?? '';
    expect(request).toContain('.agent/PROGRESS.md');
    expect(request).toContain('переименуй foo в bar');
    expect(request.indexOf('This run was started from the AgentDeck panel')).toBeGreaterThan(
      request.indexOf('переименуй foo в bar'),
    );
    await until(() => !registry.isRunning(String(outcome?.chatId)));

    const projects = (await app.inject({ url: '/api/chats/projects' })).json<
      Array<{ path: string; chats: Array<{ id: string; title: string; messageCount: number }> }>
    >();
    const row = projects.find((p) => p.path === work)?.chats.find((c) => c.id === SESSION);
    expect(row).toMatchObject({ messageCount: 2 });
    expect(row?.title).not.toContain('This run was started');
    const chats = (await app.inject({ url: '/api/chats' })).json<ChatSummary[]>();
    expect(chats.find((c) => c.id === SESSION)).toMatchObject({ projectPath: work });

    const feed = (
      await app.inject({ url: `/api/chats/${SESSION}/messages` })
    ).json<ChatMessagesPage>();
    expect(feed.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(feed.messages[0]?.blocks)).toContain('PROGRESS.md');
    expect(JSON.stringify(feed.messages[0]?.blocks)).not.toContain('This run was started');

    void app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: SESSION, sessionId: SESSION, prompt: 'ист-8', projectPath: work },
    });
    await until(() => core.calls.some((c) => c.kind === 'message-to-step'));
    expect(core.estimates).toHaveLength(1);
    expect(core.calls.filter((c) => c.kind === 'message-to-step')).toEqual([
      expect.objectContaining({
        taskId: 'stub-task-1',
        fields: expect.objectContaining({ stepId: 'stub-task-1-chat', text: 'ист-8' }),
      }),
    ]);
  });
});
