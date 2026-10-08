import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testKeys } from './keys';

// React не поднимается (окружение node): useMutation отдаёт настройки как есть.
const invalidateQueries = vi.fn();
vi.mock('@tanstack/react-query', () => ({
  useMutation: <T>(options: T): T => options,
  useQuery: <T>(options: T): T => options,
  useQueryClient: () => ({ invalidateQueries, setQueryData: vi.fn() }),
}));

const manual = {
  ...(await import('./useFinishManualRun')),
  ...(await import('./useSaveManualResult')),
};

type WithSuccess = { onSuccess?: (session: unknown) => void };
const keysInvalidated = (): unknown[] =>
  invalidateQueries.mock.calls.map(([filter]) => (filter as { queryKey: unknown }).queryKey);

/**
 * Ручной проход добавляет результаты в историю так же, как прогон агента, но
 * подпись последнего прогона агента от него не меняется — и отметка
 * «нестабилен» с историей кейса оставались старыми до перезагрузки.
 */
describe('ручной проход освежает отметки и историю кейса', () => {
  beforeEach(() => invalidateQueries.mockClear());

  it('конец прохода перечитывает «нестабилен» и историю результатов', () => {
    const finish = manual.useFinishManualRun('C:/p') as WithSuccess;
    finish.onSuccess?.(null);
    expect(keysInvalidated()).toContainEqual(testKeys.flaky('C:/p'));
    expect(keysInvalidated()).toContainEqual(testKeys.caseHistory('C:/p'));
  });

  it('отметка результата — тоже', () => {
    const save = manual.useSaveManualResult('C:/p') as WithSuccess;
    save.onSuccess?.(null);
    expect(keysInvalidated()).toContainEqual(testKeys.flaky('C:/p'));
  });
});
