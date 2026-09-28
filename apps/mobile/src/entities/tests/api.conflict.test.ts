import { beforeEach, describe, expect, it, vi } from 'vitest';

// React здесь не поднимаем: useMutation подменён на «верни настройки как есть» —
// нужен только onError.
const invalidateQueries = vi.fn();
vi.mock('@tanstack/react-query', () => ({
  useMutation: <T>(options: T): T => options,
  useQuery: <T>(options: T): T => options,
  useQueryClient: () => ({ invalidateQueries, setQueryData: vi.fn() }),
}));
vi.mock('../../shared/api/client', () => ({
  api: {},
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly code?: string,
    ) {
      super(message);
    }
  },
}));

const { ApiError } = await import('../../shared/api/client');
const { useStartTestRun, useStartManualRun } = await import('./api');

type WithError = { onError?: (error: unknown) => void };
const keysInvalidated = (): unknown[] =>
  invalidateQueries.mock.calls.map(([filter]) => (filter as { queryKey: unknown }).queryKey);

/**
 * 409 «уже идёт» с телефона — экран устарел: прогон запустили в панели или
 * агентом. Он перечитывает состояние и показывает идущий прогон, а не
 * оставляет кнопку, которая снова упрётся в тот же отказ.
 */
describe('телефон: отказ «уже идёт» освежает экран', () => {
  beforeEach(() => invalidateQueries.mockClear());

  it('прогон агента: 409 перечитывает список, 400 — нет', () => {
    const start = useStartTestRun('C:/p') as unknown as WithError;
    start.onError?.(new ApiError(400, 'x'));
    expect(keysInvalidated()).toEqual([]);

    start.onError?.(new ApiError(409, 'x', 'run-already-running'));
    expect(keysInvalidated()).toContainEqual(['project-tests', 'C:/p']);
  });

  it('ручной прогон: 409 перечитывает идущий проход', () => {
    const start = useStartManualRun('C:/p') as unknown as WithError;
    start.onError?.(new ApiError(400, 'x'));
    expect(keysInvalidated()).toEqual([]);

    start.onError?.(new ApiError(409, 'x', 'manual-already-running'));
    expect(keysInvalidated()).toContainEqual(['project-tests-manual', 'C:/p']);
  });
});
