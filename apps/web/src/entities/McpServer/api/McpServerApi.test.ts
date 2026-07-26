import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpToolsResult } from '@claude-control/contracts';

const post = vi.fn().mockResolvedValue({ data: { tools: [] } });

vi.mock('@shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('@shared/api/client')>('@shared/api/client');
  return { ...actual, apiClient: { post } };
});

// React здесь не поднимаем (прогон фронта идёт в окружении node): useMutation
// подменён на «верни настройки как есть» — нужен только запрос, который хук
// посылает, вместе с его таймаутом.
vi.mock('@tanstack/react-query', () => ({
  useMutation: <T>(options: T): T => options,
  useQuery: <T>(options: T): T => options,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const { useMcpServerTools } = await import('./McpServerApi');
const { LONG_TIMEOUTS } = await import('@shared/api/client');

/**
 * Клиентский таймаут запроса инструментов обязан перекрывать бюджет сервера.
 * `listMcpServerTools` считает потолок по той же формуле, что и проверка связи
 * (до ~180 c при большом mcpNetworkTimeoutMs), а здесь стояли свои 120 c:
 * медленный сервер рвался ложной ошибкой таймаута на клиенте, пока серверная
 * сторона спокойно доводила опрос до конца.
 */
describe('useMcpServerTools', () => {
  beforeEach(() => post.mockClear());

  it('ждёт столько же, сколько проверка связи (общий серверный бюджет)', async () => {
    const { mutationFn } = useMcpServerTools() as unknown as {
      mutationFn: (id: string) => Promise<McpToolsResult>;
    };

    await mutationFn('linear');

    const [url, , config] = post.mock.calls[0] as [string, unknown, { timeout?: number }];
    expect(url).toBe('/mcp/linear/tools');
    expect(config?.timeout).toBe(LONG_TIMEOUTS.mcpHealth);
    expect(config?.timeout).toBeGreaterThan(180_000);
  });
});
