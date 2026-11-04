import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PanelAgentConversation, PanelAgentRunEvent } from '@agentdeck/contracts/panel-agent';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import { createBridgeTokenLedger } from '../../../lib/bridge-tokens/bridge-tokens.ts';
import { PanelPendingActions } from '../../../domains/panel-agent/pending/pending.ts';
import { createCoreAskPort } from '../../../domains/core-ask/core-ask.ts';
import { startFakeCore, type FakeCore } from '../../../domains/core-ask/__fixtures__/fake-core.ts';
import { registerPanelAgentRunRoutes, type PanelAgentRunRouteDeps } from './run-routes.ts';

/**
 * F-101 D3: телефон на Android 15+ теряет сеть через секунды после ухода в фон,
 * поток хода рвётся — и ход агента панели умирал вместе с запросом. Ход с
 * `detach` переживает обрыв, клиент возвращается за кадрами по номеру.
 *
 * Настоящий маршрут на настоящем сокете (`listen` + `fetch` с обрывом). Ход идёт сессией
 * ядра (этап 10, F2): ядро — заглушка на настоящем HTTP, «процесс жив» = сессия заглушки
 * ещё идёт, «ход снят» = ядру пришла команда `cancel` и сессия кончилась.
 */
interface Frame {
  seq?: number;
  event: PanelAgentRunEvent;
}

/** Кадры SSE: `data:` и необязательный `id:` в любом порядке. */
function parseFrames(text: string): Frame[] {
  return text
    .split('\n\n')
    .map((part) => {
      const lines = part.split('\n');
      const data = lines.find((line) => line.startsWith('data: '));
      const id = lines.find((line) => line.startsWith('id: '));
      if (!data) return undefined;
      return {
        ...(id ? { seq: Number(id.slice(4)) } : {}),
        event: JSON.parse(data.slice(6)) as PanelAgentRunEvent,
      };
    })
    .filter((frame): frame is Frame => frame !== undefined);
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const REPLY = 'Вы в разделе проектов.';

describe('ход агента панели переживает обрыв (detach)', () => {
  let appData: string;
  let store: AppStore;
  let app: FastifyInstance;
  let base: string;
  let core: FakeCore;
  /** Пауза сессии после действия, до ответа. */
  let slowAfterMs = 0;

  const build = async (extra: Partial<PanelAgentRunRouteDeps> = {}): Promise<void> => {
    const ctx = { store, location: { paths: { appData } } } as unknown as ServerContext;
    app = Fastify();
    registerPanelAgentRunRoutes(app, ctx, {
      selfBaseUrl: 'http://127.0.0.1:5211',
      ask: createCoreAskPort(() => core.home, core.identity),
      bridges: createBridgeTokenLedger(),
      pending: new PanelPendingActions(10_000),
      pollMs: 20,
      ...extra,
    });
    base = await app.listen({ host: '127.0.0.1', port: 0 });
  };

  beforeEach(async () => {
    appData = mkdtempSync(join(tmpdir(), 'cc-agent-detach-appdata-'));
    store = new AppStore(appData);
    slowAfterMs = 0;
    core = await startFakeCore({
      turn: async ({ emit, cancelled }) => {
        emit({
          kind: 'tool-call',
          data: { toolUseId: 't1', name: 'mcp__panel-bridge__where_am_i', input: {} },
        });
        emit({ kind: 'tool-result', data: { toolUseId: 't1', isError: false } });
        const stop = cancelled.then(() => 'cancelled' as const);
        if (slowAfterMs && (await Promise.race([wait(slowAfterMs), stop]))) return;
        emit({ kind: 'assistant-text', data: { text: REPLY } });
        emit({ kind: 'turn-end', data: { isError: false, numTurns: 1 } });
      },
    });
  });

  afterEach(async () => {
    await app.close();
    await core.close();
    rmSync(appData, { recursive: true, force: true });
  });

  const body = (detach: boolean) => ({
    conversationId: 'conv-d',
    messages: [{ role: 'user', content: 'Где я?' }],
    context: { route: '/projects' },
    ...(detach ? { detach: true } : {}),
  });

  /** Начать ход, прочитать первые кадры и оборвать запрос, как ОС у телефона в фоне. */
  async function startAndDrop(detach: boolean): Promise<Frame[]> {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/agent/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body(detach)),
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    // До результата действия: ход идёт, ответа ещё нет (пауза сессии).
    while (!parseFrames(text).some((frame) => frame.event.kind === 'tool-result')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();
    await reader.cancel().catch(() => undefined);
    return parseFrames(text);
  }

  const settled = async (): Promise<void> => {
    for (let i = 0; i < 150 && core.running.size > 0; i += 1) await wait(20);
  };
  const stored = () =>
    JSON.parse(
      readFileSync(join(appData, 'panel-agent', 'conv-d.json'), 'utf8'),
    ) as PanelAgentConversation;

  it('обрыв не снимает ход; вернувшийся клиент получает кадры после своего номера и ответ', async () => {
    slowAfterMs = 1500;
    await build();
    const seen = await startAndDrop(true);
    expect(seen.every((frame) => typeof frame.seq === 'number')).toBe(true);
    const last = seen.at(-1)!.seq!;
    await wait(300);
    expect(core.running.size).toBe(1); // сессия жива после обрыва
    expect(core.cancels).toEqual([]);

    const response = await fetch(`${base}/api/agent/run/conv-d/stream?fromSeq=${last}`);
    expect(response.status).toBe(200);
    const rest = parseFrames(await response.text());
    expect(rest[0]?.seq).toBe(last + 1);
    expect(rest.map((frame) => frame.event.kind)).toContain('done');
    expect(stored().messages.at(-1)).toMatchObject({ role: 'assistant', content: REPLY });
  });

  it('без detach обрыв снимает ход, как прежде, и кадры идут без номеров', async () => {
    slowAfterMs = 1500;
    await build();
    const seen = await startAndDrop(false);
    expect(seen.some((frame) => frame.seq !== undefined)).toBe(false);
    await settled();
    expect(core.running.size).toBe(0);
    expect(core.cancels).toHaveLength(1);
    expect((await fetch(`${base}/api/agent/run/conv-d/stream?fromSeq=0`)).status).toBe(404);
    expect(stored().messages.at(-1)?.content).not.toBe(REPLY);
  });

  it('никто не вернулся за срок — ход снят сам', async () => {
    slowAfterMs = 4000;
    await build({ detachGraceMs: 200 });
    await startAndDrop(true);
    await settled();
    expect(core.running.size).toBe(0);
    expect(core.cancels).toHaveLength(1);
    expect(stored().messages.at(-1)?.content).not.toBe(REPLY);
  });

  it('«Стоп» отцепленного хода — отдельным запросом', async () => {
    slowAfterMs = 4000;
    await build();
    await startAndDrop(true);
    const stop = await fetch(`${base}/api/agent/run/conv-d/stop`, { method: 'POST' });
    expect(stop.status).toBe(200);
    await settled();
    expect(core.running.size).toBe(0);
    expect(core.cancels).toHaveLength(1);
    await wait(50);
    expect((await fetch(`${base}/api/agent/run/conv-d/stop`, { method: 'POST' })).status).toBe(404);
  });

  it('законченный ход ещё отдаёт кадры опоздавшему; чужой разговор — 404', async () => {
    await build();
    await startAndDrop(true);
    await settled();
    await wait(50);
    const late = parseFrames(
      await (await fetch(`${base}/api/agent/run/conv-d/stream?fromSeq=0`)).text(),
    );
    expect(late[0]?.event.kind).toBe('start');
    expect(late.at(-1)?.event.kind).toBe('done');
    expect((await fetch(`${base}/api/agent/run/other/stream`)).status).toBe(404);
  });
});
