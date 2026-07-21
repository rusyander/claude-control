import { describe, it, expect } from 'vitest';
import { cellIntensity, gridPosition, labelStep } from './heatmap.model';

/**
 * Тепловая шкала читается по цвету, поэтому проверяем именно шкалу: пустая
 * ячейка не подсвечивается, пик берёт максимум, слабые значения попадают в
 * видимый диапазон и не сливаются с фоном. Раскладку по сетке и прореживание
 * подписей проверяем на краевых случаях — с них ломаются графики.
 */

describe('gridPosition', () => {
  it('единственная строка: колонка равна индексу', () => {
    expect(gridPosition(0, 24)).toEqual({ row: 0, col: 0 });
    expect(gridPosition(23, 24)).toEqual({ row: 0, col: 23 });
  });

  it('перенос на следующую строку по числу колонок', () => {
    expect(gridPosition(12, 12)).toEqual({ row: 1, col: 0 });
    expect(gridPosition(25, 12)).toEqual({ row: 2, col: 1 });
  });

  it('ноль колонок не роняет расчёт делением на ноль', () => {
    expect(gridPosition(3, 0)).toEqual({ row: 3, col: 0 });
  });
});

describe('cellIntensity', () => {
  it('пустая ячейка не заливается', () => {
    expect(cellIntensity(0, 100)).toBe(0);
    expect(cellIntensity(-5, 100)).toBe(0);
  });

  it('пик берёт полную насыщенность', () => {
    expect(cellIntensity(100, 100)).toBe(1);
  });

  it('ненулевое значение поднято над полом видимости', () => {
    // Слабый час должен быть заметен: результат заведомо выше нуля и ниже пика.
    const weak = cellIntensity(1, 100);
    expect(weak).toBeGreaterThan(0.15);
    expect(weak).toBeLessThan(1);
  });

  it('насыщенность растёт вместе со значением', () => {
    expect(cellIntensity(20, 100)).toBeLessThan(cellIntensity(80, 100));
  });

  it('нулевой максимум не делит на ноль', () => {
    expect(cellIntensity(5, 0)).toBe(1);
  });
});

describe('labelStep', () => {
  it('всё помещается → шаг 1', () => {
    expect(labelStep(6, 8)).toBe(1);
  });

  it('24 часа при пределе 8 подписей → каждая третья', () => {
    expect(labelStep(24, 8)).toBe(3);
  });

  it('шаг никогда не меньше единицы', () => {
    expect(labelStep(0, 8)).toBe(1);
  });
});
