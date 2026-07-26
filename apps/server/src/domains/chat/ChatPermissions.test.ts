import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PermissionBroker, type PermissionRequest } from './ChatPermissions.ts';

/**
 * Брокер интерактивных прав: держит ответ, пока человек не кликнет
 * «Разрешить»/«Запретить», а по таймауту/остановке безопасно отклоняет.
 * Настоящего MCP-сервера и агента тут нет — проверяем чистую логику ожидания
 * решения. Позитив (клик разрешает), негатив (решение по несуществующему
 * запросу) и край (таймаут, отмена разговора, дубль по одному tool_use).
 */

const REQ = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  runId: 'c1',
  toolName: 'Bash',
  input: { command: 'ls' },
  toolUseId: 'tool-1',
  ...over,
});

describe('PermissionBroker', () => {
  let broker: PermissionBroker;

  beforeEach(() => {
    broker = new PermissionBroker();
  });

  it('клик «Разрешить» разрешает висящий запрос', async () => {
    const decision = broker.request(REQ());
    // Пока не ответили — запрос числится висящим.
    expect(broker.hasPending('c1')).toBe(true);

    const ok = broker.decide('c1', 'tool-1', { behavior: 'allow' });
    expect(ok).toBe(true);
    await expect(decision).resolves.toEqual({ behavior: 'allow' });
    // После ответа висящего запроса не остаётся.
    expect(broker.hasPending('c1')).toBe(false);
  });

  it('клик «Запретить» передаёт причину отказа', async () => {
    const decision = broker.request(REQ());
    broker.decide('c1', 'tool-1', { behavior: 'deny', message: 'нельзя' });
    await expect(decision).resolves.toEqual({ behavior: 'deny', message: 'нельзя' });
  });

  it('решение по несуществующему запросу возвращает false', () => {
    // Ничего не запрашивали — отвечать нечему.
    expect(broker.decide('c1', 'tool-1', { behavior: 'allow' })).toBe(false);
  });

  it('решение по другому toolUseId не трогает висящий запрос', async () => {
    const decision = broker.request(REQ({ toolUseId: 'tool-1' }));
    expect(broker.decide('c1', 'tool-OTHER', { behavior: 'allow' })).toBe(false);
    expect(broker.hasPending('c1')).toBe(true);

    // Исходный запрос всё ещё ждёт и решается своим ключом.
    broker.decide('c1', 'tool-1', { behavior: 'allow' });
    await expect(decision).resolves.toEqual({ behavior: 'allow' });
  });

  it('hasPending видит запросы только своего разговора', () => {
    broker.request(REQ({ runId: 'c1', toolUseId: 't1' }));
    expect(broker.hasPending('c1')).toBe(true);
    expect(broker.hasPending('c2')).toBe(false);
  });

  it('cancelRun отклоняет все запросы разговора и не трогает чужие', async () => {
    const a = broker.request(REQ({ runId: 'c1', toolUseId: 't1' }));
    const b = broker.request(REQ({ runId: 'c1', toolUseId: 't2' }));
    const other = broker.request(REQ({ runId: 'c2', toolUseId: 't3' }));

    broker.cancelRun('c1');

    await expect(a).resolves.toMatchObject({ behavior: 'deny' });
    await expect(b).resolves.toMatchObject({ behavior: 'deny' });
    expect(broker.hasPending('c1')).toBe(false);
    // Чужой разговор остался висеть.
    expect(broker.hasPending('c2')).toBe(true);
    broker.decide('c2', 't3', { behavior: 'allow' });
    await expect(other).resolves.toEqual({ behavior: 'allow' });
  });

  it('дубль по тому же tool_use снимает прежний запрос отказом', async () => {
    const first = broker.request(REQ({ toolUseId: 'tool-1' }));
    // Повторный запрос по тому же ключу — прежний обещание должно разрешиться deny.
    const second = broker.request(REQ({ toolUseId: 'tool-1' }));

    await expect(first).resolves.toMatchObject({ behavior: 'deny' });

    // Второй — актуальный, на него и отвечает клик.
    broker.decide('c1', 'tool-1', { behavior: 'allow' });
    await expect(second).resolves.toEqual({ behavior: 'allow' });
  });

  describe('таймаут ожидания', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('по истечении времени сам отклоняет запрос', async () => {
      const decision = broker.request(REQ(), 1000);
      expect(broker.hasPending('c1')).toBe(true);

      await vi.advanceTimersByTimeAsync(1000);

      await expect(decision).resolves.toMatchObject({ behavior: 'deny' });
      // По таймауту запрос снят — поздний клик уже ни на что не влияет.
      expect(broker.hasPending('c1')).toBe(false);
      expect(broker.decide('c1', 'tool-1', { behavior: 'allow' })).toBe(false);
    });

    it('таймер снятого дубля не уносит пришедший ему на смену запрос', async () => {
      // Первый запрос ждёт секунду, сменивший его — вдесятеро дольше.
      broker.request(REQ({ toolUseId: 'tool-1' }), 1000);
      const second = broker.request(REQ({ toolUseId: 'tool-1' }), 10_000);

      // Срок ПЕРВОГО вышел: его таймер не должен трогать чужую запись.
      await vi.advanceTimersByTimeAsync(1500);

      expect(broker.hasPending('c1')).toBe(true);
      expect(broker.decide('c1', 'tool-1', { behavior: 'allow' })).toBe(true);
      await expect(second).resolves.toEqual({ behavior: 'allow' });
    });

    it('клик до таймаута отменяет отложенный отказ', async () => {
      const decision = broker.request(REQ(), 1000);
      broker.decide('c1', 'tool-1', { behavior: 'allow' });

      // Даже если время «прошло» — ответ уже зафиксирован как allow.
      await vi.advanceTimersByTimeAsync(2000);
      await expect(decision).resolves.toEqual({ behavior: 'allow' });
    });
  });
});
