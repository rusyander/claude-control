import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ADOPTED_NOTICE, DETACHED_DONE_NOTICE, DetachedRun } from './detached-run.ts';
import type { ChatEvent } from './chat-events.ts';

/**
 * Усыновлённый прогон: процесс жив, трубы нет. Конец — по смерти pid, остановка —
 * по pid же, а лента узнаёт о подхвате и о конце заметками.
 */
describe('DetachedRun — прогон без потока', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('на старте — заметка о подхвате; смерть pid даёт заметку и done без цены', async () => {
    let alive = true;
    const events: ChatEvent[] = [];
    const run = new DetachedRun(42, Date.now() - 5_000, {
      isAlive: () => alive,
      kill: () => undefined,
      pollMs: 100,
    });

    const finished = run.start({}, (event) => events.push(event));
    expect(events).toEqual([{ kind: 'notice', code: 'adopted', text: ADOPTED_NOTICE }]);

    // Пока процесс жив, опрос молчит.
    vi.advanceTimersByTime(250);
    expect(events).toHaveLength(1);

    alive = false;
    vi.advanceTimersByTime(100);
    await finished;

    expect(events.map((event) => event.kind)).toEqual(['notice', 'notice', 'done']);
    expect(events[1]).toEqual({ kind: 'notice', code: 'detachedDone', text: DETACHED_DONE_NOTICE });
    const done = events[2];
    expect(done?.kind === 'done' ? done.costUsd : -1).toBe(0);
    expect(done?.kind === 'done' ? done.durationMs : -1).toBeGreaterThanOrEqual(5_000);
    // После конца опрос снят — новых событий не будет.
    vi.advanceTimersByTime(1_000);
    expect(events).toHaveLength(3);
  });

  it('stop валит дерево по pid и закрывает прогон, не дожидаясь опроса', async () => {
    const kill = vi.fn();
    const events: ChatEvent[] = [];
    const run = new DetachedRun(42, 0, { isAlive: () => true, kill, pollMs: 100 });
    const finished = run.start({}, (event) => events.push(event));

    run.stop();
    await finished;

    expect(kill).toHaveBeenCalledWith(42);
    vi.advanceTimersByTime(1_000);
    // Остановленный молчит: ни заметки о конце, ни done — как настоящий прогон.
    expect(events.map((event) => event.kind)).toEqual(['notice']);
  });

  it('отказ убить процесс не мешает закрыть прогон', async () => {
    const run = new DetachedRun(42, 0, {
      isAlive: () => true,
      kill: () => {
        throw new Error('access denied');
      },
      pollMs: 100,
    });
    const finished = run.start({}, () => undefined);
    expect(() => run.stop()).not.toThrow();
    await expect(finished).resolves.toBeUndefined();
  });
});
