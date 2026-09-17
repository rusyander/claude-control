import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyRunEvent,
  EMPTY_CONVERSATION,
  withUserMessage,
} from '@agentdeck/contracts/panel-agent-feed';
import type { PanelAgentRunEvent } from '@agentdeck/contracts/panel-agent';

/**
 * Ход агента с телефона: настоящий разбор потока и лента из контрактов, подменён
 * только сокет (`expo/fetch`) — ответ собран из байтов, как их шлёт сервер.
 */

const fetchMock = vi.fn();
vi.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => fetchMock(...args) }));
vi.mock('../../shared/api/client', () => ({
  apiUrl: (path: string) => `http://panel/api${path}`,
  authHeaders: () => ({ Authorization: 'Bearer phone-token' }),
}));

const { runPanelAgent } = await import('./run');

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const frame = (event: PanelAgentRunEvent): string => `data: ${JSON.stringify(event)}\n\n`;

describe('ход агента панели с телефона', () => {
  beforeEach(() => fetchMock.mockReset());

  it('несёт токен и контекст телефона, кадры разрезаны где угодно — лента та же', async () => {
    const whole =
      ': ping\n\n' +
      frame({ kind: 'start', conversationId: 'c1', providerId: 'claude' }) +
      frame({ kind: 'text', text: 'Готовлю.' }) +
      frame({ kind: 'tool', name: 'create_project' }) +
      frame({ kind: 'done', reply: 'Готовлю.' });
    const cut = Math.floor(whole.length / 3);
    fetchMock.mockResolvedValue(
      new Response(
        streamOf([whole.slice(0, cut), whole.slice(cut, cut * 2), whole.slice(cut * 2)]),
      ),
    );

    let state = withUserMessage(EMPTY_CONVERSATION, 'создай проект');
    const outcome = await runPanelAgent(
      { messages: state.messages, context: { route: 'phone' } },
      (event) => {
        state = applyRunEvent(state, event);
      },
      new AbortController().signal,
    );

    expect(outcome).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://panel/api/agent/run');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer phone-token');
    expect(JSON.parse(String(init.body)).context.route).toBe('phone');
    expect(state.conversationId).toBe('c1');
    expect(state.running).toBe(false);
    expect(state.feed.map((item) => item.kind)).toEqual(['user', 'assistant', 'tool']);
    expect(state.messages.at(-1)).toEqual({ role: 'assistant', content: 'Готовлю.' });
  });

  it('отказ до запуска отдаёт код сервера', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'cli_not_found', message: 'нет claude' }), {
        status: 409,
      }),
    );
    const outcome = await runPanelAgent(
      { messages: [{ role: 'user', content: 'x' }], context: { route: 'phone' } },
      () => undefined,
      new AbortController().signal,
    );
    expect(outcome).toEqual({
      ok: false,
      code: 'cli_not_found',
      status: 409,
      message: 'нет claude',
    });
  });

  it('поток без итогового кадра — обрыв, а не успех', async () => {
    fetchMock.mockResolvedValue(new Response(streamOf([frame({ kind: 'text', text: 'нач' })])));
    const outcome = await runPanelAgent(
      { messages: [{ role: 'user', content: 'x' }], context: { route: 'phone' } },
      () => undefined,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ ok: false, code: 'cut' });
  });

  it('кадр error завершает ход с его текстом', async () => {
    fetchMock.mockResolvedValue(
      new Response(streamOf([frame({ kind: 'error', message: 'упал' })])),
    );
    const outcome = await runPanelAgent(
      { messages: [{ role: 'user', content: 'x' }], context: { route: 'phone' } },
      () => undefined,
      new AbortController().signal,
    );
    expect(outcome).toEqual({ ok: false, message: 'упал' });
  });
});
