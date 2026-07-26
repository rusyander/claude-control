import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AssistantRunRequest } from '@claude-control/contracts';

const post = vi.fn().mockResolvedValue({ data: { text: 'ok' } });

vi.mock('@shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('@shared/api/client')>('@shared/api/client');
  return { ...actual, apiClient: { post } };
});

const { runAssistant } = await import('./AssistantApi');
const { LONG_TIMEOUTS } = await import('@shared/api/client');

const body: AssistantRunRequest = { messages: [{ role: 'user', content: 'привет' }] };

describe('runAssistant', () => {
  beforeEach(() => post.mockClear());

  it('ждёт дольше серверного бюджета прогона (180 c)', async () => {
    // С общими 60 c клиент рвал запрос на холодном старте CLI: сервер доводил
    // прогон до конца, а пользователь получал несуществующую ошибку таймаута.
    await runAssistant(body);

    const [, , config] = post.mock.calls[0] as [string, unknown, { timeout?: number }];
    expect(config?.timeout).toBe(LONG_TIMEOUTS.assistantRun);
    expect(config?.timeout).toBeGreaterThan(180_000);
  });
});
