import { describe, it, expect, vi } from 'vitest';

// React здесь не поднимаем (прогон фронта идёт в окружении node): useMutation
// подменён на «верни настройки как есть» — нужна только пометка meta.
vi.mock('@tanstack/react-query', () => ({
  useMutation: <T>(options: T): T => options,
  useQuery: <T>(options: T): T => options,
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));

const api = await import('./ProjectTestApi');

type Options = { meta?: { silentError?: boolean } };
const metaOf = (hook: (path: string) => unknown): Options['meta'] => (hook('C:/p') as Options).meta;

/**
 * Отказ сохранения кейса и группы показывается В ФОРМЕ — у кнопки «Сохранить»,
 * где человек его и ждёт (живой прогон 26.09: «Ссылка должна быть полным
 * адресом» стояла в подвале окна и тут же всплывала тостом). Формы ловят
 * отказ сами через `mutateAsync`, поэтому общий тост ошибки у этих мутаций
 * молчит; у остальных — нет: удаление группы своего места для ошибки не имеет.
 */
describe('мутации библиотеки: один отказ — одно сообщение', () => {
  it('сохранение кейса и формы группы глушат общий тост', () => {
    expect(metaOf(api.useSaveTestCase)?.silentError).toBe(true);
    expect(metaOf(api.useCreateTestGroup)?.silentError).toBe(true);
    expect(metaOf(api.useUpdateTestGroup)?.silentError).toBe(true);
  });

  it('удаление группы сообщает об отказе общим тостом', () => {
    expect(metaOf(api.useRemoveTestGroup)?.silentError).not.toBe(true);
  });
});
