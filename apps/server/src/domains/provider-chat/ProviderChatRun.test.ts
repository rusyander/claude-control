import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderChatMessage } from '@agentdeck/contracts';
import { getProvider } from '../../providers/registry.ts';
import { setStoredKey } from '../../lib/provider-keys.ts';
import { ProviderChatRun, type ProviderChatRunEvent } from './ProviderChatRun.ts';

/**
 * Один ответ чужого провайдера. Ни настоящего CLI, ни сети: spawn и fetch
 * подменены. Проверяется то, ради чего эта ветка существует, — что текст
 * приходит кусками по мере печати, что остановка не выбрасывает сказанное, и
 * что Claude сюда не попадает.
 */

const yesCli = (): boolean => true;
const noCli = (): boolean => false;

/** Фейковый CLI: печатает заданные куски и закрывается. */
function fakeSpawn(options: { chunks?: string[]; stderr?: string; code?: number }) {
  const handles: { kill: () => void }[] = [];

  const fn = (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: () => void; end: () => void; on: () => void };
      kill: () => void;
      pid?: number;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => {}, on: () => {} };
    child.kill = () => child.emit('close', null);
    handles.push(child);

    setTimeout(() => {
      for (const chunk of options.chunks ?? []) child.stdout.emit('data', Buffer.from(chunk));
      if (options.stderr) child.stderr.emit('data', Buffer.from(options.stderr));
      if (options.chunks !== undefined || options.stderr !== undefined) {
        child.emit('close', options.code ?? 0);
      }
    }, 0);

    return child;
  }) as unknown as Parameters<ProviderChatRun['start']>[0]['spawnImpl'];

  return { fn, handles };
}

function history(text: string): ProviderChatMessage[] {
  return [{ id: 'm1', role: 'user', content: text, at: '2026-01-01T00:00:00.000Z' }];
}

describe('ProviderChatRun', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pchat-run-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const collect = async (
    providerId: string,
    extra: Record<string, unknown> = {},
  ): Promise<ProviderChatRunEvent[]> => {
    const events: ProviderChatRunEvent[] = [];
    await new ProviderChatRun().start(
      {
        provider: getProvider(providerId),
        history: history('Вопрос'),
        chatId: 'chat',
        appDataDir: dir,
        ...extra,
      } as Parameters<ProviderChatRun['start']>[0],
      (event) => events.push(event),
    );
    return events;
  };

  /**
   * Надзиратель рантайма (П3.2). Хук здесь НАСТОЯЩИЙ — скрипт на диске,
   * запущенный настоящей оболочкой: подменённый хук доказывал бы подмену, а не
   * запрет. Подменён только чужой CLI, то есть внешняя граница.
   */
  const hookAt = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, body, 'utf8');
    return `node "${path}"`;
  };

  const supervisorSetup = (hooks: { event: string; command: string }[]) => ({
    run: {
      providerId: 'gemini',
      sessionId: 'chat',
      cwd: dir,
      transcriptPath: join(dir, 'chat.jsonl'),
    },
    hooks,
  });

  it('хук, отказавший на UserPromptSubmit, не даёт прогону начаться', async () => {
    const spawn = fakeSpawn({ chunks: ['ответ, которого быть не должно'] });
    const trace = join(dir, 'trace.json');
    const command = hookAt(
      'deny.cjs',
      `const fs = require('node:fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(trace)}, Buffer.concat(chunks).toString('utf8'), 'utf8');
  process.stderr.write('запрос запрещён политикой');
  process.exit(2);
});`,
    );

    const events = await collect('gemini', {
      detect: yesCli,
      spawnImpl: spawn.fn,
      supervisor: supervisorSetup([{ event: 'UserPromptSubmit', command }]),
    });

    // Хук действительно сработал и получил нагрузку — иначе «не запустилось»
    // означало бы, что прогон отказан по другой причине.
    const seen = JSON.parse(readFileSync(trace, 'utf8')) as Record<string, unknown>;
    expect(seen.hook_event_name).toBe('UserPromptSubmit');
    expect(seen.prompt).toBe('Вопрос');

    // Чужой CLI не запускался вовсе.
    expect(spawn.handles).toHaveLength(0);

    const last = events.at(-1);
    expect(last?.type).toBe('error');
    if (last?.type === 'error') {
      expect(last.reason).toBe('hook_blocked');
      // Человеку показывают причину, а не «CLI упал».
      expect(last.error.length).toBeGreaterThan(0);
    }
  });

  it('промолчавший хук прогон не отказывает', async () => {
    // Второе утверждение этого случая — про КАНАЛ контекста — здесь не делается
    // намеренно. `additionalContext` встаёт отдельной репликой, то есть делает
    // запрос многострочным, а многострочный запрос панель отказывается отправлять
    // через `.cmd`-обёртку (Windows обрезает команду на первом переводе строки).
    // Ограничение это платформенное и общее с `systemPrefix`, поэтому исход
    // прогона тут зависит от того, как установлен CLI на машине, — проверять по
    // нему нечего. Здесь доказывается только то, за что отвечает надзиратель:
    // промолчавший хук прогон не отказывает.
    const spawn = fakeSpawn({ chunks: ['ок'] });
    const command = hookAt(
      'context.cjs',
      `process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { additionalContext: 'СЕГОДНЯ ПЯТНИЦА' },
  }));
  process.exit(0);
});`,
    );

    const events = await collect('gemini', {
      detect: yesCli,
      spawnImpl: spawn.fn,
      supervisor: supervisorSetup([{ event: 'UserPromptSubmit', command }]),
    });

    const blockedByHook = events.some(
      (event) => event.type === 'error' && event.reason === 'hook_blocked',
    );
    expect(blockedByHook).toBe(false);
  });

  it('отдаёт текст кусками по мере печати', async () => {
    const spawn = fakeSpawn({ chunks: ['Пер', 'вый ответ'] });

    const events = await collect('gemini', { detect: yesCli, spawnImpl: spawn.fn });

    expect(events.filter((event) => event.type === 'delta').map((event) => event.text)).toEqual([
      'Пер',
      'вый ответ',
    ]);
    expect(events.at(-1)).toEqual({ type: 'done', reply: 'Первый ответ', transport: 'stream' });
  });

  it('подобранная модель уезжает в командную строку CLI', async () => {
    // Т12: главное здесь — что назначение доходит до argv ровно один раз и
    // задокументированным ключом. Промпт при этом остаётся ОТДЕЛЬНЫМ элементом,
    // как и был: подстановки в строку оболочки на этом пути нет вовсе.
    const seen: { command: string; args: string[] }[] = [];
    const spawn = fakeSpawn({ chunks: ['ок'] });
    const spawnImpl = ((command: string, args: string[], options: unknown) => {
      seen.push({ command, args });
      return (spawn.fn as unknown as (c: string, a: string[], o: unknown) => unknown)(
        command,
        args,
        options,
      );
    }) as unknown as Parameters<ProviderChatRun['start']>[0]['spawnImpl'];

    await collect('codex', {
      detect: yesCli,
      spawnImpl,
      model: 'gpt-5.3-codex-spark',
      effort: 'medium',
    });

    // Командная строка целиком: на Windows cross-spawn собирает её в ОДНУ строку
    // для `cmd.exe /c`, и сравнивать поэлементно там нечего. Ключи подбора
    // пробелов и кавычек не содержат — им эта склейка ничем не грозит.
    const line = [seen[0]?.command, ...(seen[0]?.args ?? [])].join(' ');
    expect(line).toContain('exec');
    expect(line).toContain('-m gpt-5.3-codex-spark');
    expect(line).toContain('model_reasoning_effort=medium');
    expect(line).toContain('Вопрос');
  });

  it('без подбора командная строка остаётся прежней', async () => {
    const seen: string[] = [];
    const spawn = fakeSpawn({ chunks: ['ок'] });
    const spawnImpl = ((command: string, args: string[], options: unknown) => {
      seen.push([command, ...args].join(' '));
      return (spawn.fn as unknown as (c: string, a: string[], o: unknown) => unknown)(
        command,
        args,
        options,
      );
    }) as unknown as Parameters<ProviderChatRun['start']>[0]['spawnImpl'];

    await collect('codex', { detect: yesCli, spawnImpl });

    // Ни `-m`, ни `-c`: CLI работает своей настроенной моделью — она и есть
    // потолок, которого панель не знает.
    expect(seen[0]).not.toContain('-m ');
    expect(seen[0]).not.toContain('model_reasoning_effort');
    expect(seen[0]).toContain('exec');
  });

  it('не рвёт кириллицу на границе кусков', async () => {
    const run = new ProviderChatRun();
    const events: ProviderChatRunEvent[] = [];

    // Режем по живому байту посреди буквы: без потокового декодера здесь были
    // бы «крокозябры» ровно на стыке кусков.
    const bytes = Buffer.from('Ответ модели', 'utf8');
    const halves = [bytes.subarray(0, 5), bytes.subarray(5)];
    const spawnImpl = (() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => child.emit('close', null);
      setTimeout(() => {
        for (const half of halves) child.stdout.emit('data', half);
        child.emit('close', 0);
      }, 0);
      return child;
    }) as unknown as Parameters<ProviderChatRun['start']>[0]['spawnImpl'];

    await run.start(
      {
        provider: getProvider('gemini'),
        history: history('Вопрос'),
        chatId: 'chat',
        appDataDir: dir,
        detect: yesCli,
        spawnImpl,
      } as Parameters<ProviderChatRun['start']>[0],
      (event) => events.push(event),
    );

    expect(events.at(-1)).toEqual({ type: 'done', reply: 'Ответ модели', transport: 'stream' });
  });

  it('код возврата не ноль — ошибка с текстом от CLI, а не пустой ответ', async () => {
    const spawn = fakeSpawn({ chunks: [], stderr: 'не найдена модель', code: 2 });

    const events = await collect('gemini', { detect: yesCli, spawnImpl: spawn.fn });

    expect(events.at(-1)).toEqual({
      type: 'error',
      error: 'не найдена модель',
      reason: 'cli_error',
    });
  });

  it('сказанное до остановки остаётся ответом', async () => {
    const run = new ProviderChatRun();
    const events: ProviderChatRunEvent[] = [];

    const spawnImpl = (() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
        pid?: number;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => child.emit('close', null);
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from('Половина ответа'));
        // Дальше процесс живёт, пока его не снимут кнопкой.
        run.stop();
      }, 0);
      return child;
    }) as unknown as Parameters<ProviderChatRun['start']>[0]['spawnImpl'];

    await run.start(
      {
        provider: getProvider('gemini'),
        history: history('Вопрос'),
        chatId: 'chat',
        appDataDir: dir,
        detect: yesCli,
        spawnImpl,
      } as Parameters<ProviderChatRun['start']>[0],
      (event) => events.push(event),
    );

    expect(events.at(-1)).toEqual({ type: 'done', reply: 'Половина ответа', transport: 'stream' });
  });

  it('Claude сюда не попадает — у него свой чат', async () => {
    const events = await collect('claude', { detect: yesCli });

    expect(events).toEqual([
      {
        type: 'error',
        error: 'Claude ведёт свой собственный чат — этот путь для него не используется.',
        reason: 'unsupported',
      },
    ]);
  });

  it('без CLI и без ключа — понятный отказ, а не молчание', async () => {
    const events = await collect('gemini', { detect: noCli });

    expect(events.at(-1)).toMatchObject({ reason: 'no_key_no_cli' });
  });

  it('CLI нет, ключ есть — ответ приходит через API', async () => {
    setStoredKey(dir, 'gemini', 'test-key');
    const fetchImpl = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ candidates: [{ content: { parts: [{ text: 'ответ API' }] } }] }),
      })) as unknown as typeof fetch;

    const events = await collect('gemini', { detect: noCli, fetchImpl });

    expect(events.at(-1)).toEqual({ type: 'done', reply: 'ответ API', transport: 'api' });
  });

  it('сессия провайдера идёт первой, а её отсутствие роняет в поток', async () => {
    const spawn = fakeSpawn({ chunks: ['через поток'] });
    const sessionServe = { ask: () => Promise.resolve(undefined) };

    const events = await collect('opencode', {
      detect: yesCli,
      spawnImpl: spawn.fn,
      sessionServe,
    });

    expect(events.at(-1)).toMatchObject({ transport: 'stream' });
  });

  it('сессия ответила — CLI одноразово не запускается', async () => {
    const sessionServe = { ask: () => Promise.resolve({ reply: 'из сессии' }) };

    const events = await collect('opencode', { detect: yesCli, sessionServe });

    expect(events.at(-1)).toEqual({ type: 'done', reply: 'из сессии', transport: 'session' });
  });

  it('остановка на пути API обрывает запрос, и поздний ответ не попадает в переписку', async () => {
    setStoredKey(dir, 'gemini', 'test-key');
    const run = new ProviderChatRun();
    const events: ProviderChatRunEvent[] = [];
    let aborted = false;

    // Запрос «висит», пока его не отменят сигналом, — как настоящая сеть.
    const fetchImpl = ((_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      })) as unknown as typeof fetch;

    setTimeout(() => run.stop(), 0);
    await run.start(
      {
        provider: getProvider('gemini'),
        history: history('Вопрос'),
        chatId: 'chat',
        appDataDir: dir,
        detect: noCli,
        fetchImpl,
      },
      (event) => events.push(event),
    );

    expect(aborted).toBe(true);
    expect(events).toEqual([{ type: 'done', reply: '', transport: 'api' }]);
  });

  it('остановка сессии OpenCode не уходит ни в одиночный запуск, ни в API', async () => {
    setStoredKey(dir, 'opencode', 'test-key');
    const run = new ProviderChatRun();
    const events: ProviderChatRunEvent[] = [];
    const spawn = fakeSpawn({ chunks: ['лишний ответ'] });
    let sawSignal: AbortSignal | undefined;

    const sessionServe = {
      ask: (_id: string, _text: string, deps: { signal?: AbortSignal }) =>
        new Promise<undefined>((resolve) => {
          sawSignal = deps.signal;
          deps.signal?.addEventListener('abort', () => resolve(undefined));
        }),
    } as unknown as NonNullable<Parameters<ProviderChatRun['start']>[0]['sessionServe']>;

    setTimeout(() => run.stop(), 0);
    await run.start(
      {
        provider: getProvider('opencode'),
        history: history('Вопрос'),
        chatId: 'chat',
        appDataDir: dir,
        detect: yesCli,
        spawnImpl: spawn.fn,
        sessionServe,
      },
      (event) => events.push(event),
    );

    expect(sawSignal?.aborted).toBe(true);
    expect(spawn.handles).toHaveLength(0);
    expect(events).toEqual([{ type: 'done', reply: '', transport: 'session' }]);
  });
});
