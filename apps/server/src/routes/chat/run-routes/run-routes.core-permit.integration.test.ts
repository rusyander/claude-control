import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import { ChatRunRegistry } from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import { CORE_PERMIT_TOOL } from '../../../domains/chat/core-run/core-run.ts';
import { registerChatRunRoutes } from './run-routes.ts';

/**
 * Карточка вопроса права задачи ядра (этап 10, F2b) и маршрут решения сервера: ответ ядру шлёт
 * браузер командой ядра (`answer` — human-strict), этот маршрут ядру его не передаёт. Раньше он
 * снимал карточку брокера и отвечал «принято» — ядро ответа так и не видело, ход стоял. Теперь —
 * названный отказ 409, карточка остаётся висеть до ответа, записанного ядром. Обычная карточка
 * CLI тем же маршрутом решается как прежде.
 */

let root: string;
let app: FastifyInstance | undefined;
let registry: ChatRunRegistry | undefined;

afterEach(async () => {
  registry?.stopAll();
  await app?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function setup(): Promise<ChatSession> {
  root = mkdtempSync(join(tmpdir(), 'cc-core-permit-'));
  const appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  registry = new ChatRunRegistry();
  const ctx = {
    store: new AppStore(appData),
    location: {
      paths: {
        root,
        settings: join(root, 'settings.json'),
        settingsLocal: join(root, 'settings.local.json'),
        appData,
      },
    },
    backupDir: join(root, 'backups'),
    pricing: { current: () => ({ entries: [] }) },
    models: { current: () => ({ models: [] }) },
  } as unknown as ServerContext;
  const session = new ChatSession(registry);
  app = Fastify();
  registerChatRunRoutes(app, ctx, registry, session);
  await app.ready();
  return session;
}

const decide = (toolUseId: string) =>
  app!.inject({
    method: 'POST',
    url: '/api/chat/run-1/permission-decision',
    payload: { toolUseId, behavior: 'allow' },
  });

describe('маршрут решения карточки на вопросе права ядра', () => {
  it('вопрос ядра: 409 core_permit_browser_only, карточка брокера не снята', async () => {
    const session = await setup();
    let settled = false;
    void session
      .requestPermission({
        runId: 'run-1',
        toolName: CORE_PERMIT_TOOL,
        input: { question: 'The step needs a grant to edit src/x.ts' },
        toolUseId: 'ask-1',
      })
      .then(() => (settled = true));
    const res = await decide('ask-1');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'core_permit_browser_only',
      messageCode: 'core-permit-browser-only',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(session.pendingPermissions().map((p) => p.toolUseId)).toEqual(['ask-1']);
  });

  it('карточка CLI тем же маршрутом решается как прежде', async () => {
    const session = await setup();
    const reply = session.requestPermission({
      runId: 'run-1',
      toolName: 'Bash',
      input: { command: 'ls' },
      toolUseId: 'tu-1',
    });
    const res = await decide('tu-1');
    expect(res.statusCode).toBeLessThan(300);
    await expect(reply).resolves.toMatchObject({ behavior: 'allow' });
  });
});
