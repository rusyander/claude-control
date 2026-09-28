import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelAgentRunEvent } from '@agentdeck/contracts/panel-agent';

/**
 * F-101 D3: Android 15+ режет сеть фоновому приложению, поток хода рвётся.
 * Телефон просит ход с возвратом и догоняет его по номеру кадра; против
 * сервера без возврата (кадры без номеров) ведёт себя как прежде. Подменён
 * только сокет (`expo/fetch`), разбор и решение о возврате — настоящие.
 */

const fetchMock = vi.fn();
vi.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => fetchMock(...args) }));
vi.mock('../../shared/api/client', () => ({
  apiUrl: (path: string) => `http://panel/api${path}`,
  authHeaders: () => ({ Authorization: 'Bearer phone-token' }),
}));

const { STREAM_LOST, runResumablePanelAgent, splitSeqFrames, stopPanelAgent } =
  await import('./run');

function streamOf(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

const numbered = (seq: number, event: PanelAgentRunEvent): string =>
  `data: ${JSON.stringify(event)}\nid: ${seq}\n\n`;
const plain = (event: PanelAgentRunEvent): string => `data: ${JSON.stringify(event)}\n\n`;

const START: PanelAgentRunEvent = { kind: 'start', conversationId: 'c1', providerId: 'claude' };
const body = {
  messages: [{ role: 'user' as const, content: 'где я?' }],
  context: { route: 'phone' },
};
const fast = { waitMs: 0 };

async function run() {
  const seen: string[] = [];
  const outcome = await runResumablePanelAgent(
    body,
    (event) => seen.push(event.kind === 'text' ? `text:${event.text}` : event.kind),
    new AbortController().signal,
    fast,
  );
  return { outcome, seen };
}

describe('ход агента с возвратом после обрыва', () => {
  beforeEach(() => fetchMock.mockReset());

  it('обрыв посреди хода — телефон возвращается с последнего номера и доводит ход', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(streamOf(numbered(1, START) + numbered(2, { kind: 'text', text: 'Смотрю.' }))),
      )
      .mockResolvedValueOnce(
        new Response(
          streamOf(
            numbered(3, { kind: 'text', text: ' Готово.' }) +
              numbered(4, { kind: 'done', reply: 'Смотрю. Готово.' }),
          ),
        ),
      );
    const { outcome, seen } = await run();
    expect(outcome).toEqual({ ok: true });
    expect(seen).toEqual(['start', 'text:Смотрю.', 'text: Готово.', 'done']);
    const [postUrl, postInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(postUrl).toBe('http://panel/api/agent/run');
    expect(JSON.parse(String(postInit.body)).detach).toBe(true);
    const [attachUrl, attachInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(attachUrl).toBe('http://panel/api/agent/run/c1/stream?fromSeq=2');
    expect((attachInit.headers as Record<string, string>).Authorization).toBe('Bearer phone-token');
  });

  it('сервер без возврата (кадры без номеров) — прежний обрыв, повторов нет', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(streamOf(plain(START) + plain({ kind: 'text', text: 'a' }))),
    );
    const { outcome } = await run();
    expect(outcome).toMatchObject({ ok: false, code: STREAM_LOST });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('хода на сервере уже нет (404) — обрыв и перечитка, без новых попыток', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(streamOf(numbered(1, START))))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'not_running' }), { status: 404 }),
      );
    const { outcome } = await run();
    expect(outcome).toMatchObject({ ok: false, code: STREAM_LOST });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('сервер без маршрута возврата (голый 404) — то же самое', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(streamOf(numbered(1, START))))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    const { outcome } = await run();
    expect(outcome).toMatchObject({ ok: false, code: STREAM_LOST });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('сеть ещё не поднялась — следующая попытка догоняет ход', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(streamOf(numbered(1, START))))
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce(new Response(streamOf(numbered(2, { kind: 'done', reply: 'ok' }))));
    const { outcome, seen } = await run();
    expect(outcome).toEqual({ ok: true });
    expect(seen).toEqual(['start', 'done']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('в фоне к ходу не возвращаемся: попытка ждёт возвращения приложения на экран', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(streamOf(numbered(1, START))))
      .mockResolvedValueOnce(new Response(streamOf(numbered(2, { kind: 'done', reply: 'ok' }))));
    let wake: () => void = () => undefined;
    const ready = vi.fn(() => new Promise<void>((resolve) => (wake = resolve)));
    const pending = runResumablePanelAgent(body, () => undefined, new AbortController().signal, {
      ...fast,
      ready,
    });
    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1); // пока «в фоне» — ни одного возврата
    wake();
    expect(await pending).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ошибка агента — не обрыв: возврата нет', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(streamOf(numbered(1, START) + numbered(2, { kind: 'error', message: 'упал' }))),
    );
    const { outcome } = await run();
    expect(outcome).toEqual({ ok: false, message: 'упал' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('«Стоп» хода с возвратом — отдельным запросом', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}'));
    await stopPanelAgent('c1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://panel/api/agent/run/c1/stop');
    expect(init.method).toBe('POST');
  });
});

describe('splitSeqFrames', () => {
  it('номер из строки id:, без неё — кадр без номера, хвост остаётся', () => {
    const { frames, rest } = splitSeqFrames(
      `${numbered(5, START)}: ping\n\n${plain({ kind: 'text', text: 'x' })}data: {"kin`,
    );
    expect(frames).toEqual([{ event: START, seq: 5 }, { event: { kind: 'text', text: 'x' } }]);
    expect(rest).toBe('data: {"kin');
  });
});
