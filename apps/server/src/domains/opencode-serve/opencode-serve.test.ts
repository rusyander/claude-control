import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  OPENCODE_DECLINE_MESSAGE,
  OPENCODE_STOPPED_REPLY,
  OpencodeServe,
  freePort,
  pickAgent,
  sessionPermissionRules,
  type OpencodePermissionRule,
} from './opencode-serve.ts';
import { runAssistant } from '../assistant-runner/assistant-runner.ts';
import { getProvider } from '../../providers/registry.ts';

/**
 * Сессионный режим OpenCode (IDEA-8). Настоящий `opencode serve` здесь не
 * запускается НИ РАЗУ: `spawn` и `fetch` подменены (живой прогон —
 * `tools/qa/check-cli-opencode.mjs`). Проверяем то, ради чего он и делался, —
 * что диалог держит CLI (наружу уходит только новое сообщение), что сервер
 * поднимается ОДИН на все запросы, что любая заминка до начала работы молча
 * возвращает панель к one-shot, и что «Разрешить правки» доходит до CLI:
 * правила сессии и ответы на его просьбы.
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

/** Умолчание агента `build` у OpenCode 1.18.34 (`opencode debug agent build`), сокращённо. */
const BUILD_DEFAULT: OpencodePermissionRule[] = [
  { permission: '*', pattern: '*', action: 'allow' },
  { permission: 'doom_loop', pattern: '*', action: 'ask' },
  { permission: 'external_directory', pattern: '*', action: 'ask' },
  { permission: 'read', pattern: '*.env', action: 'ask' },
];

interface FakeServerOptions {
  agents?: unknown;
  config?: unknown;
  /** Ответ на сообщение; по умолчанию — один текстовый кусок. */
  message?: (body: unknown) => unknown;
  /** Ждущие просьбы, которые сервер покажет при опросе (пока на них не ответили). */
  pending?: { id: string; sessionID: string; permission: string; patterns: string[] }[];
  /** Сообщение держится, пока на все просьбы не ответили. */
  holdUntilAnswered?: boolean;
}

/** Подделка сервера OpenCode по путям его спецификации; пишет каждый запрос. */
function fakeServer(options: FakeServerOptions = {}) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const replies: { id: string; body: unknown }[] = [];
  let sessions = 0;
  const pending = [...(options.pending ?? [])];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const path = href.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', url: href, body });
    if (path === '/global/health') return okHealth();
    if (path === '/config') return jsonResponse(options.config ?? {});
    if (path === '/agent') {
      return jsonResponse(
        options.agents ?? [
          { name: 'build', mode: 'primary', permission: BUILD_DEFAULT, options: {} },
        ],
      );
    }
    if (path === '/session') {
      sessions += 1;
      return jsonResponse({ id: `ses_${sessions}` });
    }
    if (path === '/permission') return jsonResponse(pending);
    const reply = path.match(/^\/permission\/([^/]+)\/reply$/);
    if (reply) {
      replies.push({ id: decodeURIComponent(reply[1]!), body });
      const index = pending.findIndex((ask) => ask.id === decodeURIComponent(reply[1]!));
      if (index >= 0) pending.splice(index, 1);
      return jsonResponse(true);
    }
    if (/^\/session\/[^/]+\/message$/.test(path)) {
      if (options.holdUntilAnswered) {
        for (let i = 0; i < 200 && pending.length > 0; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      return jsonResponse(
        options.message?.(body) ?? { info: {}, parts: [{ type: 'text', text: 'Привет!' }] },
      );
    }
    return { ok: false, json: async () => ({}) } as unknown as Response;
  });
  return { fetchImpl, calls, replies };
}

const depsOf = (fetchImpl: unknown, extra: Record<string, unknown> = {}) => ({
  command: 'opencode',
  spawnImpl: (() => fakeChild()) as never,
  fetchImpl: fetchImpl as never,
  port: 4096,
  permissionPollMs: 1,
  ...extra,
});

/**
 * Решение OpenCode по набору правил: последнее подходящее правило побеждает
 * (`*` — что угодно), правила сессии идут после правил агента. Так OpenCode
 * 1.18.34 решал в живом прогоне: вопрос сессии перекрыл явный запрет конфига.
 */
function decide(rules: OpencodePermissionRule[], permission: string, target: string): string {
  const match = (value: string, pattern: string) =>
    new RegExp(
      `^${pattern
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    ).test(value);
  const hit = [...rules]
    .reverse()
    .find((rule) => match(permission, rule.permission) && match(target, rule.pattern));
  return hit?.action ?? 'ask';
}

describe('OpencodeServe: локальный сервер и сессии', () => {
  it('свободный порт выдаётся ОС и не равен нулю', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
  });

  it('поднимает сервер один раз, создаёт сессию и шлёт только новое сообщение', async () => {
    const spawnImpl = vi.fn(() => fakeChild());
    const { fetchImpl, calls } = fakeServer();

    const serve = new OpencodeServe();
    const deps = depsOf(fetchImpl, { spawnImpl });

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
    // Наружу уходит ТОЛЬКО новое сообщение: истории в теле нет. Агент — тот, чьи
    // правила взяты в набор сессии.
    expect(messages[0]?.body).toEqual({
      agent: 'build',
      parts: [{ type: 'text', text: 'первый вопрос' }],
    });
    expect(messages[1]?.body).toEqual({
      agent: 'build',
      parts: [{ type: 'text', text: 'второй вопрос' }],
    });

    // Сервер слушает только петлю — наружу его не выставляем.
    expect(JSON.stringify(spawnImpl.mock.calls[0] ?? [])).toContain('127.0.0.1');

    serve.dispose();
    expect(serve.currentBaseUrl()).toBeUndefined();
  });

  it('снятие посреди старта снимает и поднимающийся процесс, а не оставляет его сиротой', async () => {
    const child = fakeChild();
    const kill = vi.spyOn(child, 'kill');
    const serve = new OpencodeServe();
    let healthy!: () => void;
    const health = new Promise<void>((resolve) => (healthy = resolve));
    const asked = serve.ask('conv-1', 'вопрос', {
      command: 'opencode',
      spawnImpl: vi.fn(() => child) as never,
      // Health отвечает только после снятия — так сервер поднимается у панели,
      // которая уже закрывается.
      fetchImpl: (async () => {
        await health;
        return okHealth();
      }) as never,
      port: 4096,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    serve.dispose();
    expect(kill).toHaveBeenCalled();
    healthy();

    expect(await asked).toBeUndefined();
    expect(serve.currentBaseUrl()).toBeUndefined();
  });

  it('сервер не поднялся (health молчит) → undefined, процесс снят', async () => {
    const child = fakeChild();
    const kill = vi.spyOn(child, 'kill');
    const serve = new OpencodeServe();
    // Снятие идёт через общий `killChildTree`. У подделки нет кодов выхода, и
    // по номеру 4242 она не снимается (иначе тест снял бы настоящий процесс с
    // этим номером) — остаётся `child.kill()`. `taskkill` больше не зовётся вовсе.
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
    const spawnedTaskkill = (spawnImpl.mock.calls as unknown as unknown[][]).some(
      (call) => call[0] === 'taskkill',
    );
    expect(kill).toHaveBeenCalled();
    expect(spawnedTaskkill).toBe(false);
  });

  it('ответ не той формы (нет текстовых частей) → undefined, сессия забыта', async () => {
    // Части есть, но текстовых среди них нет — выдумывать ответ панель не станет.
    const { fetchImpl } = fakeServer({
      message: () => ({ info: {}, parts: [{ type: 'tool', name: 'bash' }] }),
    });
    const serve = new OpencodeServe();
    expect(await serve.ask('conv-1', 'вопрос', depsOf(fetchImpl))).toBeUndefined();
  });

  it('смерть процесса сервера забывает адрес и сессии: следующий запрос поднимает заново', async () => {
    const children = [fakeChild(), fakeChild()];
    let index = 0;
    const spawnImpl = vi.fn(() => children[index++]!);
    const { fetchImpl } = fakeServer();

    const serve = new OpencodeServe();
    const deps = depsOf(fetchImpl, { spawnImpl });

    await serve.ask('conv-1', 'первый', deps);
    children[0]!.emit('exit', 1);
    await serve.ask('conv-1', 'второй', deps);

    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });

  it('каталог разговора уходит каждым запросом (?directory=), смена каталога — новая сессия', async () => {
    const { fetchImpl, calls } = fakeServer();
    const serve = new OpencodeServe();
    const dir = 'C:/work/проект a';

    await serve.ask('conv-1', 'вопрос', depsOf(fetchImpl, { workdir: dir }));
    const scoped = calls.filter((call) => !call.url.endsWith('/global/health'));
    expect(scoped.length).toBeGreaterThan(0);
    for (const call of scoped) expect(call.url).toContain(`?directory=${encodeURIComponent(dir)}`);

    const second = await serve.ask('conv-1', 'ещё', depsOf(fetchImpl, { workdir: 'C:/work/b' }));
    expect(second?.sessionId).toBe('ses_2');
  });

  it('правила агента не прочитаны → сессии нет, undefined (one-shot как раньше)', async () => {
    const { fetchImpl, calls } = fakeServer({ agents: { not: 'an array' } });
    const serve = new OpencodeServe();
    expect(await serve.ask('conv-1', 'вопрос', depsOf(fetchImpl))).toBeUndefined();
    expect(calls.some((call) => call.url.includes('/session'))).toBe(false);
  });
});

describe('sessionPermissionRules: «можно по умолчанию» становится вопросом, решения человека — нет', () => {
  const evaluate = (agent: OpencodePermissionRule[], permission: string, target: string) =>
    decide([...agent, ...sessionPermissionRules(agent)], permission, target);

  it('умолчание OpenCode («*»: allow) → правка и команда спрашивают', () => {
    expect(decide(BUILD_DEFAULT, 'edit', 'src/a.ts')).toBe('allow');
    expect(evaluate(BUILD_DEFAULT, 'edit', 'src/a.ts')).toBe('ask');
    expect(evaluate(BUILD_DEFAULT, 'bash', 'echo hi > f')).toBe('ask');
  });

  it('прочие разрешения набор сессии не трогает', () => {
    const rules = sessionPermissionRules(BUILD_DEFAULT);
    expect(new Set(rules.map((rule) => rule.permission))).toEqual(new Set(['edit', 'bash']));
    expect(evaluate(BUILD_DEFAULT, 'read', 'src/a.ts')).toBe('allow');
  });

  it('явный запрет человека остаётся запретом — и целиком, и шаблоном', () => {
    const agent: OpencodePermissionRule[] = [
      ...BUILD_DEFAULT,
      { permission: 'bash', pattern: '*', action: 'deny' },
      { permission: 'edit', pattern: '*.lock', action: 'deny' },
    ];
    expect(evaluate(agent, 'bash', 'rm -rf x')).toBe('deny');
    expect(evaluate(agent, 'edit', 'pnpm.lock')).toBe('deny');
    expect(evaluate(agent, 'edit', 'src/a.ts')).toBe('ask');
  });

  it('явное «allow» человека для edit/bash — его решение, остаётся', () => {
    const agent: OpencodePermissionRule[] = [
      ...BUILD_DEFAULT,
      { permission: 'bash', pattern: '*', action: 'ask' },
      { permission: 'bash', pattern: 'git status*', action: 'allow' },
      { permission: 'edit', pattern: '*', action: 'allow' },
    ];
    expect(evaluate(agent, 'bash', 'git status --short')).toBe('allow');
    expect(evaluate(agent, 'bash', 'git push')).toBe('ask');
    expect(evaluate(agent, 'edit', 'src/a.ts')).toBe('allow');
  });

  it('шаблонный запрет («*»: deny) не ослабляется до вопроса', () => {
    const agent: OpencodePermissionRule[] = [
      ...BUILD_DEFAULT,
      { permission: '*', pattern: '*', action: 'deny' },
    ];
    expect(evaluate(agent, 'bash', 'ls')).toBe('deny');
    expect(evaluate(agent, 'edit', 'a.ts')).toBe('deny');
  });
});

describe('pickAgent: чьи правила брать', () => {
  const build = { name: 'build', mode: 'primary', permission: BUILD_DEFAULT };
  const mine = { name: 'mine', mode: 'primary', permission: [] };
  const sub = { name: 'helper', mode: 'subagent', permission: [] };

  it('default_agent из настроек, если это основной агент', () => {
    expect(pickAgent([build, mine], { default_agent: 'mine' })?.name).toBe('mine');
  });

  it('подагент или неизвестное имя → build', () => {
    expect(pickAgent([build, sub], { default_agent: 'helper' })?.name).toBe('build');
    expect(pickAgent([build], { default_agent: 'nope' })?.name).toBe('build');
  });

  it('правило не той формы или агента нет → undefined (fail-closed)', () => {
    expect(pickAgent([{ ...build, permission: [{ permission: 'bash' }] }], {})).toBeUndefined();
    expect(pickAgent([mine], {})).toBeUndefined();
    expect(pickAgent(undefined, {})).toBeUndefined();
  });
});

describe('OpencodeServe: просьбы о разрешении решает decidePermission', () => {
  const ask = { id: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: ['echo hi > f'] };

  it('сессия создаётся с набором правил из правил агента', async () => {
    const { fetchImpl, calls } = fakeServer();
    await new OpencodeServe().ask('conv-1', 'вопрос', depsOf(fetchImpl));
    const created = calls.find((call) => call.url.endsWith('/session'));
    expect(created?.body).toEqual({ permission: sessionPermissionRules(BUILD_DEFAULT) });
  });

  it('правки выключены, человек отказал → reject с причиной для модели, ровно один ответ', async () => {
    const { fetchImpl, replies } = fakeServer({ pending: [ask], holdUntilAnswered: true });
    const human = vi.fn(async () => 'deny' as const);
    const result = await new OpencodeServe().ask(
      'conv-1',
      'вопрос',
      depsOf(fetchImpl, { permission: { allowEdits: false, ask: human } }),
    );
    expect(human).toHaveBeenCalledTimes(1);
    expect(human).toHaveBeenCalledWith({
      cli: 'opencode',
      requestId: 'per_1',
      tool: 'bash',
      title: 'echo hi > f',
    });
    expect(replies).toEqual([
      { id: 'per_1', body: { reply: 'reject', message: OPENCODE_DECLINE_MESSAGE } },
    ]);
    expect(result).toMatchObject({ reply: 'Привет!' });
  });

  it('правки выключены, человек разрешил → once', async () => {
    const { fetchImpl, replies } = fakeServer({ pending: [ask], holdUntilAnswered: true });
    await new OpencodeServe().ask(
      'conv-1',
      'вопрос',
      depsOf(fetchImpl, { permission: { allowEdits: false, ask: async () => 'allow' } }),
    );
    expect(replies).toEqual([{ id: 'per_1', body: { reply: 'once' } }]);
  });

  it('правки включены → once без вопроса человеку', async () => {
    const { fetchImpl, replies } = fakeServer({ pending: [ask], holdUntilAnswered: true });
    const human = vi.fn(async () => 'deny' as const);
    await new OpencodeServe().ask(
      'conv-1',
      'вопрос',
      depsOf(fetchImpl, { permission: { allowEdits: true, ask: human } }),
    );
    expect(human).not.toHaveBeenCalled();
    expect(replies).toEqual([{ id: 'per_1', body: { reply: 'once' } }]);
  });

  it('прав не передали (ассистент формы) → отказ, молча «да» не бывает', async () => {
    const { fetchImpl, replies } = fakeServer({ pending: [ask], holdUntilAnswered: true });
    await new OpencodeServe().ask('conv-1', 'вопрос', depsOf(fetchImpl));
    expect(replies.map((item) => (item.body as { reply: string }).reply)).toEqual(['reject']);
  });

  it('чужая сессия — не наша просьба: не отвечаем', async () => {
    const foreign = { ...ask, id: 'per_x', sessionID: 'ses_other' };
    // Держим сообщение ~1 с: опрос успевает увидеть чужую просьбу много раз.
    const { fetchImpl, replies } = fakeServer({ pending: [foreign], holdUntilAnswered: true });
    await new OpencodeServe().ask(
      'conv-1',
      'вопрос',
      depsOf(fetchImpl, { permission: { allowEdits: true } }),
    );
    expect(replies).toEqual([]);
  });

  it('спрашивал, а текста нет → заметка, а не undefined (one-shot повторил бы работу мимо отказа)', async () => {
    const { fetchImpl } = fakeServer({
      pending: [ask],
      holdUntilAnswered: true,
      message: () => ({ info: {}, parts: [{ type: 'tool', state: { status: 'error' } }] }),
    });
    const result = await new OpencodeServe().ask(
      'conv-1',
      'вопрос',
      depsOf(fetchImpl, { permission: { allowEdits: false } }),
    );
    expect(result).toMatchObject({ reply: OPENCODE_STOPPED_REPLY });
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
