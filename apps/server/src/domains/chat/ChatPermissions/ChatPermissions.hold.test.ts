import { describe, it, expect, vi, afterEach } from 'vitest';
import { EARLY_ANSWER_MS, PermissionBroker, type ChatPermissionReply } from './ChatPermissions.ts';

/**
 * Клик раньше вопроса. После перезапуска панели карточка в открытой вкладке
 * кликабельна раньше, чем мост прав повторит вопрос новому серверу: свежий
 * брокер запроса не знает. Прежде клик пропадал («нет такого»), а повторный
 * вопрос ждал второго клика, которого никто не делал, — ход вставал.
 */

const ALLOW: ChatPermissionReply = { behavior: 'allow' };
const ask = { runId: 'run-1', toolName: 'Bash', input: { command: 'ls' }, toolUseId: 't1' };

/** Решено ли обещание прямо сейчас (без ожидания таймеров). */
async function settled<T>(promise: Promise<T>): Promise<{ done: boolean; value?: T }> {
  const marker = Symbol('pending');
  const value = await Promise.race([promise, Promise.resolve(marker)]);
  return value === marker ? { done: false } : { done: true, value: value as T };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ответ раньше вопроса: удержание до повтора моста', () => {
  it('живой разговор: ответ отложен и выдан повтору вопроса сразу', async () => {
    const broker = new PermissionBroker();
    expect(broker.answer('run-1', 't1', ALLOW, { hold: true })).toBe('held');
    const reply = await settled(broker.request(ask));
    expect(reply).toEqual({ done: true, value: ALLOW });
    // Отложенный ответ расходуется один раз: второй вопрос ждёт человека.
    const again = await settled(broker.request(ask));
    expect(again.done).toBe(false);
    broker.cancelRun('run-1');
  });

  it('без удержания — прежнее «нет такого», вопрос ждёт клика', async () => {
    const broker = new PermissionBroker();
    expect(broker.answer('run-1', 't1', ALLOW)).toBe('unknown');
    const reply = await settled(broker.request(ask));
    expect(reply.done).toBe(false);
    broker.cancelRun('run-1');
  });

  it('умерший запрос — «истекло», удержание его не оживляет', async () => {
    const broker = new PermissionBroker();
    const first = broker.request(ask);
    broker.expire('t1');
    await first;
    expect(broker.answer('run-1', 't1', ALLOW, { hold: true })).toBe('expired');
  });

  it('уже отвеченный — «нет такого»: опоздавшее второе устройство не откладывает ответ', async () => {
    const broker = new PermissionBroker();
    const first = broker.request(ask);
    expect(broker.answer('run-1', 't1', ALLOW, { hold: true })).toBe('ok');
    await first;
    expect(broker.answer('run-1', 't1', { behavior: 'deny' }, { hold: true })).toBe('unknown');
  });

  it('CLI закончил вызов сам — отложенный ответ снят и не достаётся повтору', async () => {
    const broker = new PermissionBroker();
    expect(broker.answer('run-1', 't1', ALLOW, { hold: true })).toBe('held');
    broker.expire('t1');
    const reply = await settled(broker.request(ask));
    expect(reply.done).toBe(false);
    broker.cancelRun('run-1');
  });

  it('остановка разговора снимает и отложенные ответы', async () => {
    const broker = new PermissionBroker();
    expect(broker.answer('run-1', 't1', ALLOW, { hold: true })).toBe('held');
    broker.cancelRun('run-1');
    const reply = await settled(broker.request(ask));
    expect(reply.done).toBe(false);
    broker.cancelRun('run-1');
  });

  it('отложенный ответ старше срока не выдаётся', async () => {
    vi.useFakeTimers();
    const broker = new PermissionBroker();
    expect(broker.answer('run-1', 't1', ALLOW, { hold: true })).toBe('held');
    vi.setSystemTime(Date.now() + EARLY_ANSWER_MS + 1_000);
    const reply = await settled(broker.request(ask, 60_000));
    expect(reply.done).toBe(false);
    broker.cancelRun('run-1');
  });
});
