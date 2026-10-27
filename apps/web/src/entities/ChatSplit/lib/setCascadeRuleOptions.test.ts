import { afterEach, describe, expect, it, vi } from 'vitest';
import { MutationObserver, QueryClient } from '@tanstack/react-query';
import type { CascadeRuleView } from '@agentdeck/contracts/model-cascade';
import { apiClient } from '@shared/api/client';
import { cascadeKey } from './cascadeKey';
import { setCascadeRuleOptions } from './setCascadeRuleOptions';

/**
 * «Ревью после работы» (Telegram R3(d), 26.10) — второй тумблер того же правила.
 * Тумблер в меню шлёт только своё поле: подмешанное `enabled` выключило бы
 * подбор модели вместе с ревью.
 */
describe('правило проекта — запись одного тумблера', () => {
  afterEach(() => vi.restoreAllMocks());

  const view: CascadeRuleView = { enabled: true, reviewAfterWork: false, project: 'C:/repo' };

  it('«Ревью после работы»: в теле только путь и своё поле, ответ ложится в кэш проекта', async () => {
    const put = vi.spyOn(apiClient, 'put').mockResolvedValue({ data: view });
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const mutation = new MutationObserver(client, setCascadeRuleOptions(client, 'C:/repo'));

    await mutation.mutate({ reviewAfterWork: false });

    expect(put).toHaveBeenCalledWith('/chat/cascade', { path: 'C:/repo', reviewAfterWork: false });
    expect(client.getQueryData(cascadeKey('C:/repo'))).toEqual(view);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['chat-cascade'] });
  });

  it('подбор модели: в теле нет `reviewAfterWork`', async () => {
    const put = vi.spyOn(apiClient, 'put').mockResolvedValue({ data: view });
    const client = new QueryClient();
    const mutation = new MutationObserver(client, setCascadeRuleOptions(client, 'C:/repo'));

    await mutation.mutate({ enabled: false });

    expect(put).toHaveBeenCalledWith('/chat/cascade', { path: 'C:/repo', enabled: false });
  });
});
