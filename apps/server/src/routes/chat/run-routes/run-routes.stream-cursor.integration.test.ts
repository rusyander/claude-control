import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import { sandboxRoot } from '../../../domains/chat/ChatArtifacts/ChatArtifacts.ts';
import { registerChatRunRoutes } from './run-routes.ts';

/**
 * Курсор переподключения принадлежит ХОДУ, а не разговору. Новый ход под тем же
 * ключом нумерует события с нуля, и клиент, чей поток оборвался на `seq` 40
 * прошлого хода, просил `from=40` у хода, где событий десять: не получал ни
 * его начала, ни конца — поток закрывался пустым, телефон переподключался по
 * кругу, сдавался «связь потеряна» и показывал ход только после перезапуска
 * приложения. `startedAt` в запросе называет ход, к которому относится курсор:
 * ход другой — отдаём его с начала.
 *
 * Реестр и маршрут настоящие; подменён только процесс CLI (`RunLike`).
 */
describe('маршрут потока: курсор прошлого хода', () => {
  let root: string;
  let app: FastifyInstance;
  let registry: ChatRunRegistry;
  let turn: number;
  const CHAT = 'cursor-chat';

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-cursor-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    mkdirSync(join(root, 'work'), { recursive: true });
    turn = 0;
    registry = new ChatRunRegistry((): RunLike => ({
      start: (_options, onEvent) => {
        turn += 1;
        onEvent({ kind: 'session', sessionId: CHAT, model: 'fake', tools: 0 });
        // Первый ход длинный, второй короткий: его последний seq меньше курсора первого.
        const steps = turn === 1 ? 8 : 1;
        for (let i = 0; i < steps; i += 1) {
          onEvent({ kind: 'text', text: `ход${turn}-${i};` });
        }
        onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: CHAT });
        return Promise.resolve();
      },
      stop: () => undefined,
    }));
    const ctx = {
      store: new AppStore(join(root, 'agentdeck')),
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
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
  });

  afterEach(async () => {
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(join(sandboxRoot(), CHAT), { recursive: true, force: true });
  });

  type Frame = { kind: string; seq: number; startedAt?: number; text?: string };
  const frames = (body: string): Frame[] =>
    body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)) as Frame);

  const send = async (prompt: string): Promise<Frame[]> => {
    const reply = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: CHAT, prompt, projectPath: join(root, 'work') },
    });
    expect(reply.statusCode).toBe(200);
    return frames(reply.body);
  };

  async function twoTurns(): Promise<{ lastSeq: number; firstStartedAt: number }> {
    const first = await send('первый');
    const session = first.find((frame) => frame.kind === 'session');
    expect(session?.startedAt).toEqual(expect.any(Number));
    const lastSeq = Math.max(...first.map((frame) => frame.seq));
    // Два хода в одну миллисекунду бывают только в тесте: живой ход длится секунды.
    await new Promise((done) => setTimeout(done, 5));
    const second = await send('второй');
    expect(Math.max(...second.map((frame) => frame.seq))).toBeLessThan(lastSeq);
    return { lastSeq, firstStartedAt: session?.startedAt ?? 0 };
  }

  it('курсор чужого хода: новый ход отдаётся с начала — его сессия, текст и конец', async () => {
    const { lastSeq, firstStartedAt } = await twoTurns();

    const reply = await app.inject({
      method: 'GET',
      url: `/api/chat/${CHAT}/stream?from=${lastSeq}&startedAt=${firstStartedAt}`,
    });
    const replayed = frames(reply.body);

    const session = replayed.find((frame) => frame.kind === 'session');
    expect(session?.startedAt).toBeGreaterThan(firstStartedAt);
    expect(replayed.filter((frame) => frame.kind === 'text').map((frame) => frame.text)).toEqual([
      'ход2-0;',
    ]);
    expect(replayed.at(-1)?.kind).toBe('done');
  });

  it('курсор своего хода: догоняется только пропущенное, без повтора', async () => {
    const first = await send('первый');
    const session = first.find((frame) => frame.kind === 'session');
    const text = first.filter((frame) => frame.kind === 'text');
    const cursor = text[5]?.seq ?? 0;

    const reply = await app.inject({
      method: 'GET',
      url: `/api/chat/${CHAT}/stream?from=${cursor}&startedAt=${session?.startedAt}`,
    });
    const replayed = frames(reply.body);

    expect(replayed.every((frame) => frame.seq > cursor)).toBe(true);
    expect(replayed.filter((frame) => frame.kind === 'text').map((frame) => frame.text)).toEqual([
      'ход1-6;',
      'ход1-7;',
    ]);
    expect(replayed.at(-1)?.kind).toBe('done');
  });

  it('без startedAt — прежний договор: курсор как есть (старый клиент не ломается)', async () => {
    const { lastSeq } = await twoTurns();
    const reply = await app.inject({
      method: 'GET',
      url: `/api/chat/${CHAT}/stream?from=${lastSeq}`,
    });
    expect(frames(reply.body)).toEqual([]);
  });
});
