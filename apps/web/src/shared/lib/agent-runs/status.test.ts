import { describe, it, expect } from 'vitest';
import { runStatus, aggregateStatus, statusTone, STALL_MS, type RunStatus } from './status';

/**
 * Тесты логики статуса агента — что показывает цветная точка. Чистые функции,
 * без стора и стримов. Тест-кейсы см. .agent/TEST-CASES.md → «Статусы агентов».
 */
describe('runStatus (поправка на зависание)', () => {
  it('свежий работающий прогон — running', () => {
    expect(runStatus({ status: 'running', lastEventAt: 1000, now: 1000 })).toBe('running');
  });

  it('работающий, но молчащий дольше STALL_MS — error (завис)', () => {
    expect(runStatus({ status: 'running', lastEventAt: 0, now: STALL_MS + 1 })).toBe('error');
  });

  it('не-работающие статусы зависанием не трогаются', () => {
    expect(runStatus({ status: 'waiting', lastEventAt: 0, now: STALL_MS + 1 })).toBe('waiting');
    expect(runStatus({ status: 'idle', lastEventAt: 0, now: STALL_MS + 1 })).toBe('idle');
  });
});

describe('aggregateStatus (самый тревожный по проекту)', () => {
  it('пусто → idle', () => {
    expect(aggregateStatus([])).toBe('idle');
  });

  it('error перекрывает waiting и running', () => {
    expect(aggregateStatus(['running', 'waiting', 'error'])).toBe('error');
  });

  it('waiting важнее running', () => {
    expect(aggregateStatus(['running', 'waiting', 'idle'])).toBe('waiting');
  });

  it('только running → running', () => {
    expect(aggregateStatus(['idle', 'running', 'idle'])).toBe('running');
  });
});

describe('statusTone', () => {
  it('сопоставляет статус тону дизайн-системы', () => {
    const map: Record<RunStatus, ReturnType<typeof statusTone>> = {
      running: 'success',
      waiting: 'warning',
      error: 'danger',
      idle: undefined,
    };
    for (const [status, tone] of Object.entries(map)) {
      expect(statusTone(status as RunStatus)).toBe(tone);
    }
  });
});
