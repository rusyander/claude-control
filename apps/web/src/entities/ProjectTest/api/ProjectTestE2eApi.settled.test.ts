import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testKeys } from './keys';

// React не поднимается (окружение node): эффект выполняется сразу, как при монтировании.
const invalidateQueries = vi.fn();
vi.mock('react', () => ({ useEffect: (effect: () => void) => effect() }));
vi.mock('@tanstack/react-query', () => ({
  useMutation: <T>(options: T): T => options,
  useQuery: <T>(options: T): T => options,
  useQueryClient: () => ({ invalidateQueries, setQueryData: vi.fn() }),
}));

const e2e = await import('./ProjectTestE2eApi');

const keysInvalidated = (): unknown[] =>
  invalidateQueries.mock.calls.map(([filter]) => (filter as { queryKey: unknown }).queryKey);

/**
 * Прогон автотестов панелью кладёт результаты в историю, как прогон агента, но
 * подпись последнего прогона агента от него не меняется — отметки
 * «нестабилен» оставались прежними до следующего прогона агента.
 */
describe('конец прогона автотестов освежает всё, что считается по истории', () => {
  beforeEach(() => invalidateQueries.mockClear());

  it('история, отчёт, история кейса и отметки «нестабилен»', () => {
    e2e.useE2eRunSettled('C:/p', '2026-09-28T10:00:00.000Z');
    expect(keysInvalidated()).toEqual(
      expect.arrayContaining([
        testKeys.runs('C:/p'),
        testKeys.report('C:/p'),
        testKeys.caseHistory('C:/p'),
        testKeys.flaky('C:/p'),
      ]),
    );
  });

  it('прогон не кончился — ничего не сбрасывается', () => {
    e2e.useE2eRunSettled('C:/p', undefined);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
