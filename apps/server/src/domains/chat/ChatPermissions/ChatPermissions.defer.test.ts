import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionBroker, type PermissionRequest } from './ChatPermissions.ts';

/**
 * Срок «отложить» карточки одиночного чата (решение 1): без ответа за N минут
 * карточка сама становится D-n, агент получает отказ «поставлено человеку», а
 * кнопки той же карточки потом отвечают записи.
 */
const REQ: PermissionRequest = { runId: 'c1', toolName: 'Bash', input: {}, toolUseId: 't1' };

describe('ChatPermissions › срок «отложить»', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('без ответа за срок — отказ D-n, номер запомнен, поздний клик карточку не воскрешает', async () => {
    const broker = new PermissionBroker();
    const made: string[] = [];
    const answer = broker.request(REQ, undefined, {
      afterMs: 10 * 60_000,
      reply: () => {
        made.push('D-3');
        return { reply: { behavior: 'deny', message: 'agentdeck(deferred D-3) …' }, id: 'D-3' };
      },
    });
    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(made).toEqual([]);
    vi.advanceTimersByTime(1);
    await expect(answer).resolves.toEqual({
      behavior: 'deny',
      message: 'agentdeck(deferred D-3) …',
    });
    expect(made).toEqual(['D-3']);
    expect(broker.deferredIdOf('c1', 't1')).toBe('D-3');
    expect(broker.hasPending('c1')).toBe(false);
    expect(broker.answer('c1', 't1', { behavior: 'allow' })).toBe('unknown');
  });

  it('ответ до срока — срок не срабатывает', async () => {
    const broker = new PermissionBroker();
    const reply = vi.fn(() => ({ reply: { behavior: 'deny' as const }, id: 'D-1' }));
    const answer = broker.request(REQ, undefined, { afterMs: 1_000, reply });
    expect(broker.answer('c1', 't1', { behavior: 'allow' })).toBe('ok');
    await expect(answer).resolves.toEqual({ behavior: 'allow' });
    vi.advanceTimersByTime(5_000);
    expect(reply).not.toHaveBeenCalled();
    expect(broker.deferredIdOf('c1', 't1')).toBeUndefined();
  });

  it('запись не вышла — карточка остаётся ждать человека; 0 — не откладывать', async () => {
    const broker = new PermissionBroker();
    const answer = broker.request(REQ, undefined, { afterMs: 1_000, reply: () => undefined });
    vi.advanceTimersByTime(2_000);
    expect(broker.hasPending('c1')).toBe(true);
    broker.answer('c1', 't1', { behavior: 'deny', message: 'нет' });
    await expect(answer).resolves.toMatchObject({ behavior: 'deny', message: 'нет' });

    const never = vi.fn(() => ({ reply: { behavior: 'deny' as const } }));
    void broker.request({ ...REQ, toolUseId: 't2' }, undefined, { afterMs: 0, reply: never });
    vi.advanceTimersByTime(60 * 60_000);
    expect(never).not.toHaveBeenCalled();
    expect(broker.hasPending('c1')).toBe(true);
  });
});
