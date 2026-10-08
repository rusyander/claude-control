import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { caseHistoryQuery } from '../lib/caseHistoryQuery';

/**
 * Ревью z3 C01: открытая «История» кейса не перечитывалась, когда прогон агента
 * кончался, — новые итоги появлялись только после переоткрытия окна. Подпись
 * прогона в запросе сменилась — история перечитана.
 */
describe('история кейса и конец прогона', () => {
  afterEach(() => vi.restoreAllMocks());

  it('сменилась подпись прогона — история перечитана с сервера', async () => {
    const get = vi
      .spyOn(apiClient, 'get')
      .mockResolvedValue({ data: { results: [], flaky: { isFlaky: false } } });
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const observer = new QueryObserver(
      client,
      caseHistoryQuery('/p', 'gui', 'gui-001', 'r1:running'),
    );
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    observer.setOptions(caseHistoryQuery('/p', 'gui', 'gui-001', 'r1:done'));

    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    unsubscribe();
  });
});
