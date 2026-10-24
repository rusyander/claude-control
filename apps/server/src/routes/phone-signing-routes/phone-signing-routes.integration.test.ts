import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SIGNATURE_HEADER,
  buildSignedMessage,
  deviceIdOf,
  devicesSetText,
  formatSignatureHeader,
  matchSignedRoute,
  signedPayloadText,
  toBase64Url,
  utf8Bytes,
  type PhoneSigningView,
} from '@agentdeck/contracts/phone-signing';
import { applyAnswer, type ApplyDeps } from '../../domains/notify/telegram-answers/apply.ts';
import { PhoneSigningStore } from '../../domains/phone-signing/store.ts';
import { publicKeyHash, sha256Hex } from '../../domains/phone-signing/verify.ts';
import type { HumanOnlyDeps } from '../chat/human-only/human-only.ts';
import { registerPhoneSigningGate, type SignatureGateDeps } from './phone-signing-gate.ts';
import { registerPhoneSigningRoutes } from './phone-signing-routes.ts';

/**
 * Режим подписи целиком через HTTP: привязка с доказательством ключа, включение
 * со сверкой набора устройств, решение без подписи и с ней, повтор, отзыв,
 * выключение, рычаги и отправка, ослабляющая чат. Ключи — настоящие Ed25519,
 * подпись строится тем же текстом, что у телефона; маршрут решения — заглушка
 * ПОСЛЕ хука, как в сборке панели.
 */

const PANEL = 'machine-under-test';
let clock = 1_800_000_000_000;
let dir = '';
let store: PhoneSigningStore;
let app: FastifyInstance;
let decided: string[] = [];
let human: HumanOnlyDeps = { roots: () => [] };
let loosens = false;

interface Phone {
  publicKey: string;
  id: string;
  privateKey: KeyObject;
}

function makePhone(): Phone {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x as string;
  return { publicKey: x, id: deviceIdOf(publicKeyHash(x) as string), privateKey };
}

/** Заголовок, как его ставит клиент телефона: шаблон и параметры — из адреса. */
function signedHeaders(phone: Phone, method: string, url: string, body: unknown) {
  const match = matchSignedRoute(method, url);
  if (!match) throw new Error(`not a signed route: ${method} ${url}`);
  const nonce = toBase64Url(new Uint8Array(randomBytes(16)));
  const message = buildSignedMessage({
    panel: PANEL,
    device: phone.id,
    route: match.route,
    payloadHash: sha256Hex(signedPayloadText(match.params, body)),
    nonce,
    time: clock,
  });
  const sig = toBase64Url(new Uint8Array(sign(null, utf8Bytes(message), phone.privateKey)));
  return {
    [SIGNATURE_HEADER]: formatSignatureHeader({ device: phone.id, nonce, time: clock, sig }),
  };
}

async function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await app.inject({
    method,
    url,
    headers,
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: response.statusCode, json: response.json() as Record<string, unknown> };
}

async function bind(phone: Phone, label = 'Pixel') {
  const body = { label, publicKey: phone.publicKey };
  return call(
    'POST',
    '/api/phone-signing/devices',
    body,
    signedHeaders(phone, 'POST', '/api/phone-signing/devices', body),
  );
}

async function setMode(phone: Phone, enabled: boolean, devicesHash?: string) {
  const view = (await call('GET', '/api/phone-signing')).json as unknown as PhoneSigningView;
  const active = view.devices.filter((device) => !device.revokedAt);
  const body = {
    enabled,
    ...(enabled ? { devicesHash: devicesHash ?? sha256Hex(devicesSetText(active)) } : {}),
  };
  return call(
    'POST',
    '/api/phone-signing/mode',
    body,
    signedHeaders(phone, 'POST', '/api/phone-signing/mode', body),
  );
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'phone-signing-routes-'));
  store = new PhoneSigningStore(join(dir, 'phone-signing.json'));
  decided = [];
  human = { roots: () => [] };
  loosens = false;
  app = Fastify();
  const deps: SignatureGateDeps = {
    store: () => store,
    machineId: () => PANEL,
    now: () => clock,
    get human() {
      return human;
    },
    sendLoosens: () => loosens,
    leverLoosens: (route) => route === 'PATCH /api/settings',
  };
  registerPhoneSigningGate(app, deps);
  registerPhoneSigningRoutes(app, undefined, {
    store: () => store,
    machineId: () => PANEL,
    now: () => clock,
    storePath: () => store.path,
  });
  app.post<{ Params: { id: string }; Body: { behavior: string } }>(
    '/api/chat/deferred/:id/decision',
    async (request) => {
      decided.push(`${request.params.id}:${request.body.behavior}`);
      return { ok: true };
    },
  );
  app.post<{ Params: { chatId: string }; Body: { toolUseId: string; behavior: string } }>(
    '/api/chat/:chatId/permission-decision',
    async (request) => {
      decided.push(`${request.params.chatId}/${request.body.toolUseId}:${request.body.behavior}`);
      return { ok: true };
    },
  );
  app.post('/api/chat/send', async () => {
    decided.push('send');
    return { ok: true };
  });
  app.patch('/api/settings', async () => ({ ok: true }));
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('phone signing over HTTP', () => {
  it('off by default: decisions pass unsigned, nothing changes', async () => {
    expect((await call('GET', '/api/phone-signing')).json).toMatchObject({
      enabled: false,
      devices: [],
      machineId: PANEL,
    });
    expect(
      (await call('POST', '/api/chat/deferred/D-1/decision', { behavior: 'allow' })).status,
    ).toBe(200);
    expect(decided).toEqual(['D-1:allow']);
  });

  it('bind needs proof of the key; enable needs a signature and the shown device set', async () => {
    const phone = makePhone();
    const stranger = makePhone();
    // Подпись чужим ключом под свой открытый ключ — привязки нет.
    const body = { label: 'fake', publicKey: phone.publicKey };
    const forged = await call('POST', '/api/phone-signing/devices', body, {
      [SIGNATURE_HEADER]: signedHeaders(stranger, 'POST', '/api/phone-signing/devices', body)[
        SIGNATURE_HEADER
      ].replace(stranger.id, phone.id),
    });
    expect(forged.status).toBe(403);
    expect(forged.json.code).toBe('decision_signature_invalid');
    expect((await call('POST', '/api/phone-signing/devices', body)).json.code).toBe(
      'decision_signature_required',
    );

    const bound = await bind(phone);
    expect(bound.status).toBe(200);
    const view = bound.json as unknown as PhoneSigningView;
    expect(view.devices).toHaveLength(1);
    expect(view.devices[0]).toMatchObject({ id: phone.id, label: 'Pixel' });
    expect(view.devices[0]?.fingerprint).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);

    // Включение без подписи — отказ; с подписью, но с другим набором — 409.
    expect((await call('POST', '/api/phone-signing/mode', { enabled: true })).json.code).toBe(
      'decision_signature_required',
    );
    const stale = await setMode(phone, true, sha256Hex('another set'));
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('phone_signing_devices_changed');
    expect((await setMode(phone, true)).json.enabled).toBe(true);

    // Режим включён — второй ключ не привязывается.
    const late = await bind(stranger, 'late');
    expect(late.status).toBe(409);
    expect(late.json.code).toBe('phone_signing_enabled');
  });

  it('ON: unsigned allow refused with a human-readable code, deny free, signed allow passes once', async () => {
    const phone = makePhone();
    await bind(phone);
    await setMode(phone, true);

    const unsigned = await call('POST', '/api/chat/deferred/D-2/decision', { behavior: 'allow' });
    expect(unsigned.status).toBe(403);
    expect(unsigned.json).toMatchObject({
      code: 'decision_signature_required',
      messageCode: 'decision-signature-required',
    });
    expect(String(unsigned.json.message)).toContain('подписью телефона');
    expect(decided).toEqual([]);

    expect(
      (await call('POST', '/api/chat/deferred/D-2/decision', { behavior: 'deny' })).status,
    ).toBe(200);

    const body = { behavior: 'allow' };
    const headers = signedHeaders(phone, 'POST', '/api/chat/deferred/D-3/decision', body);
    expect((await call('POST', '/api/chat/deferred/D-3/decision', body, headers)).status).toBe(200);
    // Тот же заголовок второй раз — повтор.
    const replay = await call('POST', '/api/chat/deferred/D-3/decision', body, headers);
    expect(replay.json.code).toBe('decision_signature_replayed');
    // Та же подпись к другому номеру — не сходится.
    const moved = await call('POST', '/api/chat/deferred/D-4/decision', body, headers);
    expect(moved.json.code).toBe('decision_signature_invalid');
    // Подпись запрета, предъявленная к разрешению, — не сходится.
    const denyHeaders = signedHeaders(phone, 'POST', '/api/chat/deferred/D-5/decision', {
      behavior: 'deny',
    });
    expect(
      (await call('POST', '/api/chat/deferred/D-5/decision', { behavior: 'allow' }, denyHeaders))
        .json.code,
    ).toBe('decision_signature_invalid');
    expect(decided).toEqual(['D-2:deny', 'D-3:allow']);
  });

  it('ON: stale clock, revoke, no devices left and the recovery path', async () => {
    const phone = makePhone();
    await bind(phone);
    await setMode(phone, true);
    const body = { behavior: 'allow' };
    const old = signedHeaders(phone, 'POST', '/api/chat/deferred/D-6/decision', body);
    clock += 5 * 60_000 + 1;
    expect((await call('POST', '/api/chat/deferred/D-6/decision', body, old)).json.code).toBe(
      'decision_signature_stale',
    );

    // Отзыв — без подписи (только ужесточает); дальше живых ключей нет.
    expect((await call('POST', `/api/phone-signing/devices/${phone.id}/revoke`)).status).toBe(200);
    const after = await call(
      'POST',
      '/api/chat/deferred/D-7/decision',
      body,
      signedHeaders(phone, 'POST', '/api/chat/deferred/D-7/decision', body),
    );
    expect(after.json).toMatchObject({
      code: 'decision_signature_no_device',
      params: { path: store.path },
    });
    // Выключить режим без телефона нечем — только удалить файл.
    expect((await setMode(phone, false)).json.code).toBe('decision_signature_no_device');
    rmSync(store.path);
    expect((await call('POST', '/api/chat/deferred/D-8/decision', body)).status).toBe(200);
  });

  it('ON with two phones: revoking one keeps the other; the revoked one is told so', async () => {
    const first = makePhone();
    const second = makePhone();
    await bind(first);
    await bind(second, 'Tab');
    await setMode(first, true);
    await call('POST', `/api/phone-signing/devices/${first.id}/revoke`);
    const body = { behavior: 'allow' };
    expect(
      (
        await call(
          'POST',
          '/api/chat/deferred/D-9/decision',
          body,
          signedHeaders(first, 'POST', '/api/chat/deferred/D-9/decision', body),
        )
      ).json.code,
    ).toBe('decision_signature_revoked');
    expect(
      (
        await call(
          'POST',
          '/api/chat/deferred/D-9/decision',
          body,
          signedHeaders(second, 'POST', '/api/chat/deferred/D-9/decision', body),
        )
      ).status,
    ).toBe(200);
    // Выключает режим только подпись живого телефона.
    expect((await setMode(first, false)).json.code).toBe('decision_signature_revoked');
    expect((await setMode(second, false)).json.enabled).toBe(false);
    // Режим выключен, но отозванный ключ обратно не привязать: телефон делает новый.
    const again = await bind(first);
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('phone_signing_key_revoked');
    expect((await bind(makePhone(), 'Pixel new')).status).toBe(200);
  });

  it('levers: loosening refused while ON, passes while OFF', async () => {
    expect((await call('PATCH', '/api/settings', { chatAutoMode: true })).status).toBe(200);
    const phone = makePhone();
    await bind(phone);
    await setMode(phone, true);
    const refused = await call('PATCH', '/api/settings', { chatAutoMode: true });
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe('decision_signature_lever');
  });

  it('send: a repeat of the current state is a plain message, a loosening one needs the phone', async () => {
    const phone = makePhone();
    await bind(phone);
    await setMode(phone, true);
    const body = { chatId: 'c1', prompt: 'go', fullAccess: true };
    expect((await call('POST', '/api/chat/send', body)).status).toBe(200);
    loosens = true;
    expect((await call('POST', '/api/chat/send', body)).json.code).toBe(
      'decision_signature_required',
    );
    expect(
      (
        await call(
          'POST',
          '/api/chat/send',
          body,
          signedHeaders(phone, 'POST', '/api/chat/send', body),
        )
      ).status,
    ).toBe(200);
    expect(decided).toEqual(['send', 'send']);
  });
});

describe('Telegram answers — the same in-process path the bot uses', () => {
  // Настоящий `applyAnswer` бота: ответ уходит `app.inject` тем же маршрутом, что
  // и нажатие в окне. Подписи у бота нет и быть не может — ключа у него нет.
  const telegram: ApplyDeps = {
    inject: async (request) => {
      const reply = await app.inject(request);
      return { statusCode: reply.statusCode, body: reply.body };
    },
    runParams: () => undefined,
    clientId: 'telegram-test',
  };
  const allow = { kind: 'decision', behavior: 'allow' } as const;
  const deny = { kind: 'decision', behavior: 'deny' } as const;

  it('OFF: «Разрешить» from Telegram goes through', async () => {
    expect(await applyAnswer({ kind: 'deferred', id: 'D-11' }, allow, telegram)).toEqual({
      ok: true,
    });
    expect(decided).toEqual(['D-11:allow']);
  });

  it('ON: «Разрешить» from Telegram is refused with the reason, «Запретить» still goes through', async () => {
    const phone = makePhone();
    await bind(phone);
    await setMode(phone, true);
    const refused = await applyAnswer({ kind: 'deferred', id: 'D-12' }, allow, telegram);
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { detail?: string }).detail).toMatch(/^403 .*подписью телефона/);
    const permission = await applyAnswer(
      { kind: 'permission', runKey: 'c1', toolUseId: 'tu-1' },
      allow,
      telegram,
    );
    expect((permission as { detail?: string }).detail).toMatch(/^403 /);
    expect(decided).toEqual([]);

    expect(await applyAnswer({ kind: 'deferred', id: 'D-12' }, deny, telegram)).toEqual({
      ok: true,
    });
    expect(
      await applyAnswer({ kind: 'permission', runKey: 'c1', toolUseId: 'tu-1' }, deny, telegram),
    ).toEqual({ ok: true });
    expect(decided).toEqual(['D-12:deny', 'c1/tu-1:deny']);
  });
});

describe('send that loosens a chat — the process gate in every mode', () => {
  it('a model process over a real socket is refused even with signing OFF', async () => {
    loosens = true;
    await app.close();
    app = Fastify();
    let port = 0;
    // Прогон модели: корень 800, его потомок 810 держит сокет.
    human = {
      roots: () => [800],
      readTcp: async (wanted) => [
        { localPort: [...wanted][0] as number, remotePort: port, pid: 810 },
      ],
      readTable: async () => [
        { pid: 1, ppid: 0, created: 1n },
        { pid: 800, ppid: 1, created: 2n },
        { pid: 810, ppid: 800, created: 3n },
      ],
      readFacts: async () => new Map(),
      platform: 'win32',
      known: new Set(),
    };
    registerPhoneSigningGate(app, {
      store: () => store,
      machineId: () => PANEL,
      now: () => clock,
      human,
      sendLoosens: () => loosens,
      leverLoosens: () => false,
    });
    app.post('/api/chat/send', async () => {
      decided.push('send');
      return { ok: true };
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
    const send = (body: unknown) =>
      fetch(`http://127.0.0.1:${port}/api/chat/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const refused = await send({ chatId: 'c', prompt: 'x', fullAccess: true });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe('decision_human_only');
    // Обычное сообщение того же процесса воротами не судится.
    expect((await send({ chatId: 'c', prompt: 'x' })).status).toBe(200);
    expect(decided).toEqual(['send']);
  });
});
