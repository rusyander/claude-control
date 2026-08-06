import { describe, it, expect } from 'vitest';
import { DEFAULT_PERIOD, periodKey, periodParams } from './period';

describe('periodParams', () => {
  it('пресет уходит на сервер числом дней', () => {
    expect(periodParams({ kind: 'preset', preset: 30 })).toEqual({ days: '30' });
    expect(periodParams(DEFAULT_PERIOD)).toEqual({ days: 'today' });
    expect(periodParams({ kind: 'preset', preset: 0 })).toEqual({ days: '0' });
  });

  it('диапазон уходит парой дат', () => {
    expect(periodParams({ kind: 'range', from: '2026-08-01', to: '2026-08-30' })).toEqual({
      from: '2026-08-01',
      to: '2026-08-30',
    });
  });

  it('одни сутки — это тот же диапазон с совпавшими границами', () => {
    // Отдельного вида периода для одного дня нет намеренно: сервер трактует
    // from === to как полные календарные сутки, и лишняя ветка не нужна.
    expect(periodParams({ kind: 'range', from: '2026-08-30', to: '2026-08-30' })).toEqual({
      from: '2026-08-30',
      to: '2026-08-30',
    });
  });
});

describe('periodKey', () => {
  it('различает пресеты', () => {
    expect(periodKey(DEFAULT_PERIOD)).toBe('today');
    expect(periodKey({ kind: 'preset', preset: 7 })).toBe('7d');
    expect(periodKey({ kind: 'preset', preset: 0 })).toBe('all');
  });

  it('диапазон склеивает обе границы', () => {
    expect(periodKey({ kind: 'range', from: '2026-08-01', to: '2026-08-30' })).toBe(
      '2026-08-01_2026-08-30',
    );
  });

  it('одни сутки дают одну дату — имя файла выгрузки не двоится', () => {
    expect(periodKey({ kind: 'range', from: '2026-08-30', to: '2026-08-30' })).toBe('2026-08-30');
  });

  it('разные периоды не сходятся в один ключ кэша', () => {
    const keys = [
      periodKey(DEFAULT_PERIOD),
      periodKey({ kind: 'preset', preset: 7 }),
      periodKey({ kind: 'range', from: '2026-08-30', to: '2026-08-30' }),
      periodKey({ kind: 'range', from: '2026-08-01', to: '2026-08-30' }),
    ];

    expect(new Set(keys).size).toBe(keys.length);
  });
});
