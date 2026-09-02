import { describe, it, expect } from 'vitest';
import {
  runStatus,
  aggregateStatus,
  statusTone,
  isLive,
  STALL_MS,
  type RunStatus,
} from './status';

/**
 * Тесты логики статуса агента — что показывает цветная точка. Чистые функции,
 * без стора и стримов. Тест-кейсы см. .agent/TEST-CASES.md → «Статусы агентов».
 */
describe('runStatus (поправка на молчание)', () => {
  it('свежий работающий прогон — running', () => {
    expect(runStatus({ status: 'running', lastEventAt: 1000, now: 1000 })).toBe('running');
  });

  it('работающий, но молчащий дольше STALL_MS — quiet, а не error', () => {
    expect(runStatus({ status: 'running', lastEventAt: 0, now: STALL_MS + 1 })).toBe('quiet');
  });

  it('порог молчания — пять минут: долгий вызов инструмента не красится', () => {
    expect(STALL_MS).toBe(5 * 60_000);
    expect(runStatus({ status: 'running', lastEventAt: 0, now: 120_000 })).toBe('running');
  });

  it('ждущий прав — waiting даже при долгом молчании', () => {
    expect(
      runStatus({ status: 'running', lastEventAt: 0, now: STALL_MS + 1, pendingPermission: true }),
    ).toBe('waiting');
  });

  it('не-работающие статусы молчанием не трогаются', () => {
    expect(runStatus({ status: 'waiting', lastEventAt: 0, now: STALL_MS + 1 })).toBe('waiting');
    expect(runStatus({ status: 'idle', lastEventAt: 0, now: STALL_MS + 1 })).toBe('idle');
  });
});

describe('isLive', () => {
  it('работающий и молчащий живы, остальные — нет', () => {
    expect(isLive('running')).toBe(true);
    expect(isLive('quiet')).toBe(true);
    expect(isLive('waiting')).toBe(false);
    expect(isLive('error')).toBe(false);
    expect(isLive('idle')).toBe(false);
  });
});

describe('aggregateStatus (самый тревожный по проекту)', () => {
  it('пусто → idle', () => {
    expect(aggregateStatus([])).toBe('idle');
  });

  it('error перекрывает waiting и running', () => {
    expect(aggregateStatus(['running', 'waiting', 'error'])).toBe('error');
  });

  it('waiting важнее running и quiet', () => {
    expect(aggregateStatus(['running', 'quiet', 'waiting', 'idle'])).toBe('waiting');
  });

  it('running заметнее quiet: пока кто-то работает, проект зелёный', () => {
    expect(aggregateStatus(['running', 'quiet'])).toBe('running');
    expect(aggregateStatus(['idle', 'quiet'])).toBe('quiet');
  });

  it('только running → running', () => {
    expect(aggregateStatus(['idle', 'running', 'idle'])).toBe('running');
  });
});

describe('statusTone', () => {
  it('сопоставляет статус тону дизайн-системы', () => {
    const map: Record<RunStatus, ReturnType<typeof statusTone>> = {
      running: 'success',
      quiet: 'neutral',
      waiting: 'warning',
      error: 'danger',
      idle: undefined,
    };
    for (const [status, tone] of Object.entries(map)) {
      expect(statusTone(status as RunStatus)).toBe(tone);
    }
  });
});
