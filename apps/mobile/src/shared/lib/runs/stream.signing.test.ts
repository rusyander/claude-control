import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGNATURE_HEADER } from '@agentdeck/contracts/phone-signing';
import { verifySignature } from '../../../../../server/src/domains/phone-signing/verify.ts';
import { keyFromSeed, type PhoneKey } from '../../api/signing/signing';

/**
 * Отправка с автоподтверждением — тоже решение: при включённом режиме подписи
 * панель примет её только с подписью ключа телефона. Подменены сокет
 * (`expo/fetch`), запись пары и SecureStore; заголовок, ушедший в сокет,
 * проверяет настоящий проверяющий сервера.
 */

const holder = vi.hoisted(() => ({ key: undefined as PhoneKey | undefined }));
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => fetchMock(...args) }));
vi.mock('../../api/connection', () => ({
  currentConnection: () => ({ url: 'http://panel', token: 'phone-token' }),
  activePanel: () => ({ id: 'p', machineId: 'panel-1' }),
}));
vi.mock('../../api/signing/keyStore', () => ({
  loadKey: async () => holder.key,
  freshNonce: () => 'nonce-send',
}));
vi.mock('../../config/i18n', () => ({
  dict: () => ({
    api: { tokenRejected: 'token rejected' },
    run: { answered: (status: number) => `status ${status}`, notSent: { other: (d: string) => d } },
  }),
}));

const KEY = keyFromSeed(Uint8Array.from({ length: 32 }, (_, index) => (index * 7) % 256));
const { openStream } = await import('./stream');

beforeEach(() => {
  holder.key = KEY;
  fetchMock.mockResolvedValue({
    ok: false,
    status: 409,
    json: async () => ({ code: 'refused', message: 'stop here' }),
  });
});

async function sentHeaders(input: { autoApprove?: boolean }): Promise<Record<string, string>> {
  await openStream('c-1', { chatId: 'c-1', prompt: 'go', ...input }, new AbortController(), 'send');
  const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
  return init.headers;
}

describe('phone send signing', () => {
  it('a send with auto-approve carries a signature the server verifier accepts', async () => {
    const headers = await sentHeaders({ autoApprove: true });
    expect(
      verifySignature(
        {
          route: 'POST /api/chat/send',
          params: {},
          body: { chatId: 'c-1', prompt: 'go', autoApprove: true },
          header: headers[SIGNATURE_HEADER],
        },
        {
          machineId: 'panel-1',
          now: Date.now(),
          devices: [{ id: KEY.deviceId, label: 'p', publicKey: KEY.publicKey, boundAt: '' }],
        },
      ),
    ).toEqual({ ok: true, deviceId: KEY.deviceId, nonce: 'nonce-send' });
    expect(headers.Authorization).toBe('Bearer phone-token');
  });

  it('a plain send is not signed', async () => {
    const headers = await sentHeaders({});
    expect(headers[SIGNATURE_HEADER]).toBeUndefined();
  });

  it('no key on the phone — the send leaves unsigned and the server decides', async () => {
    holder.key = undefined;
    const headers = await sentHeaders({ autoApprove: true });
    expect(headers[SIGNATURE_HEADER]).toBeUndefined();
  });
});
