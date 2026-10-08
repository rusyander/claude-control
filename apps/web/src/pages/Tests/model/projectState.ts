/** Что показать на месте выбора проекта. */
export type TestsProjectState = 'loading' | 'error' | 'empty' | 'ready';

/**
 * Состояние раздела тестов до выбора проекта.
 *
 * Ошибка загрузки реестра — не пустой реестр: «проектов нет» советует добавить
 * проект, которого на самом деле хватает, и человек заводит его второй раз.
 * Если же при упавшем реестре есть открытые вкладки проектов, раздел работает
 * по ним — ошибку тогда показывают строкой над ним, а не вместо него.
 */
export function testsProjectState(input: {
  isLoading: boolean;
  isError: boolean;
  count: number;
}): TestsProjectState {
  if (input.isLoading) return 'loading';
  if (input.count > 0) return 'ready';
  return input.isError ? 'error' : 'empty';
}
