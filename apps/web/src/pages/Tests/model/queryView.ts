/** Что показывает вкладка: скелет, отказ с повтором, пустоту или данные. */
export type QueryView = 'loading' | 'failed' | 'empty' | 'ready';

/** Та часть запроса, по которой решается показ. */
export interface QueryState<T> {
  isLoading: boolean;
  isError: boolean;
  data: T | undefined;
}

/**
 * Состояние запроса — в то, что показать.
 *
 * Отказ отдельно от пустоты: упавший запрос отчёта рисовался «Отчёт пока пуст —
 * сделайте прогон» при истории в десять прогонов, и человек шёл запускать, а не
 * повторять. Упавшее ОБНОВЛЕНИЕ при уже полученных данных — не отказ: данные
 * остаются на экране, а не сменяются карточкой ошибки.
 */
export function queryView<T>(query: QueryState<T>, isEmpty: (data: T) => boolean): QueryView {
  if (query.isLoading) return 'loading';
  if (query.data === undefined) return query.isError ? 'failed' : 'empty';
  return isEmpty(query.data) ? 'empty' : 'ready';
}
