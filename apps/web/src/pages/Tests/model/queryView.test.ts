import { describe, expect, it } from 'vitest';
import { queryView } from './queryView';

/**
 * Что показать вкладке по состоянию запроса.
 *
 * Упавший запрос отчёта и истории показывался пустотой: «Отчёт пока пуст —
 * сделайте хотя бы один прогон» при десяти прогонах в истории. Человек шёл
 * запускать прогон, а не повторять запрос.
 */
describe('queryView', () => {
  const none = (list: unknown[] | null | undefined) => !list || list.length === 0;

  it('упавший запрос без данных — отказ, а не пустота', () => {
    expect(queryView({ isLoading: false, isError: true, data: undefined }, none)).toBe('failed');
  });

  it('упавшее обновление при уже показанных данных — данные остаются', () => {
    expect(queryView({ isLoading: false, isError: true, data: [1] }, none)).toBe('ready');
  });

  it('загрузка, пустой ответ и данные различаются', () => {
    expect(queryView({ isLoading: true, isError: false, data: undefined }, none)).toBe('loading');
    expect(queryView({ isLoading: false, isError: false, data: [] }, none)).toBe('empty');
    expect(queryView({ isLoading: false, isError: false, data: null }, none)).toBe('empty');
    expect(queryView({ isLoading: false, isError: false, data: [1] }, none)).toBe('ready');
  });
});
