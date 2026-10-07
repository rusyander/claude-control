import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ConfigProvider } from '../../providers/types.ts';
import { ProviderChatService } from './ProviderChatService.ts';
import type { ProviderChatRunEvent, ProviderChatRunLike } from './ProviderChatRun.ts';
import { createChat, deleteChat, readChat } from './store.ts';

/**
 * Очередь чата чужого CLI: сообщение, написанное посреди ответа, ждёт его конца
 * на сервере и уходит само — по одному, в том порядке, в каком написано.
 * Каждый прогон — свой, под ручным управлением теста.
 */

class FakeRun implements ProviderChatRunLike {
  emit: ((event: ProviderChatRunEvent) => void) | undefined;
  prompt = '';

  start(
    options: { history: { content: string }[] },
    onEvent: (event: ProviderChatRunEvent) => void,
  ): Promise<void> {
    this.prompt = options.history.at(-1)?.content ?? '';
    this.emit = onEvent;
    return new Promise<void>(() => {});
  }

  stop(): void {
    this.emit?.({ type: 'done', reply: '', transport: 'stream' });
  }

  answer(text: string): void {
    this.emit?.({ type: 'done', reply: text, transport: 'stream' });
  }
}

const PROVIDER = { id: 'codex', name: 'Codex' } as ConfigProvider;

describe('ProviderChatService — очередь занятого разговора', () => {
  let dir: string;
  let runs: FakeRun[];
  let service: ProviderChatService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pchat-queue-'));
    runs = [];
    service = new ProviderChatService(() => {
      const run = new FakeRun();
      runs.push(run);
      return run as unknown as ProviderChatRunLike;
    });
    createChat(dir, 'codex', { id: 'chat' });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const send = (text: string): ReturnType<ProviderChatService['send']> =>
    service.send(dir, 'codex', 'chat', { text }, { provider: PROVIDER });
  const enqueue = (text: string): ReturnType<ProviderChatService['enqueue']> =>
    service.enqueue(dir, 'codex', 'chat', { text }, { provider: PROVIDER });
  const texts = (): string[] =>
    (readChat(dir, 'codex', 'chat')?.messages ?? []).map((item) => item.content);

  it('без идущего ответа не ставит: такой очереди некому было бы отпустить', () => {
    expect(enqueue('потом')).toBeUndefined();
    expect(service.status('chat').queued).toBeUndefined();
  });

  it('посреди ответа ставит, в переписку не пишет, статус показывает очередь', () => {
    send('первый');
    const queued = enqueue('добавь ещё тест');

    expect(queued).toMatchObject({ text: 'добавь ещё тест' });
    expect(texts()).toEqual(['первый']);
    expect(service.status('chat').queued).toEqual([queued]);
    // Опции отправки — внутренние, наружу не уходят.
    expect(service.status('chat').queued?.[0]).not.toHaveProperty('deps');
  });

  it('по концу ответа отпускает по одному и по порядку', () => {
    send('первый');
    enqueue('второй');
    enqueue('третий');

    runs[0]!.answer('ответ 1');
    expect(runs).toHaveLength(2);
    expect(runs[1]!.prompt).toContain('второй');
    expect(texts()).toEqual(['первый', 'ответ 1', 'второй']);
    expect(service.status('chat')).toMatchObject({ isRunning: true });
    expect(service.status('chat').queued?.map((item) => item.text)).toEqual(['третий']);

    runs[1]!.answer('ответ 2');
    expect(runs[2]!.prompt).toContain('третий');
    expect(service.status('chat').queued).toBeUndefined();
  });

  it('упавший ответ очередь тоже отпускает: сообщение человека не зависит от сбоя', () => {
    send('первый');
    enqueue('второй');
    runs[0]!.emit?.({ type: 'error', error: 'сбой', reason: 'cli_error' });

    expect(runs).toHaveLength(2);
    expect(runs[1]!.prompt).toContain('второй');
  });

  it('остановленный человеком ответ очередь не отпускает — она ждёт следующего конца', () => {
    send('первый');
    enqueue('второй');
    service.stopByHuman('chat');

    expect(runs).toHaveLength(1);
    expect(service.status('chat').queued?.map((item) => item.text)).toEqual(['второй']);

    send('новый вопрос');
    runs[1]!.answer('ответ');
    expect(runs[2]!.prompt).toContain('второй');
  });

  it('отмена убирает сообщение до отправки; второй раз — уже нечего', () => {
    send('первый');
    const queued = enqueue('передумал');

    expect(service.cancelQueued('chat', queued!.id)).toBe(true);
    expect(service.cancelQueued('chat', queued!.id)).toBe(false);
    runs[0]!.answer('ответ');
    expect(runs).toHaveLength(1);
  });

  it('разговор занял слушатель конца — сообщение ждёт конца ЕГО хода, а не теряется', () => {
    service.setFinishedListener(() => {
      service.send(dir, 'codex', 'chat', { text: 'звено конвейера' }, { provider: PROVIDER });
    });
    send('первый');
    enqueue('моё');
    runs[0]!.answer('ответ');

    expect(runs[1]!.prompt).toContain('звено конвейера');
    expect(service.status('chat').queued?.map((item) => item.text)).toEqual(['моё']);
  });

  it('удалённый разговор уносит очередь с собой', () => {
    send('первый');
    enqueue('второй');
    service.discard('chat');
    deleteChat(dir, 'codex', 'chat');

    expect(service.status('chat').queued).toBeUndefined();
    expect(runs).toHaveLength(1);
  });

  it('разговор исчез к концу ответа — очередь снимается, а не висит', () => {
    send('первый');
    enqueue('второй');
    deleteChat(dir, 'codex', 'chat');
    runs[0]!.answer('ответ');

    expect(service.status('chat').queued).toBeUndefined();
  });

  // Ф13: остановили ход — очередь сама не уйдёт; раньше её не было видно
  // как «ждущей», а после перезапуска панели она пропадала вовсе.
  it('после «Стоп» очередь «ждёт отправки» и уходит по кнопке', () => {
    send('первый');
    const queued = enqueue('второй');
    service.stopByHuman('chat');

    expect(service.status('chat')).toMatchObject({ isRunning: false, queueHeld: true });
    const outcome = service.sendQueued(dir, 'codex', 'chat', queued!.id, { provider: PROVIDER });
    expect(outcome.ok).toBe(true);
    expect(runs[1]!.prompt).toContain('второй');
    expect(service.status('chat').queued).toBeUndefined();
    expect(service.status('chat').queueHeld).toBeUndefined();
  });

  it('кнопка «Отправить» при идущем ответе — отказ, сообщение остаётся; нет сообщения — missing', () => {
    send('первый');
    const queued = enqueue('второй');

    expect(service.sendQueued(dir, 'codex', 'chat', queued!.id, { provider: PROVIDER })).toEqual({
      ok: false,
      reason: 'already_running',
    });
    expect(service.status('chat').queued?.map((item) => item.text)).toEqual(['второй']);
    service.stopByHuman('chat');
    expect(service.sendQueued(dir, 'codex', 'chat', 'нет-такого', { provider: PROVIDER })).toEqual({
      ok: false,
      missing: true,
    });
  });

  it('очередь переживает перезапуск панели: новый сервис видит её ждущей и отправляет', () => {
    send('первый');
    const queued = enqueue('написал до перезапуска');

    const fresh = new ProviderChatService(() => {
      const run = new FakeRun();
      runs.push(run);
      return run as unknown as ProviderChatRunLike;
    });
    fresh.hydrate(dir, 'codex', 'chat');
    expect(fresh.status('chat')).toMatchObject({
      isRunning: false,
      queueHeld: true,
      queued: [expect.objectContaining({ id: queued!.id, text: 'написал до перезапуска' })],
    });
    expect(fresh.sendQueued(dir, 'codex', 'chat', queued!.id, { provider: PROVIDER }).ok).toBe(
      true,
    );
    expect(runs.at(-1)!.prompt).toContain('написал до перезапуска');

    // Отправленное снято и с диска: третий сервис очереди уже не видит.
    const third = new ProviderChatService(() => new FakeRun() as unknown as ProviderChatRunLike);
    third.hydrate(dir, 'codex', 'chat');
    expect(third.status('chat').queued).toBeUndefined();
  });
});
