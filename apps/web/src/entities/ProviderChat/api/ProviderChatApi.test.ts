import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ProviderChatEvent } from '@claude-control/contracts';
import { openProviderChatStream } from './ProviderChatApi';

/**
 * Чтение потока ответа. Проверяется то, что ломается на настоящем соединении:
 * кадр приходит разрезанным между чтениями, между кадрами идут пинги, а один
 * испорченный кадр не должен обрывать весь ответ.
 */
function streamOf(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return { ok: true, body } as unknown as Response;
}

function frame(event: ProviderChatEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function collect(chunks: string[]): Promise<ProviderChatEvent[]> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamOf(chunks)));
  const events: ProviderChatEvent[] = [];
  await openProviderChatStream('chat', (event) => events.push(event), new AbortController().signal);
  return events;
}

describe('openProviderChatStream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('читает кадры подряд', async () => {
    const events = await collect([
      frame({ type: 'delta', text: 'Раз' }),
      frame({ type: 'delta', text: 'Два' }),
      frame({ type: 'done' }),
    ]);

    expect(events).toEqual([
      { type: 'delta', text: 'Раз' },
      { type: 'delta', text: 'Два' },
      { type: 'done' },
    ]);
  });

  it('склеивает кадр, разрезанный между чтениями', async () => {
    const whole = frame({ type: 'delta', text: 'Длинный ответ' });
    const events = await collect([whole.slice(0, 10), whole.slice(10)]);

    expect(events).toEqual([{ type: 'delta', text: 'Длинный ответ' }]);
  });

  it('пропускает пинги — они держат соединение, а не несут событий', async () => {
    const events = await collect([': ping\n\n', frame({ type: 'delta', text: 'Ответ' })]);

    expect(events).toEqual([{ type: 'delta', text: 'Ответ' }]);
  });

  it('испорченный кадр не обрывает поток', async () => {
    const events = await collect(['data: {не json}\n\n', frame({ type: 'done' })]);

    expect(events).toEqual([{ type: 'done' }]);
  });

  it('отказ сервера не бросает исключение — событий просто нет', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false } as Response));
    const events: ProviderChatEvent[] = [];

    await openProviderChatStream(
      'chat',
      (event) => events.push(event),
      new AbortController().signal,
    );

    expect(events).toEqual([]);
  });
});
