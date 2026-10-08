import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import type { SessionUsage } from '@agentdeck/contracts';
import { sessionSpanMs } from './sessionFacts';
import { sessionBrief } from './sessionBrief';

const session = (startedAt: string, lastActivity: string, requests = 351): SessionUsage => ({
  sessionId: 's1',
  project: 'c:/work/a',
  displayName: 'work/a',
  startedAt,
  lastActivity,
  totals: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, total: 10, requests },
  estimatedCost: 1,
  models: ['claude-opus-4-8'],
  isActive: false,
});

/** Словарь-заглушка: ключ и параметры читаются прямо из строки результата. */
const t = ((key: string, params?: Record<string, string>) =>
  key === 'analytics.sessionRequests'
    ? `запросов: ${params?.requests}`
    : ({ 'common.duration.h': 'ч', 'common.duration.m': 'м', 'common.duration.s': 'с' }[key] ??
      key)) as unknown as TFunction;

describe('sessionSpanMs', () => {
  it('разность последнего и первого ответа, паузы входят', () => {
    expect(sessionSpanMs(session('2026-10-06T08:00:00.000Z', '2026-10-06T09:30:00.000Z'))).toBe(
      90 * 60 * 1000,
    );
  });

  it('нечитаемая метка или обратный порядок — нет значения, а не NaN и не минус', () => {
    expect(sessionSpanMs(session('', '2026-10-06T09:30:00.000Z'))).toBeUndefined();
    expect(sessionSpanMs(session('2026-10-06T10:00:00.000Z', '2026-10-06T09:00:00.000Z'))).toBe(
      undefined,
    );
  });

  it('одиночный ответ даёт нулевую длительность', () => {
    expect(sessionSpanMs(session('2026-10-06T08:00:00.000Z', '2026-10-06T08:00:00.000Z'))).toBe(0);
  });
});

describe('sessionBrief', () => {
  it('длительность и запросы через точку', () => {
    const brief = sessionBrief(
      session('2026-10-06T08:00:00.000Z', '2026-10-06T09:03:00.000Z'),
      t,
      'ru',
    );
    expect(brief).toBe('1ч 03м · запросов: 351');
  });

  it('без читаемых меток остаётся одно число запросов', () => {
    expect(sessionBrief(session('', ''), t, 'ru')).toBe('запросов: 351');
  });
});
