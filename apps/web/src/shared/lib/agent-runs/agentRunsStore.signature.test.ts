import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: vi.fn(async () => ({ data: { ok: true } })),
    get: vi.fn(async () => ({ data: [] })),
  },
}));

vi.mock('@shared/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { apiClient } from '@shared/api/client';
import { toast } from '@shared/lib/toast';
import { i18n } from '@shared/config/i18n';
import { signatureRefusalText } from '@shared/api/signatureRefusal';
import { applyEvent } from './agent-runs.events';
import type { AgentRun } from './agent-runs.types';
import { runs } from './agent-runs.state.constants';
import { decidePermission } from './decidePermission';
import { setAutoApprove } from './setAutoApprove';

/**
 * Режим «решения только с подписью телефона» не принял «Разрешить» из окна
 * (403 `decision_signature_required`). Вызов на сервере всё ещё ждёт — значит
 * снятая карточка обязана вернуться (с неё можно «Запретить»), а человек — узнать
 * причину своим языком, а не «нет связи с сервером».
 */

const refused = (
  code = 'decision_signature_required',
  messageCode = 'decision-signature-required',
) => ({
  response: {
    status: 403,
    data: { code, messageCode, message: 'Решение не принято: …' },
  },
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function seed(id: string, extra: Partial<AgentRun> = {}): void {
  runs.set(id, {
    id,
    status: 'running',
    text: '',
    thinking: '',
    tools: [],
    permissions: [],
    branchGates: [],
    queued: [],
    tokens: 0,
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    ...extra,
  } as unknown as AgentRun);
}

const CARD = {
  kind: 'permission',
  toolName: 'Bash',
  input: { command: 'git push' },
  toolUseId: 'tu-sig',
} as const;

describe('signatureRefusalText', () => {
  it('names a signature refusal in the interface language, ignores every other refusal', async () => {
    await i18n.changeLanguage('en');
    expect(signatureRefusalText(refused())).toMatch(/phone/i);
    await i18n.changeLanguage('ru');
    expect(signatureRefusalText(refused())).toMatch(/телефон/);
    expect(
      signatureRefusalText({ response: { status: 403, data: { code: 'human_only_refused' } } }),
    ).toBeUndefined();
    expect(
      signatureRefusalText({ response: { status: 410, data: { code: 'permission_expired' } } }),
    ).toBeUndefined();
    expect(signatureRefusalText(new Error('offline'))).toBeUndefined();
  });
});

describe('decidePermission — refused by phone signing', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    vi.mocked(apiClient.post).mockReset();
  });
  afterEach(() => runs.clear());

  it('the card comes back and the toast names the signature, not a lost connection', async () => {
    seed('sig-a');
    applyEvent('sig-a', CARD);
    vi.mocked(apiClient.post).mockRejectedValue(refused());

    decidePermission('sig-a', 'tu-sig', 'allow');
    expect(runs.get('sig-a')?.permissions).toEqual([]);
    await settle();

    expect(runs.get('sig-a')?.permissions.map((p) => p.toolUseId)).toEqual(['tu-sig']);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toMatch(/телефон/);
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).not.toBe(
      i18n.t('chat.permissionUnreachable'),
    );
  });

  it('a plain network failure keeps the old behaviour: the card stays gone', async () => {
    seed('sig-b');
    applyEvent('sig-b', CARD);
    vi.mocked(apiClient.post).mockRejectedValue(new Error('offline'));

    decidePermission('sig-b', 'tu-sig', 'allow');
    await settle();

    expect(runs.get('sig-b')?.permissions).toEqual([]);
    expect(toast.error).toHaveBeenCalledWith(i18n.t('chat.permissionUnreachable'));
  });

  it('a card the server echo already restored is not doubled', async () => {
    seed('sig-c');
    applyEvent('sig-c', CARD);
    vi.mocked(apiClient.post).mockImplementation(async () => {
      applyEvent('sig-c', CARD);
      throw refused();
    });

    decidePermission('sig-c', 'tu-sig', 'allow');
    await settle();

    expect(runs.get('sig-c')?.permissions).toHaveLength(1);
  });
});

describe('setAutoApprove — refused by phone signing', () => {
  // Тело в скобках: функция, возвращённая из beforeEach, становится уборкой
  // после теста — vitest вызвал бы сам мок.
  beforeEach(() => {
    vi.mocked(apiClient.post).mockReset();
  });
  afterEach(() => runs.clear());

  it('the run toggle returns to its previous position; another error leaves it', async () => {
    seed('auto-a', { autoApprove: false });
    vi.mocked(apiClient.post).mockRejectedValue(refused());
    setAutoApprove('auto-a', true);
    expect(runs.get('auto-a')?.autoApprove).toBe(true);
    await settle();
    expect(runs.get('auto-a')?.autoApprove).toBe(false);

    seed('auto-b', { autoApprove: false });
    vi.mocked(apiClient.post).mockRejectedValue(new Error('offline'));
    setAutoApprove('auto-b', true);
    await settle();
    expect(runs.get('auto-b')?.autoApprove).toBe(true);
  });
});
