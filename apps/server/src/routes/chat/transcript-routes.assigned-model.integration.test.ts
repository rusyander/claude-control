import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatSummary } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerChatTranscriptRoutes } from './transcript-routes.ts';

/**
 * Назначенная модель разговора в списке (W3-5): шапка чата группы должна
 * показывать и слать ту модель, на которой панель завела группу, а не модель
 * из настроек. Поле отдельное от `model` («чем шёл»): транскрипт знает, чем
 * разговор ответил, а связь — чем панель велела ему идти.
 * Маршрут настоящий, транскрипт — настоящий файл на диске.
 */
describe('GET /api/chats — назначенная модель', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-chat-model-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    store = new AppStore(join(root, 'agentdeck'));
    const ctx = {
      store,
      location: { paths: { root, appData: join(root, 'agentdeck') } },
      pricing: { current: () => ({ entries: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerChatTranscriptRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  function transcript(chatId: string): void {
    const dir = join(root, 'projects', 'proj');
    mkdirSync(dir, { recursive: true });
    const record = {
      type: 'user',
      uuid: `u-${chatId}`,
      sessionId: chatId,
      cwd: join(root, 'work'),
      timestamp: '2026-09-25T10:00:00.000Z',
      message: { role: 'user', content: 'Поправь вход' },
    };
    writeFileSync(join(dir, `${chatId}.jsonl`), `${JSON.stringify(record)}\n`);
  }

  async function chat(chatId: string): Promise<ChatSummary | undefined> {
    const response = await app.inject({ method: 'GET', url: '/api/chats' });
    expect(response.statusCode).toBe(200);
    return response.json<ChatSummary[]>().find((item) => item.id === chatId);
  }

  it('связь с моделью — модель уходит полем assignedModel', async () => {
    transcript('g-1');
    store.setChatLink('g-1', {
      parentChatId: 'parent-1',
      groupIndex: 0,
      model: 'claude-haiku-4-5',
      effort: 'medium',
      createdAt: '2026-09-25T10:00:00.000Z',
    });

    expect(await chat('g-1')).toMatchObject({
      assignedModel: 'claude-haiku-4-5',
      effort: 'medium',
    });
  });

  it('связь без модели и чат без связи — поля нет', async () => {
    transcript('g-2');
    transcript('plain');
    store.setChatLink('g-2', {
      parentChatId: 'parent-1',
      groupIndex: 1,
      createdAt: '2026-09-25T10:00:00.000Z',
    });

    expect((await chat('g-2'))?.assignedModel).toBeUndefined();
    expect((await chat('plain'))?.assignedModel).toBeUndefined();
  });
});
