import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { devicesSetText, parseSignatureHeader } from '@agentdeck/contracts/phone-signing';
import {
  sha256Hex as serverSha256,
  verifySignature,
} from '../../../../../server/src/domains/phone-signing/verify.ts';
import {
  devicesHashOf,
  fingerprintOf,
  keyFromSeed,
  signatureHeader,
  signingTarget,
  wireBody,
  type PhoneKey,
} from './signing';

/**
 * Подпись телефона против НАСТОЯЩЕГО проверяющего сервера
 * (`apps/server/src/domains/phone-signing/verify.ts`, node:crypto): телефон
 * подписывает чистым JS (`@noble/curves`), сервер проверяет своим Ed25519, и
 * расхождение в любом байте текста подписи здесь краснеет. Сеть не нужна —
 * проверяется ровно то, что уходит в заголовке.
 */

const SEED = Uint8Array.from({ length: 32 }, (_, index) => index);

// Тот же вектор закреплён в `verify.test.ts` сервера: обе стороны сверяются с ним.
const VECTOR = {
  publicKey: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg',
  device: '56475aa75463474c',
  panel: 'vector-panel-0001',
  header:
    'v1;device=56475aa75463474c;nonce=vector-nonce-0001;time=1800000000000;sig=mdvtT4shNxsUFJYHJ2BAXkmtdcFzCi35o4jpt9a8gyw893uP1hYxh-0ugRhgHVqDZp6VXSlYUfUdnFYUxyKOAg',
  nonce: 'vector-nonce-0001',
  time: 1_800_000_000_000,
};

const DECISION_PATH = '/chat/deferred/D-7/decision';
const ALLOW = { behavior: 'allow', via: 'phone' };

function serverAccepts(
  key: PhoneKey,
  options: {
    path?: string;
    body?: unknown;
    params?: Record<string, string>;
    panel?: string;
    serverPanel?: string;
    serverBody?: unknown;
    time?: number;
    now?: number;
  } = {},
) {
  const body = options.body ?? ALLOW;
  const target = signingTarget('POST', options.path ?? DECISION_PATH, body);
  if (!target) throw new Error('route is not signed');
  const time = options.time ?? 1_900_000_000_000;
  const header = signatureHeader({
    key,
    panel: options.panel ?? 'panel-1',
    target,
    body: wireBody(body),
    nonce: 'nonce-1',
    time,
  });
  return verifySignature(
    {
      route: target.route,
      params: options.params ?? target.params,
      body: options.serverBody ?? wireBody(body),
      header,
    },
    {
      machineId: options.serverPanel ?? 'panel-1',
      now: options.now ?? time,
      devices: [
        {
          id: key.deviceId,
          label: 'phone',
          publicKey: key.publicKey,
          boundAt: new Date(0).toISOString(),
        },
      ],
    },
  );
}

describe('golden vector shared with the server', () => {
  it('the pinned seed gives the pinned public key and device id', () => {
    const key = keyFromSeed(SEED);
    expect(key.publicKey).toBe(VECTOR.publicKey);
    expect(key.deviceId).toBe(VECTOR.device);
    expect(fingerprintOf(key.publicKey)).toBe(key.fingerprint);
  });

  it('the phone signs the pinned decision byte for byte', () => {
    const key = keyFromSeed(SEED);
    const target = signingTarget('POST', DECISION_PATH, ALLOW);
    expect(target).toEqual({
      route: 'POST /api/chat/deferred/:id/decision',
      params: { id: 'D-7' },
    });
    expect(
      signatureHeader({
        key,
        panel: VECTOR.panel,
        target: target!,
        body: ALLOW,
        nonce: VECTOR.nonce,
        time: VECTOR.time,
      }),
    ).toBe(VECTOR.header);
  });

  it('node:crypto derives the same public key from the same seed', () => {
    // PKCS#8 обёртка Ed25519-зерна (RFC 8410): так node берёт сырое зерно.
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), SEED]);
    const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' }) as { x?: string };
    expect(jwk.x).toBe(keyFromSeed(SEED).publicKey);
  });
});

describe('a phone-made signature against the real server verifier', () => {
  const key = keyFromSeed(new Uint8Array(randomBytes(32)));

  it('a fresh random key signs an allow, the server accepts it', () => {
    expect(serverAccepts(key)).toEqual({ ok: true, deviceId: key.deviceId, nonce: 'nonce-1' });
  });

  it('every signed route class verifies with its own params', () => {
    const rows: { path: string; body: unknown }[] = [
      { path: '/chat/c-1/permission-decision', body: { behavior: 'allow', requestId: 'r' } },
      { path: '/chat/c-1/branch-decision', body: { choice: 'new-branch' } },
      { path: '/chat/c-1/auto-approve', body: { enabled: true } },
      { path: '/outside/asks/a-1/answer', body: { behavior: 'allow' } },
      { path: '/provider-chat/chats/x/permissions/q', body: { decision: 'allow' } },
      { path: '/agent/pending/p-1', body: { decision: 'approve' } },
      { path: '/chat/send', body: { text: 'go', fullAccess: true } },
      { path: '/phone-signing/mode', body: { enabled: false } },
    ];
    for (const row of rows) {
      expect(serverAccepts(key, row), row.path).toMatchObject({ ok: true });
    }
  });

  it('an encoded id signs the decoded segment Fastify hands the server', () => {
    const target = signingTarget('POST', '/chat/deferred/D%207/decision', ALLOW);
    expect(target?.params).toEqual({ id: 'D 7' });
    expect(serverAccepts(key, { path: '/chat/deferred/D%207/decision' })).toMatchObject({
      ok: true,
    });
  });

  it('another panel, another verdict, another id or a stale time — refused', () => {
    expect(serverAccepts(key, { serverPanel: 'panel-2' })).toEqual({
      ok: false,
      refusal: 'invalid',
    });
    expect(serverAccepts(key, { serverBody: { behavior: 'deny', via: 'phone' } })).toEqual({
      ok: false,
      refusal: 'invalid',
    });
    expect(serverAccepts(key, { params: { id: 'D-8' } })).toEqual({
      ok: false,
      refusal: 'invalid',
    });
    expect(
      serverAccepts(key, { time: 1_900_000_000_000, now: 1_900_000_000_000 + 6 * 60_000 }),
    ).toEqual({ ok: false, refusal: 'stale' });
  });
});

describe('signingTarget: what the phone signs', () => {
  const rows: { method: string; path: string; body: unknown; signed: boolean }[] = [
    { method: 'POST', path: DECISION_PATH, body: { behavior: 'allow' }, signed: true },
    { method: 'POST', path: DECISION_PATH, body: { behavior: 'deny' }, signed: false },
    { method: 'GET', path: DECISION_PATH, body: { behavior: 'allow' }, signed: false },
    {
      method: 'POST',
      path: '/chat/c/permission-decision',
      body: { behavior: 'deny', answers: { q: 'a' } },
      signed: true,
    },
    { method: 'POST', path: '/chat/c/branch-decision', body: { choice: 'stop' }, signed: false },
    { method: 'POST', path: '/chat/c/auto-approve', body: { enabled: false }, signed: false },
    { method: 'POST', path: '/chat/c/auto-approve', body: { enabled: true }, signed: true },
    { method: 'POST', path: '/chat/send', body: { text: 'hi' }, signed: false },
    { method: 'POST', path: '/chat/send', body: { text: 'hi', autoApprove: true }, signed: true },
    { method: 'POST', path: '/agent/pending/p', body: { decision: 'reject' }, signed: false },
    {
      method: 'POST',
      path: '/provider-chat/chats/x/permissions/q',
      body: { decision: 'deny' },
      signed: false,
    },
    { method: 'POST', path: '/phone-signing/devices/abc/revoke', body: undefined, signed: false },
    { method: 'POST', path: '/phone-signing/mode', body: { enabled: false }, signed: true },
    { method: 'POST', path: '/power', body: { action: 'sleep' }, signed: false },
  ];
  for (const row of rows) {
    it(`${row.method} ${row.path} ${JSON.stringify(row.body)} → ${row.signed ? 'signed' : 'free'}`, () => {
      expect(Boolean(signingTarget(row.method, row.path, row.body))).toBe(row.signed);
    });
  }
});

describe('helpers', () => {
  it('devicesHashOf hashes the live set the server compares, revoked keys left out', () => {
    const live = { id: 'b', publicKey: 'kb' };
    const other = { id: 'a', publicKey: 'ka' };
    const revoked = { id: 'c', publicKey: 'kc', revokedAt: '2026-10-24T00:00:00.000Z' };
    expect(devicesHashOf([live, revoked, other])).toBe(serverSha256(devicesSetText([other, live])));
    expect(devicesHashOf([live, revoked])).not.toBe(devicesHashOf([live, revoked, other]));
  });

  it('fingerprintOf rejects a key that is not base64url', () => {
    expect(fingerprintOf('***')).toBe('');
  });

  it('wireBody drops what JSON drops, as the server will see it', () => {
    expect(wireBody({ a: undefined, b: 1 })).toEqual({ b: 1 });
    expect(wireBody(undefined)).toBeUndefined();
  });

  it('the signature header parses back to its parts', () => {
    expect(parseSignatureHeader(VECTOR.header)).toEqual({
      device: VECTOR.device,
      nonce: VECTOR.nonce,
      time: VECTOR.time,
      sig: VECTOR.header.split('sig=')[1],
    });
  });
});
