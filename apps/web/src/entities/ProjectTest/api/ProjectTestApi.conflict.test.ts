import { AxiosError, type AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testKeys } from './keys';

// React здесь не поднимаем (фронт гоняется в окружении node): useMutation
// подменён на «верни настройки как есть» — нужен только onError.
const invalidateQueries = vi.fn();
vi.mock('@tanstack/react-query', () => ({
  useMutation: <T>(options: T): T => options,
  useQuery: <T>(options: T): T => options,
  useQueryClient: () => ({ invalidateQueries, setQueryData: vi.fn() }),
}));

const library = await import('./ProjectTestApi');
const manual = await import('./ProjectTestManualApi');

type WithError = { onError?: (error: unknown) => void };
const failWith = (status: number): AxiosError =>
  new AxiosError('x', 'ERR_BAD_REQUEST', undefined, undefined, {
    status,
    data: { messageCode: 'run-already-running', runId: 'r1' },
  } as AxiosResponse);
const keysInvalidated = (): unknown[] =>
  invalidateQueries.mock.calls.map(([filter]) => (filter as { queryKey: unknown }).queryKey);

/**
 * 409 «уже идёт» — это не кривой запрос, а устаревший экран: прогон запустили
 * в другом окне, с телефона или агентом панели. Страница после отказа должна
 * перечитать состояние и показать идущий прогон, а не оставить кнопку «Запустить»,
 * которая снова упрётся в тот же отказ.
 */
describe('запуск прогона: отказ «уже идёт» освежает экран', () => {
  beforeEach(() => invalidateQueries.mockClear());

  it('прогон агента: 409 перечитывает вид, 400 — нет', () => {
    const start = library.useStartTestRun('C:/p') as WithError;
    start.onError?.(failWith(400));
    expect(keysInvalidated()).toEqual([]);

    start.onError?.(failWith(409));
    expect(keysInvalidated()).toContainEqual(testKeys.view('C:/p'));
  });

  it('ручной прогон: 409 перечитывает идущий проход', () => {
    const start = manual.useStartManualRun('C:/p') as WithError;
    start.onError?.(failWith(400));
    expect(keysInvalidated()).toEqual([]);

    start.onError?.(failWith(409));
    expect(keysInvalidated()).toContainEqual(testKeys.manual('C:/p'));
  });
});
