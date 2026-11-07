import { beforeEach, describe, expect, it, vi } from 'vitest';

// Сеть подменена на границе: `apiClient.get` запоминает адрес и параметры запроса каталога.
const get = vi.fn(async () => ({ data: { models: [] } }));
vi.mock('@shared/api/client', () => ({ apiClient: { get } }));

// React здесь не поднимаем (окружение node): useQuery отдаёт свои настройки как есть — нужны
// ключ кэша и запрос, который хук посылает.
vi.mock('@tanstack/react-query', () => ({
  useQuery: <T>(options: T): T => options,
}));

const { useModelCatalog } = await import('./ModelCatalogApi');

type Options = { queryKey: readonly unknown[]; queryFn: () => Promise<unknown> };

/**
 * W3-17a: шапка чата берёт каталог CLI разговора, а не активного провайдера — разговор Codex при
 * активном Claude не предлагает моделей Claude. Каталог по имени живёт под корнем `models`:
 * смена провайдера сбрасывает и его.
 */
describe('useModelCatalog', () => {
  beforeEach(() => get.mockClear());

  it('с provider — каталог этого CLI: параметр запроса и свой ключ под корнем models', async () => {
    const options = useModelCatalog('codex') as unknown as Options;

    expect(options.queryKey).toEqual(['models', 'codex']);
    await options.queryFn();
    expect(get).toHaveBeenCalledWith('/models', { params: { provider: 'codex' } });
  });

  it('без provider — каталог активного провайдера, без параметра', async () => {
    const options = useModelCatalog() as unknown as Options;

    expect(options.queryKey).toEqual(['models']);
    await options.queryFn();
    expect(get).toHaveBeenCalledWith('/models', {});
  });
});
