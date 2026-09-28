import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CLI_TOOL_CAP_MS,
  DEFAULT_TIMEOUT_MS,
  EXPIRED_WAIT,
  PermissionBroker,
  permissionWaitMs,
  type PermissionRequest,
} from './ChatPermissions.ts';

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

  it('list — висящие запросы с видом и моментом, решённый уходит из списка', () => {
    void broker.request(REQ());
    void broker.request(REQ({ runId: 'c2', toolUseId: 'g1', kind: 'branchGate' }));
    expect(broker.list()).toEqual([
      expect.objectContaining({ runId: 'c1', toolUseId: 'tool-1', toolName: 'Bash' }),
      expect.objectContaining({ runId: 'c2', toolUseId: 'g1', kind: 'branchGate' }),
    ]);
    expect(Number.isNaN(Date.parse(broker.list()[0]?.askedAt ?? ''))).toBe(false);
    broker.decide('c1', 'tool-1', { behavior: 'allow' });
    expect(broker.list().map((item) => item.toolUseId)).toEqual(['g1']);
    broker.cancelRun('c2');
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

    it('по умолчанию запрос ждёт чуть меньше жёсткого предела CLI и истекает сам', async () => {
      // Предел CLI (MCP_TOOL_TIMEOUT) — 1e8 мс; брокер обязан ответить «истекло»
      // РАНЬШЕ, чем CLI молча оборвёт вызов, но не раньше, чем за 10 минут.
      expect(DEFAULT_TIMEOUT_MS).toBe(CLI_TOOL_CAP_MS - 10 * 60_000);
      const decision = broker.request(REQ());
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1);
      expect(broker.hasPending('c1')).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      await expect(decision).resolves.toEqual({
        behavior: 'deny',
        message: EXPIRED_WAIT,
        expired: true,
      });
      expect(broker.hasPending('c1')).toBe(false);
      // Поздний клик — «истекло», а не «нет такого».
      expect(broker.answer('c1', 'tool-1', { behavior: 'allow' })).toBe('expired');
    });

    it('срок длиннее предела одного таймера держится нарезкой', async () => {
      // ~24,8 суток — предел setTimeout: без нарезки срок сработал бы сразу.
      const decision = broker.request(REQ(), 30 * 24 * 60 * 60_000);
      await vi.advanceTimersByTimeAsync(25 * 24 * 60 * 60_000);
      expect(broker.hasPending('c1')).toBe(true);
      await vi.advanceTimersByTimeAsync(5 * 24 * 60 * 60_000);
      await expect(decision).resolves.toMatchObject({ behavior: 'deny', expired: true });
    });

    it('клик до таймаута отменяет отложенный отказ', async () => {
      const decision = broker.request(REQ(), 1000);
      broker.decide('c1', 'tool-1', { behavior: 'allow' });

      // Даже если время «прошло» — ответ уже зафиксирован как allow.
      await vi.advanceTimersByTimeAsync(2000);
      await expect(decision).resolves.toEqual({ behavior: 'allow' });
    });
  });

  describe('умерший запрос (CLI перестал ждать)', () => {
    it('expire снимает висящий запрос отказом с пометкой и убирает его из списка', async () => {
      const decision = broker.request(REQ({ toolUseId: 'toolu_dead' }));
      broker.request(REQ({ runId: 'c2', toolUseId: 'toolu_live' }));

      const gone = broker.expire('toolu_dead');

      expect(gone).toMatchObject({ runId: 'c1', toolUseId: 'toolu_dead' });
      await expect(decision).resolves.toMatchObject({ behavior: 'deny', expired: true });
      expect(broker.list().map((item) => item.toolUseId)).toEqual(['toolu_live']);
    });

    it('ответ на умерший — «expired», на неизвестный — «unknown», на живой — «ok»', () => {
      broker.request(REQ({ toolUseId: 'toolu_dead' }));
      broker.request(REQ({ toolUseId: 'toolu_live' }));
      broker.expire('toolu_dead');

      expect(broker.answer('c1', 'toolu_dead', { behavior: 'allow' })).toBe('expired');
      expect(broker.isExpired('c1', 'toolu_dead')).toBe(true);
      expect(broker.answer('c1', 'toolu_nope', { behavior: 'allow' })).toBe('unknown');
      expect(broker.answer('c1', 'toolu_live', { behavior: 'allow' })).toBe('ok');
      // decide остаётся булевым: умерший — не «принято».
      expect(broker.decide('c1', 'toolu_dead', { behavior: 'allow' })).toBe(false);
    });

    it('результат вызова без висящего запроса ничего не трогает', () => {
      broker.request(REQ({ toolUseId: 'toolu_live' }));
      expect(broker.expire('toolu_other')).toBeUndefined();
      expect(broker.expire('')).toBeUndefined();
      expect(broker.hasPending('c1')).toBe(true);
      expect(broker.isExpired('c1', 'toolu_other')).toBe(false);
    });

    it('новый запрос под тем же ключом снимает метку «истёк»', () => {
      broker.request(REQ({ toolUseId: 'toolu_x' }));
      broker.expire('toolu_x');
      broker.request(REQ({ toolUseId: 'toolu_x' }));
      expect(broker.isExpired('c1', 'toolu_x')).toBe(false);
      expect(broker.answer('c1', 'toolu_x', { behavior: 'allow' })).toBe('ok');
    });

    it('остановка разговора — не «истёк»: ответ после неё — unknown', () => {
      broker.request(REQ());
      broker.cancelRun('c1');
      expect(broker.answer('c1', 'tool-1', { behavior: 'allow' })).toBe('unknown');
    });
  });

  describe('permissionWaitMs — срок из окружения CLI', () => {
    it('без MCP_TOOL_TIMEOUT — предел CLI 1e8 мс минус 10 минут', () => {
      expect(permissionWaitMs({})).toBe(100_000_000 - 600_000);
    });

    it('убавленный человеком предел убавляет срок, запас — десятая доля', () => {
      expect(permissionWaitMs({ MCP_TOOL_TIMEOUT: '120000' })).toBe(108_000);
      expect(permissionWaitMs({ MCP_TOOL_TIMEOUT: '3600000' })).toBe(3_240_000);
    });

    it('мусор в переменной — предел по умолчанию', () => {
      expect(permissionWaitMs({ MCP_TOOL_TIMEOUT: 'abc' })).toBe(99_400_000);
      expect(permissionWaitMs({ MCP_TOOL_TIMEOUT: '-5' })).toBe(99_400_000);
    });
  });
});
