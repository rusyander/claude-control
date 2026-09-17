import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PanelPendingAction } from '@agentdeck/contracts/panel-agent';

/**
 * Решение карточки с телефона против живой одноразовой панели: настоящие
 * `client.ts`, `connection.ts` и `api.ts` телефона, настоящий `fetch` и настоящий
 * сервер с включённым удалённым доступом. Подменено только то, чего нет в Node:
 * хранилище токена (SecureStore), конфиг сборки и хранилище языка.
 *
 * Запуск: `PANEL_LIVE_URL=http://127.0.0.1:5243 npx vitest run decide.live` —
 * без адреса проверка пропускается (в CI и в `pnpm mobile:test` стенда нет).
 * Стенд ОБЯЗАН быть одноразовым: проверка включает удалённый доступ, одобряет
 * запись переменной в settings.json и убирает её за собой.
 */
const LIVE_URL = process.env.PANEL_LIVE_URL ?? '';

const secure = new Map<string, string>();
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => secure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void secure.set(key, value),
  deleteItemAsync: async (key: string) => void secure.delete(key),
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => undefined },
}));
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'ru' }] }));

const QA_KEY = `QA_PHONE_DECISION_${Date.now()}`;

/** Сторона агента и стенда — не путь телефона, поэтому голый fetch. */
async function stand(path: string, init: RequestInit = {}, token = '') {
  const res = await fetch(`${LIVE_URL}/api${path}`, {
    ...init,
    headers: {
      // Без тела заголовок JSON не шлём: сервер отверг бы пустое тело (400).
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : undefined };
}

describe.skipIf(!LIVE_URL)('телефон решает карточку агента (живой стенд)', () => {
  let token = '';

  beforeAll(async () => {
    const remote = await stand('/remote');
    token = (remote.body as { token: string }).token;
    const on = await stand('/remote', { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
    expect(on.status).toBe(200);
  });

  afterAll(async () => {
    if (!LIVE_URL || !token) return;
    const env = await stand(`/env?key=${QA_KEY}&source=settings`, { method: 'DELETE' }, token);
    const off = await stand(
      '/remote',
      { method: 'PATCH', body: JSON.stringify({ enabled: false }) },
      token,
    );
    expect([env.status, off.status]).toEqual([200, 200]);
  });

  /** Агент просит действие: запрос держится открытым до решения. */
  const agentAsks = (name: string, input: unknown) =>
    stand(
      `/agent/actions/${name}`,
      {
        method: 'POST',
        body: JSON.stringify({ input }),
        headers: { 'x-agentdeck-agent': '1' },
      },
      token,
    );

  const waitCard = async (
    fetchPending: () => Promise<PanelPendingAction[]>,
    name: string,
  ): Promise<PanelPendingAction> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const card = (await fetchPending()).find((item) => item.name === name);
      if (card) return card;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`карточка ${name} не пришла`);
  };

  it('без токена телефон не видит карточек; с токеном — отклоняет и одобряет', async () => {
    const { saveConnection } = await import('../../shared/api/connection');
    const { ApiError } = await import('../../shared/api/client');
    const { decidePanelAction, fetchPanelAgentPending } = await import('./api');

    const startedAt = new Date().toISOString();
    await saveConnection(LIVE_URL, '');
    const anonymous = await fetchPanelAgentPending().catch((error: unknown) => error);
    expect(anonymous).toBeInstanceOf(ApiError);
    expect((anonymous as InstanceType<typeof ApiError>).status).toBe(401);

    await saveConnection(LIVE_URL, token);

    // Отклонить: ничего не выполнено, агент получает rejected.
    const rejectedCall = agentAsks('set_env', { key: QA_KEY, value: 'no', source: 'settings' });
    const first = await waitCard(fetchPanelAgentPending, 'set_env');
    await expect(decidePanelAction(first.id, 'reject')).resolves.toEqual({ ok: true });
    const rejected = await rejectedCall;
    expect((rejected.body as { outcome: string }).outcome).toBe('rejected');
    const afterReject = (await stand('/env', {}, token)).body as Array<{ key: string }>;
    expect(afterReject.some((item) => item.key === QA_KEY)).toBe(false);

    // Одобрить: запись действительно легла в settings.json стенда.
    const approvedCall = agentAsks('set_env', { key: QA_KEY, value: 'yes', source: 'settings' });
    const second = await waitCard(fetchPanelAgentPending, 'set_env');
    await expect(decidePanelAction(second.id, 'approve')).resolves.toEqual({ ok: true });
    const approved = await approvedCall;
    expect((approved.body as { outcome: string }).outcome).toBe('done');
    const afterApprove = (await stand('/env', {}, token)).body as Array<{
      key: string;
      value: string;
    }>;
    expect(afterApprove.find((item) => item.key === QA_KEY)?.value).toBe('yes');

    // Повтор по решённой карточке — отказ словами, не молчаливый успех.
    const again = await decidePanelAction(second.id, 'reject').catch((error: unknown) => error);
    expect(again).toBeInstanceOf(ApiError);
    expect([404, 409]).toContain((again as InstanceType<typeof ApiError>).status);

    // Журнал этого прогона: оба решения — человека.
    const journal = (await stand('/agent/journal', {}, token)).body as Array<{
      name: string;
      at: string;
      outcome: string;
      decidedBy: string;
    }>;
    const mine = journal.filter((entry) => entry.name === 'set_env' && entry.at >= startedAt);
    expect(mine).toHaveLength(2);
    expect(mine.map((entry) => entry.outcome)).toEqual(
      expect.arrayContaining(['rejected', 'done']),
    );
    expect(mine.every((entry) => entry.decidedBy === 'human')).toBe(true);
  }, 60_000);
});
