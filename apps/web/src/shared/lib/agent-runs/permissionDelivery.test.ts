import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: vi.fn(async () => ({ data: { ok: true } })),
    get: vi.fn(async () => ({ data: {} })),
  },
}));

vi.mock('@shared/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { apiClient } from '@shared/api/client';
import { toast } from '@shared/lib/toast';
import { permissionDeliveryProblem } from './permissionDelivery';
import { agentRuns } from './agentRunsStore';

/**
 * Регрессия: решение по правам, не дошедшее до брокера, выглядело доставленным.
 * Карточка убирается с экрана сразу, ответ сервера `{ok:false}` и сетевой сбой
 * проглатывались — агент оставался заблокированным, а человек считал, что
 * ответил. Проверяем чистое правило и то, что стор о провале сообщает.
 */

/** Дать промису решения дойти до тоста. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('permissionDeliveryProblem', () => {
  it('ok:true — решение доставлено, сообщать не о чем', () => {
    expect(permissionDeliveryProblem({ ok: true })).toBeUndefined();
  });

  it('ok:false — запроса у брокера уже нет', () => {
    expect(permissionDeliveryProblem({ ok: false })).toBe('chat.permissionLost');
  });

  it('ошибка запроса важнее тела ответа', () => {
    expect(permissionDeliveryProblem({ ok: false }, new Error('offline'))).toBe(
      'chat.permissionUnreachable',
    );
  });

  it('незнакомая форма ответа за провал не считается', () => {
    // Посредник переписал тело — молчание лучше ложной тревоги.
    expect(permissionDeliveryProblem(undefined)).toBeUndefined();
    expect(permissionDeliveryProblem({})).toBeUndefined();
  });
});

describe('agentRuns.decidePermission — недоставленное решение', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    vi.mocked(apiClient.post).mockReset();
  });

  it('на {ok:false} показывает уведомление', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { ok: false } });

    agentRuns.decidePermission('perm-lost', 'tool-1', 'allow');
    await settle();

    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('на сетевой ошибке показывает уведомление', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(new Error('offline'));

    agentRuns.decidePermission('perm-net', 'tool-1', 'deny');
    await settle();

    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('на успешной доставке молчит', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: { ok: true } });

    agentRuns.decidePermission('perm-ok', 'tool-1', 'allow');
    await settle();

    expect(toast.error).not.toHaveBeenCalled();
  });
});
