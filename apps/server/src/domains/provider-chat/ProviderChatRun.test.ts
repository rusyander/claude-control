import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderChatMessage } from '@claude-control/contracts';
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

  it('отдаёт текст кусками по мере печати', async () => {
    const spawn = fakeSpawn({ chunks: ['Пер', 'вый ответ'] });

    const events = await collect('gemini', { detect: yesCli, spawnImpl: spawn.fn });

    expect(events.filter((event) => event.type === 'delta').map((event) => event.text)).toEqual([
      'Пер',
      'вый ответ',
    ]);
    expect(events.at(-1)).toEqual({ type: 'done', reply: 'Первый ответ', transport: 'stream' });
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
});
