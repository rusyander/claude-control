import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Граница хода внутри прогона (`nextTurn`, core-chat-012) на телефоне. Чат чужого CLI на ядре:
 * слово «на ходу» ядро доставляет новым ходом ТОГО ЖЕ прогона. Без разбора события ответ на
 * слово дописывался к прежнему одним текстом («готовготов»), а само слово жило только в строке
 * «Передано агенту» и пропадало по концу прогона — транскрипта такого CLI нет. Подменены граница
 * сети (`expo/fetch`, `api`) и хранилище; стор, транспорт и конец хода — настоящие.
 */

const fetchMock = vi.fn();
const apiPost = vi.fn();

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: vi.fn() },
}));
vi.mock('expo/fetch', () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));
vi.mock('../notifyLocally', () => ({ notifyLocally: vi.fn(async () => undefined) }));
vi.mock('../../api/connection', () => ({ isConfigured: () => true }));
vi.mock('../../api/client', () => ({
  api: { get: vi.fn(async () => []), post: (...args: unknown[]) => apiPost(...args) },
  apiUrl: (path: string) => `http://panel${path}`,
}));
vi.mock('../../api/authHeaders', () => ({ authHeaders: () => ({}) }));
vi.mock('../../api/signing/keyStore', () => ({
  loadKey: async () => undefined,
  freshNonce: () => 'nonce',
}));
vi.mock('../../config/i18n', () => ({
  dict: () => ({
    run: {
      serverUnreachable: 'unreachable',
      connectionLost: 'connection lost',
      finished: 'finished',
      failed: 'failed',
      homeChat: 'home',
      answered: (status: number) => `answered ${status}`,
      notSent: { busy: 'busy', files: () => 'files', other: (m: string) => m },
    },
  }),
}));

import { send } from './lifecycle';
import { applyEvent, controllers, getRun, lastSeqs, runs, setRun } from './store';

function sseStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: { ok: true, status: 200, body } as unknown as Response,
    push(event: Record<string, unknown>) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    close() {
      controller.close();
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

beforeEach(() => {
  runs.clear();
  lastSeqs.clear();
  controllers.clear();
  fetchMock.mockReset();
  apiPost.mockReset();
});

describe('граница хода (nextTurn) на телефоне — core-chat-012', () => {
  it('слово «на ходу» становится своей репликой, ответ на него не склеен с прежним и не пропадает по концу', async () => {
    const stream = sseStream();
    fetchMock.mockResolvedValueOnce(stream.response);
    void send({ chatId: 'nt-1', prompt: 'ход-41' });
    await flush();
    stream.push({
      kind: 'session',
      sessionId: 'sess-t',
      model: 'm',
      tools: 0,
      startedAt: 1000,
      seq: 1,
    });
    stream.push({ kind: 'text', text: 'готов', seq: 2 });
    await flush();

    apiPost.mockResolvedValueOnce({ steered: true });
    expect(await send({ chatId: 'nt-1', prompt: 'ход-42' })).toEqual({ ok: true });
    expect(getRun('nt-1').steered).toEqual(['ход-42']);

    stream.push({ kind: 'steer', text: 'ход-42', at: '2026-11-06T10:00:00.000Z', seq: 3 });
    stream.push({ kind: 'nextTurn', prompt: 'ход-42', at: 5000, seq: 4 });
    await flush();
    let run = getRun('nt-1');
    expect(run.text).toBe('');
    expect(run.steered).toBeUndefined();
    expect(run.lastPrompt).toBe('ход-42');
    expect(run.turnAt).toBe(5000);
    expect(run.startedAt).toBe(1000);
    // Прошлый ход кончился — экран перечитывает ленту, как на смене хода в потоке.
    expect(run.endedAt).toEqual(expect.any(Number));

    stream.push({ kind: 'text', text: 'готов', seq: 5 });
    stream.push({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'sess-t', seq: 6 });
    stream.close();
    await flush();
    run = getRun('nt-1');
    expect(run.status).toBe('done');
    // Пузырь потока держит ответ ход-42, а не склейку двух ответов; само слово остаётся репликой.
    expect(run.text).toBe('готов');
    expect(run.lastPrompt).toBe('ход-42');
  });

  it('граница хода пришла раньше ответа на «на ходу»: слово не возвращается в строку «Передано агенту»', async () => {
    const stream = sseStream();
    fetchMock.mockResolvedValueOnce(stream.response);
    void send({ chatId: 'nt-2', prompt: 'ход-41' });
    await flush();
    stream.push({
      kind: 'session',
      sessionId: 'sess-2',
      model: 'm',
      tools: 0,
      startedAt: 1000,
      seq: 1,
    });
    await flush();

    let reply!: (value: { steered: boolean }) => void;
    apiPost.mockImplementationOnce(() => new Promise((resolve) => (reply = resolve)));
    const outcome = send({ chatId: 'nt-2', prompt: 'ход-42' });
    stream.push({ kind: 'steer', text: 'ход-42', at: '2026-11-06T10:00:00.000Z', seq: 2 });
    stream.push({ kind: 'nextTurn', prompt: 'ход-42', at: 5000, seq: 3 });
    await flush();
    reply({ steered: true });
    expect(await outcome).toEqual({ ok: true });
    expect(getRun('nt-2').steered).toBeUndefined();
    expect(getRun('nt-2').lastPrompt).toBe('ход-42');
    stream.close();
    await flush();
  });

  // Поле ввода отдаёт слово как набрано — с пробелом в конце; граница хода несёт его без хвоста
  // (ядро отдаёт слово сеанса). Сверка без обрезки сочла бы их разными и вернула бы слово в строку
  // «Передано агенту» после того, как оно уже стало репликой (F-09).
  it('слово с пробелом в конце, граница раньше ответа: в «Передано агенту» оно не возвращается', async () => {
    const stream = sseStream();
    fetchMock.mockResolvedValueOnce(stream.response);
    void send({ chatId: 'nt-2s', prompt: 'ход-41' });
    await flush();
    stream.push({
      kind: 'session',
      sessionId: 'sess-2s',
      model: 'm',
      tools: 0,
      startedAt: 1000,
      seq: 1,
    });
    await flush();

    let reply!: (value: { steered: boolean }) => void;
    apiPost.mockImplementationOnce(() => new Promise((resolve) => (reply = resolve)));
    const outcome = send({ chatId: 'nt-2s', prompt: 'ход-42 ' });
    stream.push({ kind: 'steer', text: 'ход-42', at: '2026-11-06T10:00:00.000Z', seq: 2 });
    stream.push({ kind: 'nextTurn', prompt: 'ход-42', at: 5000, seq: 3 });
    await flush();
    reply({ steered: true });
    expect(await outcome).toEqual({ ok: true });
    expect(getRun('nt-2s').steered).toBeUndefined();
    expect(getRun('nt-2s').lastPrompt).toBe('ход-42');
    stream.close();
    await flush();
  });

  it('открытый вопрос агента переживает границу хода, закрытый и прочие вызовы — нет', () => {
    setRun('nt-3', { status: 'running', startedAt: 1000, steered: ['ещё', 'ход-42'] });
    applyEvent('nt-3', { kind: 'tool', name: 'Read', input: { path: 'a' }, id: 'r1' });
    applyEvent('nt-3', { kind: 'tool', name: 'AskUserQuestion', input: {}, id: 'q1' });
    applyEvent('nt-3', { kind: 'tool', name: 'AskUserQuestion', input: {}, id: 'q2' });
    applyEvent('nt-3', { kind: 'autoPick', toolUseId: 'q2', picks: [] });
    applyEvent('nt-3', { kind: 'thinking', text: 'думаю' });
    applyEvent('nt-3', { kind: 'nextTurn', prompt: ' ход-42 ', at: 7000 });
    const run = getRun('nt-3');
    expect(run.tools.map((tool) => tool.id)).toEqual(['q1']);
    expect(run.askedQuestion).toBe(true);
    expect(run.thinking).toBe('');
    // Снимается только доставленное слово; второе ещё ждёт своей границы.
    expect(run.steered).toEqual(['ещё']);
  });

  it('новый прогон и смена хода в потоке снимают границу прошлого', () => {
    setRun('nt-4', { status: 'running', startedAt: 1000, turnAt: 5000 });
    applyEvent('nt-4', { kind: 'session', sessionId: 's', model: 'm', tools: 0, startedAt: 9000 });
    expect(getRun('nt-4').turnAt).toBeUndefined();
  });
});
