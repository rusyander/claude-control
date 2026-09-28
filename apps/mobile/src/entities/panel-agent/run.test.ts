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

const { STREAM_LOST, runPanelAgent } = await import('./run');

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

  it('поток без итогового кадра (панель перезапустилась) — обрыв связи, а не успех', async () => {
    fetchMock.mockResolvedValue(new Response(streamOf([frame({ kind: 'text', text: 'нач' })])));
    const outcome = await runPanelAgent(
      { messages: [{ role: 'user', content: 'x' }], context: { route: 'phone' } },
      () => undefined,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ ok: false, code: STREAM_LOST });
  });

  it('замолчавший поток кончает ход кодом stream_lost, а не висит в «Агент думает…»', async () => {
    const encoder = new TextEncoder();
    const hanging = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(frame({ kind: 'start', conversationId: 'c1', providerId: 'claude' })),
        );
      },
    });
    fetchMock.mockResolvedValue(new Response(hanging));
    const kinds: string[] = [];
    const outcome = await runPanelAgent(
      { messages: [{ role: 'user', content: 'x' }], context: { route: 'phone' } },
      (event) => kinds.push(event.kind),
      new AbortController().signal,
      40,
    );
    expect(kinds).toEqual(['start']);
    expect(outcome).toMatchObject({ ok: false, code: STREAM_LOST });
  });

  it('пинги держат ход живым: паузы короче порога, весь ход — много дольше', async () => {
    const encoder = new TextEncoder();
    const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));
    const alive = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          encoder.encode(frame({ kind: 'start', conversationId: 'c1', providerId: 'claude' })),
        );
        for (let i = 0; i < 3; i += 1) {
          await pause();
          controller.enqueue(encoder.encode(': ping\n\n'));
        }
        await pause();
        controller.enqueue(encoder.encode(frame({ kind: 'done', reply: 'Три.' })));
        controller.close();
      },
    });
    fetchMock.mockResolvedValue(new Response(alive));
    const outcome = await runPanelAgent(
      { messages: [{ role: 'user', content: 'x' }], context: { route: 'phone' } },
      () => undefined,
      new AbortController().signal,
      80,
    );
    expect(outcome).toEqual({ ok: true });
  });

  // F-101: приложение в фоне — JS спит, кадры копятся в сокете. При возврате
  // просроченный таймер тишины срабатывал раньше, чем читались накопленные
  // кадры, и живой ход обрывался (а сервер его останавливал).
  it('возврат из фона: просроченный таймер не рвёт живой ход', async () => {
    const encoder = new TextEncoder();
    const alive = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(frame({ kind: 'start', conversationId: 'c1', providerId: 'claude' })),
        );
        setTimeout(
          () =>
            setImmediate(() => {
              // «Фон»: поток JS стоит дольше двух порогов тишины подряд.
              const until = Date.now() + 150;
              while (Date.now() < until) {
                // занято
              }
              // Кадр, пришедший «пока спали», доходит уже после просроченного
              // таймера тишины — как при возврате приложения на экран.
              setTimeout(() => {
                controller.enqueue(encoder.encode(frame({ kind: 'done', reply: 'Готово.' })));
                controller.close();
              }, 0);
            }),
          5,
        );
      },
    });
    fetchMock.mockResolvedValue(new Response(alive));
    const outcome = await runPanelAgent(
      { messages: [{ role: 'user', content: 'x' }], context: { route: 'phone' } },
      () => undefined,
      new AbortController().signal,
      40,
    );
    expect(outcome).toEqual({ ok: true });
  });

  it('порванный посреди хода поток — тот же обрыв связи', async () => {
    const encoder = new TextEncoder();
    let sent = false;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(new Error('socket hang up'));
          return;
        }
        sent = true;
        controller.enqueue(encoder.encode(frame({ kind: 'text', text: 'нач' })));
      },
    });
    fetchMock.mockResolvedValue(new Response(broken));
    const outcome = await runPanelAgent(
      { messages: [{ role: 'user', content: 'x' }], context: { route: 'phone' } },
      () => undefined,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ ok: false, code: STREAM_LOST });
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
