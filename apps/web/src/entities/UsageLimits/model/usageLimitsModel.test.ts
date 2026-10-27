import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@shared/config/i18n';
import { formatLimitPercent } from './formatLimitPercent';
import { formatUntil } from './formatUntil';
import { limitTone } from './limitTone';
import { windowLabel } from './windowLabel';

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('процент окна лимита', () => {
  it('целое от сервера — без дописанных нулей: 68 → «68%», не «68.000%»', () => {
    expect(formatLimitPercent(68)).toBe('68%');
    expect(formatLimitPercent(0)).toBe('0%');
    expect(formatLimitPercent(100)).toBe('100%');
  });

  it('дробное — до трёх знаков, лишнее округляется, а не обрезается', () => {
    expect(formatLimitPercent(42.1)).toBe('42.1%');
    expect(formatLimitPercent(42.137)).toBe('42.137%');
    expect(formatLimitPercent(42.13749)).toBe('42.137%');
    expect(formatLimitPercent(42.1375)).toBe('42.138%');
  });
});

describe('тон окна', () => {
  it('до 75 — обычный, от 75 — предупреждение, от 90 — опасность', () => {
    expect(limitTone(74.999)).toBe('normal');
    expect(limitTone(75)).toBe('warning');
    expect(limitTone(89.9)).toBe('warning');
    expect(limitTone(90)).toBe('danger');
    expect(limitTone(100)).toBe('danger');
  });
});

describe('время до сброса', () => {
  const t = i18n.t.bind(i18n);
  it('минуты, часы с минутами, дни с часами, меньше минуты', () => {
    expect(formatUntil(30_000, t)).toBe('меньше минуты');
    expect(formatUntil(12 * 60_000, t)).toBe('12 мин');
    expect(formatUntil((95 * 60 + 20) * 1000, t)).toBe('1 ч 35 мин');
    expect(formatUntil((4 * 24 + 3) * 3_600_000, t)).toBe('4 д 3 ч');
  });

  it('прошедший сброс — не отрицательное время', () => {
    expect(formatUntil(-5 * 60_000, t)).toBe('меньше минуты');
  });
});

describe('подпись окна', () => {
  const t = i18n.t.bind(i18n);
  it('сессия, неделя и неделя модели с именем модели от сервера', () => {
    expect(windowLabel({ id: 's', kind: 'session', percent: 1, resetsAt: null }, t)).toBe('Сессия');
    expect(windowLabel({ id: 'w', kind: 'weekly', percent: 1, resetsAt: null }, t)).toBe('Неделя');
    expect(
      windowLabel({ id: 'm', kind: 'weekly-model', model: 'Opus', percent: 1, resetsAt: null }, t),
    ).toBe('Неделя · Opus');
  });
});
