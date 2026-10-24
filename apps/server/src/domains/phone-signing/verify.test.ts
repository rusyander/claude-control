import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildSignedMessage,
  deviceIdOf,
  formatSignatureHeader,
  signedPayloadText,
  toBase64Url,
  utf8Bytes,
} from '@agentdeck/contracts/phone-signing';
import type { StoredSigningDevice } from './phone-signing.types.ts';
import { publicKeyHash, sha256Hex, verifySignature } from './verify.ts';

/**
 * Подпись решения настоящей криптографией: ключи Ed25519 из `node:crypto`,
 * подпись — тем же текстом, что строит телефон (`buildSignedMessage`).
 * Каждый отказ — отдельная строка, и у каждой есть пара, которая проходит.
 */

const PANEL = '6f0c9f5e-panel';
const NOW = 1_800_000_000_000;
const ROUTE = 'POST /api/chat/deferred/:id/decision';

interface Phone {
  device: StoredSigningDevice;
  privateKey: KeyObject;
}

function makePhone(label = 'Pixel'): Phone {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x as string;
  const id = deviceIdOf(publicKeyHash(x) as string);
  return {
    device: { id, label, publicKey: x, boundAt: new Date(NOW - 1000).toISOString() },
    privateKey,
  };
}

function header(
  phone: Phone,
  params: Record<string, string>,
  body: unknown,
  overrides: {
    route?: string;
    panel?: string;
    time?: number;
    nonce?: string;
    device?: string;
  } = {},
): string {
  const time = overrides.time ?? NOW;
  const nonce = overrides.nonce ?? 'n0nce-AAAAAAAAAAAAAAAAAA';
  const device = overrides.device ?? phone.device.id;
  const message = buildSignedMessage({
    panel: overrides.panel ?? PANEL,
    device,
    route: overrides.route ?? ROUTE,
    payloadHash: sha256Hex(signedPayloadText(params, body)),
    nonce,
    time,
  });
  const sig = toBase64Url(new Uint8Array(sign(null, utf8Bytes(message), phone.privateKey)));
  return formatSignatureHeader({ device, nonce, time, sig });
}

const allow = { behavior: 'allow' };
const params = { id: 'D-7' };

describe('verifySignature', () => {
  const phone = makePhone();
  const devices = [phone.device];
  const context = { machineId: PANEL, now: NOW, devices };

  it('accepts the signature of the exact decision', () => {
    expect(
      verifySignature(
        { route: ROUTE, params, body: allow, header: header(phone, params, allow) },
        context,
      ),
    ).toEqual({ ok: true, deviceId: phone.device.id, nonce: 'n0nce-AAAAAAAAAAAAAAAAAA' });
  });

  it.each<[string, () => unknown, Record<string, string>, unknown, string]>([
    ['no header', () => undefined, params, allow, 'required'],
    ['malformed header', () => 'v1;device=x', params, allow, 'invalid'],
    ['unknown device', () => header(makePhone(), params, allow), params, allow, 'invalid'],
    [
      'bad signature (one byte flipped)',
      () => {
        const good = header(phone, params, allow);
        const at = good.lastIndexOf('sig=') + 6;
        return good.slice(0, at) + (good[at] === 'A' ? 'B' : 'A') + good.slice(at + 1);
      },
      params,
      allow,
      'invalid',
    ],
    [
      'wrong decision id (signed D-7, sent for D-8)',
      () => header(phone, params, allow),
      { id: 'D-8' },
      allow,
      'invalid',
    ],
    [
      'signature for another verdict (signed deny, sent allow)',
      () => header(phone, params, { behavior: 'deny' }),
      params,
      allow,
      'invalid',
    ],
    [
      'signature for another route',
      () => header(phone, params, allow, { route: 'POST /api/chat/:chatId/permission-decision' }),
      params,
      allow,
      'invalid',
    ],
    [
      'signature for another panel',
      () => header(phone, params, allow, { panel: 'other-machine' }),
      params,
      allow,
      'invalid',
    ],
    [
      'too old',
      () => header(phone, params, allow, { time: NOW - 5 * 60_000 - 1 }),
      params,
      allow,
      'stale',
    ],
    [
      'from the future',
      () => header(phone, params, allow, { time: NOW + 5 * 60_000 + 1 }),
      params,
      allow,
      'stale',
    ],
  ])('refuses: %s', (_name, make, sentParams, sentBody, refusal) => {
    expect(
      verifySignature(
        { route: ROUTE, params: sentParams, body: sentBody, header: make() },
        context,
      ),
    ).toEqual({ ok: false, refusal });
  });

  it('a revoked key is refused as revoked, its live twin passes', () => {
    const revoked = { ...phone.device, revokedAt: new Date(NOW).toISOString() };
    const input = { route: ROUTE, params, body: allow, header: header(phone, params, allow) };
    expect(verifySignature(input, { ...context, devices: [revoked] })).toEqual({
      ok: false,
      refusal: 'revoked',
    });
    expect(verifySignature(input, context).ok).toBe(true);
  });

  it('field order and absent fields do not change the signed text', () => {
    const body = { message: 'ok', behavior: 'allow', via: undefined };
    const signed = header(phone, params, { behavior: 'allow', message: 'ok' });
    expect(verifySignature({ route: ROUTE, params, body, header: signed }, context).ok).toBe(true);
  });

  it('bind: proof of possession uses the key from the body and its derived id', () => {
    const fresh = makePhone('new');
    const route = 'POST /api/phone-signing/devices';
    const body = { label: 'new', publicKey: fresh.device.publicKey };
    const good = header(fresh, {}, body, { route });
    expect(
      verifySignature(
        { route, params: {}, body, header: good },
        { ...context, devices: [], bindKey: fresh.device.publicKey },
      ).ok,
    ).toBe(true);
    // Подпись другим ключом под чужой открытый ключ — не доказательство.
    const forged = header(phone, {}, body, { route, device: fresh.device.id });
    expect(
      verifySignature(
        { route, params: {}, body, header: forged },
        { ...context, devices: [], bindKey: fresh.device.publicKey },
      ),
    ).toEqual({ ok: false, refusal: 'invalid' });
    // Номер устройства не из этого ключа.
    const wrongId = header(fresh, {}, body, { route, device: phone.device.id });
    expect(
      verifySignature(
        { route, params: {}, body, header: wrongId },
        { ...context, devices: [], bindKey: fresh.device.publicKey },
      ),
    ).toEqual({ ok: false, refusal: 'invalid' });
  });
});

/**
 * Общий вектор с телефоном: ключ из зерна 00..1f, решение «D-7 разрешить».
 * Телефон (`apps/mobile/src/shared/lib/signing/signing.test.ts`) обязан выдать
 * ровно эту подпись своим `@noble/curves`, а сервер — принять её своим
 * `node:crypto`. Поменялся текст подписи на одной стороне — краснеют обе.
 */
describe('golden vector shared with the phone', () => {
  const VECTOR = {
    publicKey: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg',
    device: '56475aa75463474c',
    header:
      'v1;device=56475aa75463474c;nonce=vector-nonce-0001;time=1800000000000;sig=mdvtT4shNxsUFJYHJ2BAXkmtdcFzCi35o4jpt9a8gyw893uP1hYxh-0ugRhgHVqDZp6VXSlYUfUdnFYUxyKOAg',
  };
  const input = {
    route: 'POST /api/chat/deferred/:id/decision',
    params: { id: 'D-7' },
    body: { behavior: 'allow', via: 'phone' },
    header: VECTOR.header,
  };
  const context = {
    machineId: 'vector-panel-0001',
    now: 1_800_000_000_000,
    devices: [
      {
        id: VECTOR.device,
        label: 'vector',
        publicKey: VECTOR.publicKey,
        boundAt: new Date(0).toISOString(),
      },
    ],
  };

  it('the id is derived from the key, and the phone-made signature verifies', () => {
    expect(deviceIdOf(publicKeyHash(VECTOR.publicKey) as string)).toBe(VECTOR.device);
    expect(verifySignature(input, context)).toEqual({
      ok: true,
      deviceId: VECTOR.device,
      nonce: 'vector-nonce-0001',
    });
  });

  it('the same signature for another panel or verdict is refused', () => {
    expect(verifySignature(input, { ...context, machineId: 'other-panel' })).toEqual({
      ok: false,
      refusal: 'invalid',
    });
    expect(
      verifySignature({ ...input, body: { behavior: 'deny', via: 'phone' } }, context),
    ).toEqual({ ok: false, refusal: 'invalid' });
  });
});
