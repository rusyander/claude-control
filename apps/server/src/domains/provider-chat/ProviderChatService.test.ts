import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderChatEvent } from '@claude-control/contracts';
import type { ConfigProvider } from '../../providers/types.ts';
import { ProviderChatService, type ProviderChatSubscriber } from './ProviderChatService.ts';
import type { ProviderChatRunEvent, ProviderChatRunLike } from './ProviderChatRun.ts';
import { createChat, readChat } from './store.ts';

/**
 * Живые ответы чужого провайдера. Настоящий CLI здесь не запускается — прогон
 * подменён, и проверяется то, что принадлежит службе: запись результата в
 * переписку, доставка кусков подписчикам и поведение при остановке.
 */

/** Прогон под ручным управлением: события шлёт тест, когда захочет. */
class FakeRun implements ProviderChatRunLike {
  emit: ((event: ProviderChatRunEvent) => void) | undefined;
  stopped = false;
  options: unknown;

  start(options: unknown, onEvent: (event: ProviderChatRunEvent) => void): Promise<void> {
    this.options = options;
    this.emit = onEvent;
    return new Promise<void>((resolve) => {
      this.finish = resolve;
    });
  }

  stop(): void {
    this.stopped = true;
  }

  finish: () => void = () => {};
}

const PROVIDER = { id: 'codex', name: 'Codex' } as ConfigProvider;

describe('ProviderChatService', () => {
  let dir: string;
  let run: FakeRun;
  let service: ProviderChatService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pchat-svc-'));
    run = new FakeRun();
    service = new ProviderChatService(() => run);
    createChat(dir, 'codex', { id: 'chat' });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const send = (text = 'Вопрос'): ReturnType<ProviderChatService['send']> =>
    service.send(dir, 'codex', 'chat', { text }, { provider: PROVIDER });

  const collect = (): { events: ProviderChatEvent[]; closed: number } => {
    const state = { events: [] as ProviderChatEvent[], closed: 0 };
    const subscriber: ProviderChatSubscriber = {
      send: (event) => state.events.push(event),
      close: () => {
        state.closed += 1;
      },
    };
    service.subscribe('chat', subscriber);
    return state;
  };

  it('записывает вопрос сразу, не дожидаясь ответа', () => {
    const outcome = send('Почини сборку');

    expect(outcome.ok).toBe(true);
    expect(outcome.message?.content).toBe('Почини сборку');
    expect(readChat(dir, 'codex', 'chat')?.messages).toHaveLength(1);
  });

  it('отдаёт куски подписчикам и копит их в состоянии', () => {
    send();
    const seen = collect();

    run.emit?.({ type: 'delta', text: 'Раз' });
    run.emit?.({ type: 'delta', text: ' два' });

    expect(seen.events).toEqual([
      { type: 'delta', text: 'Раз' },
      { type: 'delta', text: ' два' },
    ]);
    expect(service.status('chat')).toMatchObject({ isRunning: true, partial: 'Раз два' });
  });

  it('дописывает готовый ответ в переписку и закрывает подписчиков', () => {
    send();
    const seen = collect();

    run.emit?.({ type: 'done', reply: 'Готово', transport: 'stream' });

    const messages = readChat(dir, 'codex', 'chat')?.messages ?? [];
    expect(messages.map((message) => message.content)).toEqual(['Вопрос', 'Готово']);
    expect(messages[1]?.transport).toBe('stream');
    expect(seen.events.at(-1)?.type).toBe('done');
    expect(seen.closed).toBe(1);
    expect(service.status('chat').isRunning).toBe(false);
  });

  it('ошибку тоже сохраняет — но помечает, чтобы она не ушла в контекст', () => {
    send();
    const seen = collect();

    run.emit?.({ type: 'error', error: 'CLI не найден', reason: 'cli_error' });

    const last = readChat(dir, 'codex', 'chat')?.messages.at(-1);
    expect(last).toMatchObject({ role: 'assistant', content: 'CLI не найден', failed: true });
    expect(seen.events.at(-1)).toEqual({
      type: 'error',
      error: 'CLI не найден',
      reason: 'cli_error',
    });
  });

  it('отказывает во втором вопросе, пока идёт ответ на первый', () => {
    send();

    expect(send('Ещё')).toEqual({ ok: false, reason: 'already_running' });
    expect(readChat(dir, 'codex', 'chat')?.messages).toHaveLength(1);
  });

  it('после завершения ответа принимает следующий вопрос', () => {
    send();
    run.emit?.({ type: 'done', reply: 'Готово', transport: 'stream' });

    expect(send('Ещё').ok).toBe(true);
  });

  it('несуществующий разговор — отказ, а не пустой прогон', () => {
    const outcome = service.send(dir, 'codex', 'missing', { text: 'Э' }, { provider: PROVIDER });

    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
  });

  it('остановка гасит прогон и сообщает об этом сразу', () => {
    send();
    const seen = collect();

    expect(service.stop('chat')).toBe(true);
    expect(run.stopped).toBe(true);
    expect(seen.events).toContainEqual({ type: 'stopped' });
  });

  it('сказанное до остановки остаётся ответом', () => {
    send();
    service.stop('chat');
    run.emit?.({ type: 'done', reply: 'Половина', transport: 'stream' });

    expect(readChat(dir, 'codex', 'chat')?.messages.at(-1)?.content).toBe('Половина');
  });

  it('останавливать нечего — честное «нет»', () => {
    expect(service.stop('chat')).toBe(false);
  });

  it('гасит все прогоны разом', () => {
    send();
    service.stopAll();

    expect(run.stopped).toBe(true);
  });

  it('подписка живёт до отписки, дальше кусков не получает', () => {
    send();
    const state: ProviderChatEvent[] = [];
    const unsubscribe = service.subscribe('chat', {
      send: (event) => state.push(event),
      close: () => {},
    });

    run.emit?.({ type: 'delta', text: 'Раз' });
    unsubscribe();
    run.emit?.({ type: 'delta', text: 'Два' });

    expect(state).toEqual([{ type: 'delta', text: 'Раз' }]);
  });

  it('подписка на уже законченный ответ закрывается сразу', () => {
    let closed = 0;
    service.subscribe('chat', { send: () => {}, close: () => (closed += 1) });

    expect(closed).toBe(1);
  });

  it('состояние неизвестного разговора не притворяется идущим', () => {
    expect(service.status('nobody')).toEqual({ chatId: 'nobody', isRunning: false, partial: '' });
  });

  it('передаёт прогону переписку вместе с новым вопросом и рабочий каталог', () => {
    createChat(dir, 'codex', { id: 'wd', workdir: dir });
    service.send(dir, 'codex', 'wd', { text: 'Вопрос' }, { provider: PROVIDER });

    expect(run.options).toMatchObject({ chatId: 'wd', appDataDir: dir, workdir: dir });
    expect((run.options as { history: unknown[] }).history).toHaveLength(1);
  });

  it('упавший прогон превращается в ошибку разговора, а не в тишину', async () => {
    const broken: ProviderChatRunLike = {
      start: () => Promise.reject(new Error('всё сломалось')),
      stop: () => {},
    };
    const failing = new ProviderChatService(() => broken);
    failing.send(dir, 'codex', 'chat', { text: 'Вопрос' }, { provider: PROVIDER });

    await vi.waitFor(() => {
      expect(readChat(dir, 'codex', 'chat')?.messages.at(-1)).toMatchObject({
        failed: true,
        content: 'всё сломалось',
      });
    });
  });
});
