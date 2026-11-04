import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn().mockResolvedValue({ data: {} });
let language = 'en-US';

vi.mock('@shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('@shared/api/client')>('@shared/api/client');
  return { ...actual, apiClient: { get, post: vi.fn() } };
});

// React не поднимаем (окружение node): хук запроса отдаёт свои настройки как есть — нужен ключ
// и запрос, который он посылает.
vi.mock('@tanstack/react-query', () => ({
  keepPreviousData: Symbol('keep'),
  useMutation: <T>(options: T): T => options,
  useQuery: <T>(options: T): T => options,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ i18n: { language } }),
}));

// Два среза сразу — потому тест на уровне страницы: срез другого среза не видит (depcruise).
const { useScenarioList, useScenarioRead } = await import('@features/ScenarioEditor');
const { useScenarioListing } = await import('@features/CoreLaunch');

type QueryOptions = { queryKey: readonly unknown[]; queryFn: () => Promise<unknown> };

/**
 * Заголовки пресетов — на языке панели (этап 10, F4): каждый запрос сценариев несёт `lang` панели
 * (`en-US` → `en`, прочее → `ru`), ключ запроса — тоже, чтобы смена языка читала заново. Форма
 * запуска, библиотека и редактор берут один ответ — одним ключом.
 */
describe('scenario reads carry the panel language', () => {
  beforeEach(() => get.mockClear());

  it('list (library + launch form) and one version: ?lang=en in the request and the key', async () => {
    language = 'en-US';
    const list = useScenarioList() as unknown as QueryOptions;
    const listing = useScenarioListing() as unknown as QueryOptions;
    expect(list.queryKey).toEqual(['core', 'scenarios', 'en']);
    expect(listing.queryKey).toEqual(list.queryKey);
    await list.queryFn();
    await listing.queryFn();
    const read = useScenarioRead({ id: 'bug-fix', version: 1 }) as unknown as QueryOptions;
    expect(read.queryKey).toEqual(['core', 'scenarios', 'bug-fix@1', 'en']);
    await read.queryFn();
    const calls = get.mock.calls as [string, { params?: Record<string, string> }][];
    expect(calls.map(([url, config]) => [url, config.params])).toEqual([
      ['/core/scenarios', { lang: 'en' }],
      ['/core/scenarios', { lang: 'en' }],
      ['/core/scenarios/bug-fix%401', { lang: 'en' }],
    ]);
  });

  it('any other panel language reads Russian titles', async () => {
    language = 'ru';
    const list = useScenarioList() as unknown as QueryOptions;
    expect(list.queryKey).toEqual(['core', 'scenarios', 'ru']);
    await list.queryFn();
    expect((get.mock.calls[0] as [string, { params?: unknown }])[1].params).toEqual({ lang: 'ru' });
  });
});
