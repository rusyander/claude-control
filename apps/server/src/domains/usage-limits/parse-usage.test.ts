import { describe, expect, it } from 'vitest';
import { parseUsageResponse } from './parse-usage.ts';

/**
 * Живой ответ `GET /api/oauth/usage` 19.10.2026 (аккаунт Max 5x), сокращён до
 * читаемых полей; суммы в деньгах оставлены, чтобы проверить, что они не уходят.
 */
const LIVE = {
  five_hour: {
    utilization: 68.0,
    resets_at: '2026-10-19T17:10:00.059504+00:00',
    limit_dollars: null,
    used_dollars: null,
  },
  seven_day: {
    utilization: 69.0,
    resets_at: '2026-10-19T16:00:00.059527+00:00',
    limit_dollars: null,
  },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null },
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 68,
      severity: 'normal',
      resets_at: '2026-10-19T17:10:00.059504+00:00',
      scope: null,
      is_active: false,
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 69,
      severity: 'normal',
      resets_at: '2026-10-19T16:00:00.059527+00:00',
      scope: null,
      is_active: true,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 0,
      severity: 'normal',
      resets_at: '2026-10-19T16:00:00+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: false,
    },
  ],
  spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 }, percent: 0 },
};

describe('разбор ответа лимитов подписки', () => {
  it('живой ответ: сессия, неделя и неделя модели — с моментами сброса и активным окном', () => {
    expect(parseUsageResponse(LIVE)).toEqual([
      {
        id: 'session',
        kind: 'session',
        percent: 68,
        resetsAt: Date.parse('2026-10-19T17:10:00.059Z'),
      },
      {
        id: 'weekly',
        kind: 'weekly',
        percent: 69,
        resetsAt: Date.parse('2026-10-19T16:00:00.059Z'),
        active: true,
      },
      {
        id: 'weekly:Fable',
        kind: 'weekly-model',
        model: 'Fable',
        percent: 0,
        resetsAt: Date.parse('2026-10-19T16:00:00Z'),
      },
    ]);
  });

  it('денег в окнах нет: ни сумм, ни валюты', () => {
    const text = JSON.stringify(parseUsageResponse(LIVE));
    expect(text).not.toMatch(/dollar|usd|credit|spend|amount/i);
  });

  it('дробные проценты источника сохраняются до трёх знаков, шум плавающей точки — нет', () => {
    const windows = parseUsageResponse({
      five_hour: { utilization: 42.137, resets_at: null },
      seven_day: { utilization: 0.57 * 100, resets_at: '2026-10-20T00:00:00Z' },
    });
    expect(windows?.[0]).toMatchObject({ percent: 42.137, resetsAt: null });
    // 0.57 * 100 = 56.99999999999999 — показали бы «56.999%», которого не было.
    expect(windows?.[1]?.percent).toBe(57);
  });

  it('прежних полей нет — окна берутся из limits[]', () => {
    const windows = parseUsageResponse({ limits: LIVE.limits });
    expect(windows?.map((w) => [w.id, w.percent])).toEqual([
      ['session', 68],
      ['weekly', 69],
      ['weekly:Fable', 0],
    ]);
  });

  it('seven_day_opus идёт окном модели, если limits[] эту модель не назвал; дубль — нет', () => {
    const opus = { utilization: 12.5, resets_at: '2026-10-21T00:00:00Z' };
    const alone = parseUsageResponse({ ...LIVE, seven_day_opus: opus });
    expect(alone?.find((w) => w.id === 'weekly:Opus')).toMatchObject({ percent: 12.5 });
    const named = parseUsageResponse({
      ...LIVE,
      seven_day_opus: opus,
      limits: [
        ...LIVE.limits,
        {
          kind: 'weekly_scoped',
          percent: 13,
          resets_at: null,
          scope: { model: { display_name: 'Opus' } },
        },
      ],
    });
    expect(named?.filter((w) => w.model === 'Opus')).toEqual([
      { id: 'weekly:Opus', kind: 'weekly-model', model: 'Opus', percent: 13, resetsAt: null },
    ]);
  });

  it('незнакомая форма — отказ, а не выдуманное число', () => {
    expect(parseUsageResponse(null)).toBeUndefined();
    expect(parseUsageResponse([])).toBeUndefined();
    expect(parseUsageResponse({ error: { type: 'permission_error' } })).toBeUndefined();
    expect(parseUsageResponse({ five_hour: { utilization: '68' } })).toBeUndefined();
    expect(parseUsageResponse({ five_hour: { utilization: -1 } })).toBeUndefined();
    expect(parseUsageResponse({ five_hour: null, seven_day: null, limits: 'x' })).toBeUndefined();
  });
});
