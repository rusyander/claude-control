import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGNATURE_HEADER } from '@agentdeck/contracts/phone-signing';
import { verifySignature } from '../../../../../server/src/domains/phone-signing/verify.ts';
import { keyFromSeed, type PhoneKey } from './signing';

/**
 * Подпись на пути настоящего запроса: `client.ts` → `signatureHeaders` →
 * заголовок в `fetch`. Подменены только хранилища устройства (SecureStore с
 * ключом, запись пары) и сокет; заголовок, ушедший в сокет, проверяет
 * настоящий проверяющий сервера.
 */

const KEY = keyFromSeed(Uint8Array.from({ length: 32 }, (_, index) => 255 - index));
const store = vi.hoisted(() => ({
  machineId: 'panel-1',
  key: undefined as PhoneKey | undefined,
}));

vi.mock('./keyStore', () => ({
  loadKey: vi.fn(async (machineId: string) =>
    machineId === store.machineId ? store.key : undefined,
  ),
  freshNonce: () => 'nonce-fixed',
}));
vi.mock('../connection', () => ({
  currentConnection: () => ({ url: 'http://panel', token: 'phone-token' }),
  activePanel: () => ({ id: 'p', machineId: store.machineId }),
}));
vi.mock('../../config/i18n', () => ({
  dict: () => ({
    api: { notConfigured: 'n', silent: 's', unreachable: 'u', tokenRejected: 't' },
    run: { answered: (status: number) => `status ${status}` },
  }),
}));

const { signatureHeaders } = await import('./signatureHeaders');
const { loadKey } = await import('./keyStore');
const { api } = await import('../client');

const sent: { url: string; headers: Record<string, string> }[] = [];

beforeEach(() => {
  store.machineId = 'panel-1';
  store.key = KEY;
  sent.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      sent.push({ url, headers: init.headers });
      return new Response('{}', { status: 200 });
    }),
  );
});

function verifies(
  header: string | undefined,
  route: string,
  params: Record<string, string>,
  body: unknown,
) {
  return verifySignature(
    { route, params, body, header },
    {
      machineId: 'panel-1',
      now: Date.now(),
      devices: [{ id: KEY.deviceId, label: 'phone', publicKey: KEY.publicKey, boundAt: '' }],
    },
  );
}

describe('signatureHeaders with injected deps', () => {
  const deps = {
    machineId: () => 'panel-1',
    key: vi.fn(async () => KEY as PhoneKey | undefined),
    nonce: () => 'n-1',
    now: () => 1_900_000_000_000,
  };

  it('a free decision is not signed and the key is not even read', async () => {
    const headers = await signatureHeaders(
      'POST',
      '/chat/deferred/D-1/decision',
      { behavior: 'deny' },
      deps,
    );
    expect(headers).toEqual({});
    expect(deps.key).not.toHaveBeenCalled();
  });

  it('no machine id in the pairing — no signature, the server decides', async () => {
    const headers = await signatureHeaders(
      'POST',
      '/chat/deferred/D-1/decision',
      { behavior: 'allow' },
      { ...deps, machineId: () => '' },
    );
    expect(headers).toEqual({});
  });

  it('no key on the phone — no signature', async () => {
    const headers = await signatureHeaders(
      'POST',
      '/chat/deferred/D-1/decision',
      { behavior: 'allow' },
      { ...deps, key: async () => undefined },
    );
    expect(headers).toEqual({});
  });
});

describe('the signature on the wire of a real client request', () => {
  it('an allow leaves with a header the server verifier accepts', async () => {
    await api.post('/chat/deferred/D-7/decision', { behavior: 'allow', via: 'phone' });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('http://panel/api/chat/deferred/D-7/decision');
    expect(sent[0].headers.Authorization).toBe('Bearer phone-token');
    expect(
      verifies(
        sent[0].headers[SIGNATURE_HEADER],
        'POST /api/chat/deferred/:id/decision',
        { id: 'D-7' },
        { behavior: 'allow', via: 'phone' },
      ),
    ).toEqual({ ok: true, deviceId: KEY.deviceId, nonce: 'nonce-fixed' });
  });

  it('a deny leaves unsigned', async () => {
    await api.post('/chat/deferred/D-7/decision', { behavior: 'deny', via: 'phone' });
    expect(sent[0].headers[SIGNATURE_HEADER]).toBeUndefined();
  });

  it('the key of another computer is never used', async () => {
    store.machineId = 'panel-2';
    await api.post('/chat/c-1/auto-approve', { enabled: true });
    expect(loadKey).toHaveBeenCalledWith('panel-2');
    // Ключ лежит под panel-2, подпись — для panel-2: проверка на panel-1 отказывает.
    expect(
      verifies(
        sent[0].headers[SIGNATURE_HEADER],
        'POST /api/chat/:chatId/auto-approve',
        { chatId: 'c-1' },
        { enabled: true },
      ),
    ).toEqual({ ok: false, refusal: 'invalid' });
  });

  it('an explicit header (binding a new key) wins over the default signature', async () => {
    await api.post(
      '/phone-signing/devices',
      { label: 'x', publicKey: 'k' },
      { headers: { [SIGNATURE_HEADER]: 'explicit' } },
    );
    expect(sent[0].headers[SIGNATURE_HEADER]).toBe('explicit');
  });
});
