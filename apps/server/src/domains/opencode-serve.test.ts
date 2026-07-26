import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { OpencodeServe, freePort } from './opencode-serve.ts';
import { runAssistant } from './assistant-runner.ts';
import { getProvider } from '../providers/registry.ts';

/**
 * Сессионный режим OpenCode (IDEA-8). Настоящий `opencode serve` здесь не
 * запускается НИ РАЗУ: `spawn` и `fetch` подменены. Проверяем то, ради чего он
 * и делался, — что диалог держит CLI (наружу уходит только новое сообщение),
 * что сервер поднимается ОДИН на все запросы, и что любая заминка молча
 * возвращает панель к one-shot, а не ломает ответ пользователю.
 */

/** Поддельный дочерний процесс: ничего не запускает, умеет «умереть». */
function fakeChild(): EventEmitter & { pid: number; kill: () => void } {
  const child = new EventEmitter() as EventEmitter & { pid: number; kill: () => void };
  child.pid = 4242;
  child.kill = () => child.emit('exit', 0);
  return child;
}

const jsonResponse = (body: unknown): Response =>
  ({ ok: true, json: async () => body }) as unknown as Response;

const okHealth = (): Response => ({ ok: true, json: async () => ({}) }) as unknown as Response;

describe('OpencodeServe: локальный сервер и сессии', () => {
  it('свободный порт выдаётся ОС и не равен нулю', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
  });

  it('поднимает сервер один раз, создаёт сессию и шлёт только новое сообщение', async () => {
    const spawnImpl = vi.fn(() => fakeChild());
    const calls: { url: string; body?: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (href.endsWith('/global/health')) return okHealth();
      if (href.endsWith('/session')) return jsonResponse({ id: 'ses_1' });
      return jsonResponse({ info: {}, parts: [{ type: 'text', text: 'Привет!' }] });
    });

    const serve = new OpencodeServe();
    const deps = {
      command: 'opencode',
      spawnImpl: spawnImpl as never,
      fetchImpl: fetchImpl as never,
      port: 4096,
    };

    expect(await serve.ask('conv-1', 'первый вопрос', deps)).toEqual({
      reply: 'Привет!',
      sessionId: 'ses_1',
    });
    expect(await serve.ask('conv-1', 'второй вопрос', deps)).toMatchObject({ sessionId: 'ses_1' });

    // Сервер подняли ОДИН раз, сессию создали тоже один — второй вопрос ушёл в неё.
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.url.endsWith('/session')).length).toBe(1);

    const messages = calls.filter((call) => call.url.includes('/message'));
    expect(messages).toHaveLength(2);
    // Наружу уходит ТОЛЬКО новое сообщение: истории в теле нет.
    expect(messages[0]?.body).toEqual({ parts: [{ type: 'text', text: 'первый вопрос' }] });
    expect(messages[1]?.body).toEqual({ parts: [{ type: 'text', text: 'второй вопрос' }] });

    // Сервер слушает только петлю — наружу его не выставляем.
    expect(JSON.stringify(spawnImpl.mock.calls[0] ?? [])).toContain('127.0.0.1');

    serve.dispose();
    expect(serve.currentBaseUrl()).toBeUndefined();
  });

  it('сервер не поднялся (health молчит) → undefined, процесс снят', async () => {
    const child = fakeChild();
    const kill = vi.spyOn(child, 'kill');
    const serve = new OpencodeServe();
    // Снятие процесса тоже идёт через подменённый spawn: под Windows это
    // `taskkill` (иначе `cmd.exe` умер бы, а сам CLI остался держать порт), на
    // POSIX — обычный сигнал. Настоящих процессов тест не запускает ни там, ни там.
    const spawnImpl = vi.fn(() => child);

    const result = await serve.ask('conv-1', 'вопрос', {
      command: 'opencode',
      spawnImpl: spawnImpl as never,
      fetchImpl: (async () => {
        throw new Error('connection refused');
      }) as never,
      port: 4096,
      readyTimeoutMs: 0,
    });

    expect(result).toBeUndefined();
    const killedViaTaskkill = (spawnImpl.mock.calls as unknown as unknown[][]).some(
      (call) => call[0] === 'taskkill',
    );
    expect(kill.mock.calls.length > 0 || killedViaTaskkill).toBe(true);
  });

  it('ответ не той формы (нет текстовых частей) → undefined, сессия забыта', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/global/health')) return okHealth();
      if (href.endsWith('/session')) return jsonResponse({ id: 'ses_1' });
      // Части есть, но текстовых среди них нет — выдумывать ответ панель не станет.
      return jsonResponse({ info: {}, parts: [{ type: 'tool', name: 'bash' }] });
    });

    const serve = new OpencodeServe();
    expect(
      await serve.ask('conv-1', 'вопрос', {
        command: 'opencode',
        spawnImpl: (() => fakeChild()) as never,
        fetchImpl: fetchImpl as never,
        port: 4096,
      }),
    ).toBeUndefined();
  });

  it('смерть процесса сервера забывает адрес и сессии: следующий запрос поднимает заново', async () => {
    const children = [fakeChild(), fakeChild()];
    let index = 0;
    const spawnImpl = vi.fn(() => children[index++]!);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/global/health')) return okHealth();
      if (href.endsWith('/session')) return jsonResponse({ id: `ses_${index}` });
      return jsonResponse({ info: {}, parts: [{ type: 'text', text: 'ответ' }] });
    });

    const serve = new OpencodeServe();
    const deps = {
      command: 'opencode',
      spawnImpl: spawnImpl as never,
      fetchImpl: fetchImpl as never,
      port: 4096,
    };

    await serve.ask('conv-1', 'первый', deps);
    children[0]!.emit('exit', 1);
    await serve.ask('conv-1', 'второй', deps);

    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });
});

describe('runAssistant: сессия сначала, one-shot как запасной путь', () => {
  const provider = getProvider('opencode');

  /** Раннер, у которого сессия всегда отвечает. */
  const workingServe = {
    ask: async () => ({ reply: 'ответ из сессии', sessionId: 'ses_9' }),
  } as unknown as OpencodeServe;

  /** Раннер, у которого сессия всегда «не получилось». */
  const brokenServe = { ask: async () => undefined } as unknown as OpencodeServe;

  it('сессия сработала → transport session, sessionId наружу, CLI не запускался', async () => {
    const spawnImpl = vi.fn();
    const result = await runAssistant(provider, [{ role: 'user', content: 'вопрос' }], {
      appDataDir: 'C:/tmp/nowhere',
      conversationId: 'conv-1',
      sessionServe: workingServe,
      detect: () => true,
      spawnImpl: spawnImpl as never,
    });

    expect(result).toMatchObject({
      ok: true,
      mode: 'cli',
      transport: 'session',
      sessionId: 'ses_9',
      reply: 'ответ из сессии',
      // Путь всё ещё не проверен живым прогоном — метка обязана остаться.
      experimental: true,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('сессия не поднялась → молча уходим в one-shot, ответ приходит оттуда', async () => {
    const child = fakeChild() as unknown as {
      stdout: EventEmitter;
      stderr: EventEmitter;
      emit: (event: string, payload?: unknown) => boolean;
    };
    const emitter = child as unknown as EventEmitter;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    const spawnImpl = vi.fn(() => {
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from('ответ из one-shot'));
        emitter.emit('close', 0);
      }, 0);
      return child;
    });

    const result = await runAssistant(provider, [{ role: 'user', content: 'вопрос' }], {
      appDataDir: 'C:/tmp/nowhere',
      conversationId: 'conv-1',
      sessionServe: brokenServe,
      detect: () => true,
      spawnImpl: spawnImpl as never,
    });

    expect(result).toMatchObject({
      ok: true,
      mode: 'cli',
      transport: 'one-shot',
      reply: 'ответ из one-shot',
    });
    expect(spawnImpl).toHaveBeenCalled();
  });

  it('без conversationId сессия не пробуется вовсе', async () => {
    const ask = vi.fn();
    const child = fakeChild() as unknown as { stdout: EventEmitter; stderr: EventEmitter };
    const emitter = child as unknown as EventEmitter;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    await runAssistant(provider, [{ role: 'user', content: 'вопрос' }], {
      appDataDir: 'C:/tmp/nowhere',
      sessionServe: { ask } as unknown as OpencodeServe,
      detect: () => true,
      spawnImpl: (() => {
        setTimeout(() => {
          child.stdout.emit('data', Buffer.from('ответ'));
          emitter.emit('close', 0);
        }, 0);
        return child;
      }) as never,
    });

    expect(ask).not.toHaveBeenCalled();
  });

  it('провайдер без заявленного сервера сессий (codex) сессию не пробует', async () => {
    const ask = vi.fn();
    const child = fakeChild() as unknown as { stdout: EventEmitter; stderr: EventEmitter };
    const emitter = child as unknown as EventEmitter;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    await runAssistant(getProvider('codex'), [{ role: 'user', content: 'вопрос' }], {
      appDataDir: 'C:/tmp/nowhere',
      conversationId: 'conv-1',
      sessionServe: { ask } as unknown as OpencodeServe,
      detect: () => true,
      spawnImpl: (() => {
        setTimeout(() => {
          child.stdout.emit('data', Buffer.from('ответ'));
          emitter.emit('close', 0);
        }, 0);
        return child;
      }) as never,
    });

    expect(ask).not.toHaveBeenCalled();
  });
});

/**
 * Потоки сервера сессий. Сервер живёт до конца работы панели и всё это время
 * пишет в лог; читать его вывод некому. Оставленная труба заполняется за
 * единицы килобайт — и запись в неё блокирует сервер НАВСЕГДА, посреди ответа.
 */
describe('OpencodeServe: вывод сервера не копится в трубе', () => {
  it('процесс поднимается со stdio: ignore', async () => {
    let options: { stdio?: string } | undefined;
    const spawnImpl = vi.fn(
      (_command: string, _args: string[], spawnOptions: { stdio?: string }) => {
        options = spawnOptions;
        return fakeChild();
      },
    );
    const serve = new OpencodeServe();

    await serve.ensure({
      command: 'opencode',
      spawnImpl: spawnImpl as never,
      fetchImpl: (async () => okHealth()) as never,
      port: 4097,
    });

    expect(spawnImpl).toHaveBeenCalled();
    expect(options?.stdio).toBe('ignore');
  });
});
