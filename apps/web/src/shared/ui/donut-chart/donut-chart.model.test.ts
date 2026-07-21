import { describe, it, expect } from 'vitest';
import { buildDonutArcs } from './donut-chart.model';

/**
 * Кольцо складывается из дуг: сумма долей должна давать целое, а смещения идти
 * встык без нахлёста и разрывов, иначе сегменты наедут друг на друга. Отдельно
 * проверяем вырожденные входы — нулевую сумму и отрицательные значения, — с
 * которых обычно и падает раскладка.
 */

describe('buildDonutArcs', () => {
  it('доли в сумме дают целое', () => {
    const arcs = buildDonutArcs([25, 25, 50]);
    const sum = arcs.reduce((acc, arc) => acc + arc.fraction, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it('первый сегмент начинается с нуля, каждый следующий — со смещения на долю предыдущих', () => {
    const arcs = buildDonutArcs([20, 30, 50]);
    expect(arcs[0]!.offset).toBe(0);
    expect(arcs[1]!.offset).toBeCloseTo(0.2, 10);
    expect(arcs[2]!.offset).toBeCloseTo(0.5, 10);
  });

  it('смещение равно сумме долей предыдущих сегментов', () => {
    const arcs = buildDonutArcs([10, 40, 50]);
    arcs.forEach((arc, index) => {
      const before = arcs.slice(0, index).reduce((acc, prev) => acc + prev.fraction, 0);
      expect(arc.offset).toBeCloseTo(before, 10);
    });
  });

  it('нулевая сумма → нулевые доли без деления на ноль', () => {
    const arcs = buildDonutArcs([0, 0, 0]);
    expect(arcs.every((arc) => arc.fraction === 0)).toBe(true);
    expect(arcs.every((arc) => Number.isFinite(arc.offset))).toBe(true);
  });

  it('отрицательное значение считается нулём', () => {
    const arcs = buildDonutArcs([-10, 10]);
    expect(arcs[0]!.fraction).toBe(0);
    expect(arcs[1]!.fraction).toBeCloseTo(1, 10);
  });

  it('сохраняет исходный порядок и число сегментов', () => {
    const arcs = buildDonutArcs([1, 2, 3, 4]);
    expect(arcs).toHaveLength(4);
    expect(arcs[3]!.fraction).toBeGreaterThan(arcs[0]!.fraction);
  });
});
