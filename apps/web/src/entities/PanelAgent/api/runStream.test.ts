import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PanelAgentRunEvent } from '@agentdeck/contracts/panel-agent';
import { panelAgentEn } from '@shared/config/i18n/panel-agent/en';
import { panelAgentRu } from '@shared/config/i18n/panel-agent/ru';
import { STREAM_LOST, runPanelAgent } from './runStream';

const encoder = new TextEncoder();
const frame = (event: PanelAgentRunEvent): Uint8Array =>
  encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

/** Ответ сервера хода: кадры по порядку, потом — закрыть поток или замолчать. */
function streamResponse(frames: Uint8Array[], then: 'close' | 'hang'): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of frames) controller.enqueue(chunk);
      if (then === 'close') controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const request = {
  messages: [{ role: 'user' as const, content: 'сколько правил' }],
  context: { route: '/' },
};

afterEach(() => vi.unstubAllGlobals());

describe('поток хода агента', () => {
  it('замолчавший поток кончает ход кодом stream_lost, а не висит в «Агент думает…»', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamResponse(
          [frame({ kind: 'start', conversationId: 'c1', providerId: 'claude' })],
          'hang',
        ),
      ),
    );
    const events: PanelAgentRunEvent[] = [];
    const outcome = await runPanelAgent(
      request,
      (event) => events.push(event),
      new AbortController().signal,
      40,
    );
    expect(events.map((event) => event.kind)).toEqual(['start']);
    expect(outcome).toMatchObject({ ok: false, code: STREAM_LOST });
  });

  it('живой поток с паузами короче порога доходит до итога, хотя весь ход много дольше порога', async () => {
    // Каждая пауза (40 мс) короче порога (100 мс), а весь ход (≥160 мс) — много
    // длиннее: единый срок на весь ход вместо сброса на каждом куске тут краснеет.
    const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(frame({ kind: 'start', conversationId: 'c1', providerId: 'claude' }));
        for (let i = 0; i < 3; i += 1) {
          await pause();
          controller.enqueue(encoder.encode(': ping\n\n'));
        }
        await pause();
        controller.enqueue(frame({ kind: 'done', reply: 'Три.' }));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );
    const outcome = await runPanelAgent(
      request,
      () => undefined,
      new AbortController().signal,
      100,
    );
    expect(outcome).toEqual({ ok: true });
  });

  it('поток закрылся без итога (панель перезапустилась) — тот же обрыв связи', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamResponse(
          [frame({ kind: 'start', conversationId: 'c1', providerId: 'claude' })],
          'close',
        ),
      ),
    );
    const outcome = await runPanelAgent(request, () => undefined, new AbortController().signal, 40);
    expect(outcome).toMatchObject({ ok: false, code: STREAM_LOST });
  });
});

// Обрыв первого хода (разговора ещё нет) окно показывает строкой отказа по коду;
// без перевода кода английский интерфейс получал русское сообщение потока (F-191).
describe('текст обрыва потока', () => {
  it('код обрыва переведён на оба языка', () => {
    const ru = panelAgentRu.refusal as Record<string, string | undefined>;
    const en = panelAgentEn.refusal as Record<string, string | undefined>;
    expect(ru[STREAM_LOST]).toBeTruthy();
    expect(en[STREAM_LOST]).toBeTruthy();
    expect(en[STREAM_LOST]).not.toMatch(/[а-яё]/i);
  });
});
