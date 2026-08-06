import { describe, it, expect } from 'vitest';
import { formatLocalDay, formatValueLabel, parseLocalDay, todayIso } from './date-picker.lib';

const PLACEHOLDER = 'Свои даты';

describe('parseLocalDay', () => {
  it('разбирает дату как МЕСТНЫЕ сутки, а не UTC', () => {
    const date = parseLocalDay('2026-08-30');

    // Главное свойство: число не уезжает на соседнее из-за часового пояса.
    // `new Date('2026-08-30')` — полночь по Гринвичу, и западнее её это 29-е.
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(7);
    expect(date?.getDate()).toBe(30);
    expect(date?.getHours()).toBe(0);
  });

  it('отбрасывает мусор и пустое значение', () => {
    expect(parseLocalDay(undefined)).toBeUndefined();
    expect(parseLocalDay('')).toBeUndefined();
    expect(parseLocalDay('30.08.2026')).toBeUndefined();
    expect(parseLocalDay('2026-8-3')).toBeUndefined();
  });
});

describe('formatLocalDay', () => {
  it('складывается с разбором в тождество', () => {
    for (const day of ['2026-01-01', '2026-08-30', '2026-12-31']) {
      expect(formatLocalDay(parseLocalDay(day) as Date)).toBe(day);
    }
  });

  it('дополняет месяц и день нулями', () => {
    expect(formatLocalDay(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('todayIso', () => {
  it('отдаёт сегодняшние местные сутки', () => {
    expect(todayIso()).toBe(formatLocalDay(new Date()));
  });
});

describe('formatValueLabel', () => {
  it('без выбора показывает подсказку', () => {
    expect(formatValueLabel({}, 'ru', PLACEHOLDER)).toBe(PLACEHOLDER);
  });

  it('одни сутки показывает ОДНОЙ датой, без повтора через тире', () => {
    const label = formatValueLabel({ from: '2026-08-30', to: '2026-08-30' }, 'ru', PLACEHOLDER);

    expect(label).not.toContain('—');
    expect(label).toContain('2026');
    // Ровно то же, что показала бы одиночная дата: повтор «30 авг. — 30 авг.»
    // читался бы как ошибка ввода.
    expect(label).toBe(
      formatValueLabel({ from: '2026-08-30' }, 'ru', PLACEHOLDER).replace(' — …', ''),
    );
  });

  it('разные границы показывает диапазоном', () => {
    const label = formatValueLabel({ from: '2026-08-01', to: '2026-08-30' }, 'ru', PLACEHOLDER);

    expect(label).toContain('—');
  });

  it('незаконченный выбор показывает открытым краем', () => {
    expect(formatValueLabel({ from: '2026-08-01' }, 'ru', PLACEHOLDER)).toMatch(/ — …$/);
  });

  it('уважает язык интерфейса', () => {
    const value = { from: '2026-08-30', to: '2026-08-30' };

    expect(formatValueLabel(value, 'ru', PLACEHOLDER)).not.toBe(
      formatValueLabel(value, 'en', PLACEHOLDER),
    );
  });
});
