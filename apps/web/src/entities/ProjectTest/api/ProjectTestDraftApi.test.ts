import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testKeys } from './keys';

// React здесь не поднимаем (прогон фронта идёт в окружении node): useMutation
// подменён на «верни настройки как есть» — проверяем, что делает onSuccess.
const client = { invalidateQueries: vi.fn(), setQueryData: vi.fn() };
vi.mock('@tanstack/react-query', () => ({
  useMutation: <T>(options: T): T => options,
  useQuery: <T>(options: T): T => options,
  useQueryClient: () => client,
}));

const api = await import('./ProjectTestDraftApi');

type Options = { onSuccess: (data: unknown) => void };
const draft = { runId: 'r1', status: 'rolledBack', items: [] };
const view = { projectPath: 'C:/p', groups: [] };

/**
 * Отклонённый и откаченный черновик уезжает в архив, и `GET /drafts?runId=`
 * отвечает 404. Перечитывать его после правки значило оставить в окне прежний
 * кадр (живой прогон 26.09: после «Отменить приёмку» окно по-прежнему писало
 * «все предложения уже приняты (1)» и снова предлагало откат). Ответ правки
 * несёт черновик — он и кладётся в кэш.
 */
describe('правки черновика: окно приёмки показывает ответ, а не перечитанное', () => {
  beforeEach(() => {
    client.invalidateQueries.mockClear();
    client.setQueryData.mockClear();
  });

  it.each([
    ['откат', api.useRollbackTestDraft],
    ['отказ', api.useRejectTestDraft],
    ['приёмка', api.useApplyTestDraft],
  ])('%s кладёт черновик из ответа и не перечитывает его', (_name, hook) => {
    (hook('C:/p', 'r1') as unknown as Options).onSuccess({ draft, view });

    expect(client.setQueryData).toHaveBeenCalledWith(testKeys.draft('C:/p', 'r1'), draft);
    expect(client.setQueryData).toHaveBeenCalledWith(testKeys.view('C:/p'), view);
    const invalidated = client.invalidateQueries.mock.calls.map(([arg]) => arg.queryKey);
    expect(invalidated).not.toContainEqual(testKeys.draft('C:/p', 'r1'));
  });
});
