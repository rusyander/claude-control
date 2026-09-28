import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Состояние модуля (флаг, глушение повторов) — своё на каждый тест. */
async function load() {
  vi.resetModules();
  return import('./watch-capture');
}

/** Сигналы консоли уходят микрозадачей позже записи — дать ей пройти. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));

function sentBodies(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls.map((call) => {
    const init = (call as unknown as [string, RequestInit])[1];
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  });
}

// Первый импорт модуля — холодная сборка его зависимостей: на нагруженной машине
// она съедала 5 с таймаута первого теста, и его запоздавший сигнал попадал в
// следующий. Сборку делаем заранее; каждый тест всё равно берёт свежий модуль.
beforeAll(async () => {
  await import('./watch-capture');
}, 60_000);

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('сбои страницы для наблюдателя', () => {
  it('выключен — ни одного запроса; включён — сигнал уходит на свой адрес', async () => {
    const capture = await load();
    capture.reportClientSignal({ kind: 'window-error', message: 'boom', route: '/x' });
    expect(fetchMock).not.toHaveBeenCalled();

    capture.setWatchCaptureEnabled(true);
    capture.reportClientSignal({ kind: 'window-error', message: 'boom', route: '/x' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/watcher/events');
    expect(sentBodies()[0]).toMatchObject({ kind: 'window-error', message: 'boom', route: '/x' });

    capture.setWatchCaptureEnabled(false);
    capture.reportClientSignal({ kind: 'window-error', message: 'after off', route: '/x' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('одинаковый сбой подряд глушится, другой — уходит', async () => {
    const capture = await load();
    capture.setWatchCaptureEnabled(true);
    for (let index = 0; index < 5; index += 1) {
      capture.reportClientSignal({ kind: 'render-crash', message: 'same', route: '/a' });
    }
    capture.reportClientSignal({ kind: 'render-crash', message: 'other', route: '/a' });
    expect(sentBodies().map((body) => body.message)).toEqual(['same', 'other']);
  });

  it('API: 5xx и обрыв сети — сигнал с путём /api; 4xx и сам наблюдатель — нет', async () => {
    const capture = await load();
    capture.setWatchCaptureEnabled(true);
    capture.reportApiFailure({ method: 'get', url: '/skills?x=1', status: 500, message: 'e1' });
    capture.reportApiFailure({ method: 'post', url: '/rules', message: 'Network Error' });
    capture.reportApiFailure({ url: '/hooks', status: 404, message: 'nf' });
    capture.reportApiFailure({ url: '/watcher/events', status: 500, message: 'loop' });
    expect(sentBodies()).toEqual([
      expect.objectContaining({
        kind: 'api-failure',
        method: 'GET',
        path: '/api/skills',
        status: 500,
      }),
      expect.objectContaining({
        kind: 'api-failure',
        method: 'POST',
        path: '/api/rules',
        status: 0,
      }),
    ]);
  });

  it('слушатели окна: ошибка и отказ промиса (текст, объект) уходят сигналами', async () => {
    const target = Object.assign(new EventTarget(), { location: { pathname: '/skills' } });
    vi.stubGlobal('window', target);
    const capture = await load();
    capture.setWatchCaptureEnabled(true);
    target.dispatchEvent(Object.assign(new Event('error'), { error: new Error('win boom') }));
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'plain text' }));
    target.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), { reason: { code: 7, why: 'obj' } }),
    );
    expect(sentBodies()).toEqual([
      expect.objectContaining({ kind: 'window-error', message: 'win boom', route: '/skills' }),
      expect.objectContaining({ kind: 'unhandled-rejection', message: 'plain text' }),
      expect.objectContaining({ kind: 'unhandled-rejection', message: '{"code":7,"why":"obj"}' }),
    ]);
    expect(capture.isWatchCaptureEnabled()).toBe(true);
  });

  it('несериализуемая причина и ошибка без текста — не падение, а строка', async () => {
    const capture = await load();
    capture.setWatchCaptureEnabled(true);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    capture.reportRenderCrash(circular);
    capture.reportRenderCrash(Object.assign(new Error(''), { name: 'TypeError', stack: '' }));
    expect(sentBodies().map((body) => body.message)).toEqual(['[object Object]', 'TypeError']);
  });

  it('упавшая отрисовка несёт стек ошибки и стопку компонентов; длинное обрезается', async () => {
    const capture = await load();
    capture.setWatchCaptureEnabled(true);
    const error = new Error('x'.repeat(5000));
    capture.reportRenderCrash(error, '\n    at Broken (Broken.tsx:3)');
    const [body] = sentBodies();
    expect(String(body!.message)).toHaveLength(2000);
    expect(String(body!.stack)).toContain('Broken.tsx:3');
  });

  it('отказ, уже записанный сервером (его заголовок), второй раз не шлётся', async () => {
    const capture = await load();
    capture.setWatchCaptureEnabled(true);
    capture.reportApiFailure({ url: '/skills', status: 500, message: 'x', seenByServer: true });
    capture.reportApiFailure({
      url: 'http://127.0.0.1:8888/api/rules?a=1',
      status: 502,
      message: 'proxy',
    });
    expect(sentBodies()).toEqual([
      expect.objectContaining({ kind: 'api-failure', path: '/api/rules', status: 502 }),
    ]);
  });

  it('консоль: подстановки как у консоли, ошибка React — с её стеком; уже ушедшая ошибка — нет', async () => {
    expect(
      (await load()).formatConsoleArgs(['Warning: key %s in %c%s', 'id', 'color:red', 'List', 7])
        .message,
    ).toBe('Warning: key id in List 7');
    const target = Object.assign(new EventTarget(), { location: { pathname: '/rules' } });
    vi.stubGlobal('window', target);
    const seenByConsole: unknown[][] = [];
    const fakeConsole = {
      error: (...args: unknown[]) => void seenByConsole.push(args),
      warn: (...args: unknown[]) => void seenByConsole.push(args),
    };
    vi.stubGlobal('console', fakeConsole);
    const capture = await load();
    capture.setWatchCaptureEnabled(true);
    fakeConsole.warn(
      'Warning: Each child in a list should have a unique "key" prop.%s',
      '\n    at Row',
    );
    const crash = new Error('render boom');
    capture.reportRenderCrash(crash);
    fakeConsole.error('The above error occurred', crash);
    fakeConsole.error(new Error('console boom'));
    await flush();
    // Настоящая консоль получила всё как было.
    expect(seenByConsole).toHaveLength(3);
    // Сбой отрисовки уходит сразу, записи консоли — микрозадачей позже.
    expect(sentBodies().map((body) => [body.kind, String(body.message).slice(0, 30)])).toEqual([
      ['render-crash', 'render boom'],
      ['console-warn', 'Warning: Each child in a list '],
      ['console-error', 'console boom'],
    ]);
    expect(String(sentBodies()[2]!.stack)).toContain('console boom');
    // Выключен — консоль работает, сигналов нет.
    capture.setWatchCaptureEnabled(false);
    fakeConsole.error('after off');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(seenByConsole).toHaveLength(4);
  });

  // Ревью 28.09 F-87: граница ошибок и страница сбоя раздела писали в консоль
  // ДО сигнала — перехват консоли успевал отправить `console-error`, и сбой
  // уходил наблюдателю дважды.
  it('сбой отрисовки с записью в консоль — ровно один сигнал render-crash', async () => {
    const seenByConsole: unknown[][] = [];
    vi.stubGlobal('console', {
      error: (...args: unknown[]) => void seenByConsole.push(args),
      warn: (...args: unknown[]) => void seenByConsole.push(args),
    });
    const capture = await load();
    capture.setWatchCaptureEnabled(true);
    capture.logRenderCrash('[agentdeck] сбой раздела /rules', new Error('boom in section'));
    capture.logRenderCrash(
      '[agentdeck] сбой отрисовки в границе «card»',
      new Error('boom in card'),
      '\n    at Card (Card.tsx:3)',
    );
    await flush();
    expect(sentBodies().map((body) => body.kind)).toEqual(['render-crash', 'render-crash']);
    expect(String(sentBodies()[1]!.stack)).toContain('Card.tsx:3');
    // Консоль человека получила обе записи с подписью места.
    expect(seenByConsole.map((args) => args[0])).toEqual([
      '[agentdeck] сбой раздела /rules',
      '[agentdeck] сбой отрисовки в границе «card»',
    ]);
  });

  it('fetch в обход клиента: обрыв и 5xx без заголовка сервера — сигнал; отмена и записанное — нет', async () => {
    const responses: Array<() => Promise<Response>> = [
      () => Promise.resolve(new Response('x', { status: 503 })),
      () =>
        Promise.resolve(
          new Response('x', { status: 500, headers: { 'x-agentdeck-watch': 'seen' } }),
        ),
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.reject(new DOMException('aborted', 'AbortError')),
      () => Promise.resolve(new Response('{}', { status: 200 })),
    ];
    // В браузере window.fetch и есть глобальный fetch: сигналы идут тем же, что обёрнут.
    const pageFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === '/api/watcher/events'
        ? (fetchMock as unknown as typeof fetch)(input, init)
        : responses.shift()!(),
    );
    const target = Object.assign(new EventTarget(), {
      location: { pathname: '/chat' },
      fetch: pageFetch,
    });
    vi.stubGlobal('window', target);
    const capture = await load();
    capture.setWatchCaptureEnabled(true);
    const wrapped = target.fetch as typeof fetch;
    await wrapped('/api/stream/a');
    await wrapped('/api/stream/b');
    await expect(wrapped('/api/stream/c', { method: 'POST' })).rejects.toThrow('Failed to fetch');
    await expect(wrapped('/api/stream/d')).rejects.toThrow('aborted');
    await wrapped('/api/stream/e');
    // Пять запросов страницы и два сигнала — и ни одного сигнала о самих сигналах.
    expect(pageFetch).toHaveBeenCalledTimes(7);
    expect(sentBodies().map((body) => [body.path, body.status])).toEqual([
      ['/api/stream/a', 503],
      ['/api/stream/c', 0],
    ]);
  });

  it('ответ не того вида: HTML на /api — сигнал; пустое тело и JSON — нет', async () => {
    const capture = await load();
    capture.setWatchCaptureEnabled(true);
    expect(capture.looksLikeWrongShape('<!doctype html><html>', 'text/html')).toBe(true);
    expect(capture.looksLikeWrongShape('', 'text/html')).toBe(false);
    expect(capture.looksLikeWrongShape({ ok: true }, 'application/json')).toBe(false);
    capture.reportContractMismatch({
      method: 'get',
      url: '/skills',
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Vite</title>',
    });
    expect(sentBodies()).toEqual([
      expect.objectContaining({
        kind: 'contract-mismatch',
        method: 'GET',
        path: '/api/skills',
        message: 'Response is not JSON (text/html): <!doctype html><title>Vite</title>',
      }),
    ]);
  });

  it('зависшая загрузка: дольше порога — один сигнал на зависание, выключен — ничего', async () => {
    vi.useFakeTimers();
    try {
      const capture = await load();
      capture.setWatchThresholds({ stuckLoadingMs: 3000 });
      let clock = 0;
      const queries = [
        { queryHash: 'a', queryKey: ['skills', 'list', 42], state: { fetchStatus: 'fetching' } },
        { queryHash: 'b', queryKey: ['rules'], state: { fetchStatus: 'idle' } },
      ];
      const stop = capture.watchQueryCache({ getAll: () => queries }, () => clock);
      const stopSecond = capture.watchQueryCache({ getAll: () => queries }, () => clock);
      capture.setWatchCaptureEnabled(true);
      for (let step = 0; step < 6; step += 1) {
        clock += 1000;
        vi.advanceTimersByTime(1000);
      }
      expect(sentBodies()).toEqual([
        expect.objectContaining({
          kind: 'stuck-loading',
          path: 'skills/list',
          message: 'Loading took longer than 3 s: skills/list',
        }),
      ]);
      expect(Number(sentBodies()[0]!.durationMs)).toBeGreaterThanOrEqual(3000);
      // Кончилась и началась снова — новое зависание, новый сигнал (после окна повтора).
      queries[0]!.state.fetchStatus = 'idle';
      clock += 1000;
      vi.advanceTimersByTime(1000);
      queries[0]!.state.fetchStatus = 'fetching';
      clock += 10_000;
      vi.advanceTimersByTime(1000);
      clock += 4000;
      vi.advanceTimersByTime(1000);
      stop();
      stopSecond();
      clock += 10_000;
      vi.advanceTimersByTime(5000);
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
  // Ревью 28.09 F-306: текст сигнала уходит модели наблюдателя — по-английски,
  // как всё, что панель шлёт агентам.
  it('текст сигналов, собранный панелью, — английский', async () => {
    const pageFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === '/api/watcher/events'
        ? (fetchMock as unknown as typeof fetch)(input, init)
        : Promise.resolve(new Response('x', { status: 503 })),
    );
    vi.stubGlobal(
      'window',
      Object.assign(new EventTarget(), { location: { pathname: '/chat' }, fetch: pageFetch }),
    );
    const capture = await load();
    capture.setWatchCaptureEnabled(true);
    await (window.fetch as typeof fetch)('/api/stream/a');
    capture.reportContractMismatch({ url: '/skills', body: '' as unknown });
    const messages = sentBodies().map((body) => String(body.message));
    expect(messages).toEqual(['Response 503', 'Response is not JSON (no content type): string']);
    for (const message of messages) expect(message).not.toMatch(/[а-яё]/i);
  });

  // Ревью 28.09 F-338: схема сервера режет route до 300 и path до 500 — длиннее
  // сигнал получал 400 и терялся молча.
  it('маршрут и путь укорачиваются до пределов схемы', async () => {
    const capture = await load();
    capture.setWatchCaptureEnabled(true);
    capture.reportApiFailure({ url: `/projects/${'p'.repeat(600)}`, status: 502, message: 'x' });
    capture.reportClientSignal({
      kind: 'window-error',
      message: 'y',
      route: `/${'r'.repeat(400)}`,
    });
    const [api, win] = sentBodies();
    expect(String(api!.path)).toHaveLength(500);
    expect(String(win!.route)).toHaveLength(300);
  });

  // Ревью 28.09 F-343: горячая перезагрузка исполняет модуль заново — старая
  // обёртка консоли оставалась включённой, и каждая запись уходила дважды.
  it('модуль исполнен заново: прежние обёртки сняты — одна запись, один сигнал', async () => {
    const target = Object.assign(new EventTarget(), { location: { pathname: '/x' } });
    vi.stubGlobal('window', target);
    const seenByConsole: unknown[][] = [];
    const fakeConsole = {
      error: (...args: unknown[]) => void seenByConsole.push(args),
      warn: (...args: unknown[]) => void seenByConsole.push(args),
    };
    vi.stubGlobal('console', fakeConsole);
    const first = await load();
    first.setWatchCaptureEnabled(true);
    const second = await load();
    second.setWatchCaptureEnabled(true);
    fakeConsole.error('once');
    target.dispatchEvent(Object.assign(new Event('error'), { error: new Error('win once') }));
    await flush();
    expect(seenByConsole).toHaveLength(1);
    expect(sentBodies().map((body) => body.kind)).toEqual(['window-error', 'console-error']);
  });

  // Ревью 28.09 F-344: React 19 в разработке пишет пойманную границей ошибку в
  // консоль ДО componentDidCatch — перехват консоли успевал отправить её как
  // console-error, и сбой уходил дважды.
  it('запись React о пойманной ошибке раньше сигнала границы — один render-crash', async () => {
    vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/x' } }));
    vi.stubGlobal('console', { error: () => undefined, warn: () => undefined });
    const capture = await load();
    capture.setWatchCaptureEnabled(true);
    const crash = new Error('caught by boundary');
    console.error(
      '%o\n\n%s\n\n%s\n',
      crash,
      'The above error occurred in the <Broken> component.',
      'React will try to recreate this component tree from scratch using the error boundary you provided, ErrorBoundary.',
    );
    capture.reportRenderCrash(crash, '\n    at Broken');
    await flush();
    expect(sentBodies().map((body) => body.kind)).toEqual(['render-crash']);
  });
});
