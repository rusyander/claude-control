import { describe, expect, it } from 'vitest';
import type { UsageLimits, UsageLimitWindow } from '@agentdeck/contracts';
import { usageLimitsRu as t } from '../../shared/config/i18n/usage-limits/ru';
import { formatPercent, formatUntil, limitTone, stripWindows, windowLabel } from './model';

const win = (over: Partial<UsageLimitWindow>): UsageLimitWindow => ({
  id: 'session',
  kind: 'session',
  percent: 10,
  resetsAt: null,
  ...over,
});

const limits = (windows: UsageLimitWindow[]): UsageLimits => ({
  status: 'ok',
  windows,
  observedAt: 1,
  source: 'oauth',
});

describe('окна полосы лимитов', () => {
  it('сессия первой, неделя второй — в каком бы порядке их ни прислал сервер', () => {
    const shown = stripWindows(
      limits([win({ id: 'weekly', kind: 'weekly' }), win({ id: 'session', kind: 'session' })]),
    );
    expect(shown.map((w) => w.id)).toEqual(['session', 'weekly']);
  });

  it('неделя модели — только пока она ограничивает', () => {
    const idle = win({ id: 'weekly:Opus', kind: 'weekly-model', model: 'Opus' });
    expect(stripWindows(limits([win({}), idle])).map((w) => w.id)).toEqual(['session']);
    const active = { ...idle, active: true };
    expect(stripWindows(limits([win({}), active])).map((w) => w.id)).toEqual([
      'session',
      'weekly:Opus',
    ]);
  });

  it('ответа ещё нет — полосы нет', () => {
    expect(stripWindows(undefined)).toEqual([]);
  });
});

describe('тон, процент, подпись', () => {
  it('до 75 обычный, от 75 предупреждение, от 90 опасность', () => {
    expect(limitTone(74.9)).toBe('normal');
    expect(limitTone(75)).toBe('warning');
    expect(limitTone(90)).toBe('danger');
  });

  it('целый процент без нулей, дробный — до десятых', () => {
    expect(formatPercent(41)).toBe('41%');
    expect(formatPercent(9.44)).toBe('9.4%');
  });

  it('подпись окна, у недели модели — имя модели от сервера', () => {
    expect(windowLabel(win({}), t)).toBe('Сессия');
    expect(windowLabel(win({ kind: 'weekly' }), t)).toBe('Неделя');
    expect(windowLabel(win({ kind: 'weekly-model', model: 'Opus' }), t)).toBe('Неделя · Opus');
  });
});

describe('время до сброса', () => {
  it('минуты, часы с минутами, дни с часами; прошедшее — «сейчас»', () => {
    expect(formatUntil(12 * 60_000, t)).toBe('12 м');
    expect(formatUntil((95 * 60 + 20) * 1000, t)).toBe('1 ч 35 м');
    expect(formatUntil((4 * 24 + 3) * 3_600_000, t)).toBe('4 д 3 ч');
    expect(formatUntil(-60_000, t)).toBe('сейчас');
  });
});
