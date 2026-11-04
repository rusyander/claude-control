import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { devicesPortOf, loadSigningDevices } from '../bootstrap/devices.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { sha256Hex } from '../platform/core-config/files.ts';
import {
  makeDevice,
  SESSION_PID,
  startStand,
  TOKENS,
  type Stand,
} from './__fixtures__/api-harness.ts';

/**
 * `POST /v1/devices/adopt` (G9, F11): ключи телефона в устройства ядра — суд `human-strict`
 * (число страницы и чистый пир, или подпись), номер устройства выведен из ключа, список и его
 * страж пишутся вместе — ядро затем принимает список без дрейфа.
 */

let stand: Stand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

const notes: { event: string; data: Record<string, unknown> }[] = [];
const PANEL = 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

async function adopt(body: unknown, token = TOKENS.core) {
  const res = await fetch(`${stand?.url}/v1/devices/adopt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('POST /v1/devices/adopt is human-strict and binds id to key (G9, F11)', () => {
  it('nonce + clear peer adopts and the core reads the list back without drift; session, unknown peer, forged id and no proof are refused', async () => {
    notes.length = 0;
    stand = await startStand(undefined, {
      devices: () => devicesPortOf(stand!.layout, (event, data) => notes.push({ event, data })),
    });
    const phone = makeDevice().device;
    const other = makeDevice().device;
    const list = [phone, { ...other, revokedAt: '2026-11-01T00:00:00Z' }];

    const ok = await adopt({
      cmdId: newId(),
      machineId: PANEL,
      devices: list,
      proof: await stand.nonce(),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.adopted).toEqual([phone.id, other.id]);
    // Номер машины панели — номер ядра в подписанном сообщении (этап 10, Q5).
    expect(ok.body.machineId).toBe(PANEL);
    expect(readFileSync(join(stand.layout.root, 'machine-id'), 'utf8')).toBe(`${PANEL}\n`);
    expect(notes[0]?.data.machineId).toBe(PANEL);
    // Ядро читает перенесённый список через своего стража: отпечаток совпал — устройства годны.
    expect(loadSigningDevices(stand.layout)).toEqual(list);
    const text = readFileSync(join(stand.layout.root, 'devices.json'));
    expect(JSON.parse(readFileSync(join(stand.layout.root, 'devices.state.json'), 'utf8'))).toEqual(
      {
        digest: sha256Hex(text),
      },
    );
    expect(notes.map((n) => n.event)).toEqual(['devices.adopted']);
    const before = readFileSync(join(stand.layout.root, 'devices.json'), 'utf8');

    // Процесс из дерева сессии с числом страницы — подделка человека.
    const fromSession = await stand.nonce();
    stand.peer.direct = SESSION_PID;
    expect(
      await adopt({ cmdId: newId(), machineId: PANEL, devices: [other], proof: fromSession }),
    ).toMatchObject({
      status: 403,
      body: { code: 'forged-authority' },
    });
    // Пир не узнан: строгий класс — только подпись, число страницы не годится.
    stand.peer.direct = 'unknown';
    expect(
      await adopt({
        cmdId: newId(),
        machineId: PANEL,
        devices: [other],
        proof: await stand.nonce(),
      }),
    ).toMatchObject({ status: 403, body: { code: 'signature-required' } });
    // Токен сессии к ручке человека.
    expect(
      await adopt(
        { cmdId: newId(), machineId: PANEL, devices: [other], proof: {} },
        TOKENS.session,
      ),
    ).toMatchObject({ status: 403, body: { code: 'forged-authority' } });

    stand.peer.direct = 4242;
    // Чужой номер под своим ключом — отказ до суда и записи.
    expect(
      await adopt({
        cmdId: newId(),
        machineId: PANEL,
        devices: [{ id: phone.id, publicKey: other.publicKey }],
        proof: await stand.nonce(),
      }),
    ).toMatchObject({ status: 422, body: { code: 'device-id-mismatch' } });
    // Без числа страницы — отказ.
    expect(
      (await adopt({ cmdId: newId(), machineId: PANEL, devices: [other], proof: {} })).status,
    ).toBe(403);
    expect((await adopt({ cmdId: 'x', devices: [], proof: {} })).status).toBe(400);
    // Без номера машины панели или с кривым номером — разбор, не запись.
    expect(
      (await adopt({ cmdId: newId(), devices: [other], proof: await stand.nonce() })).status,
    ).toBe(400);
    expect(
      (
        await adopt({
          cmdId: newId(),
          machineId: 'bad id\n',
          devices: [other],
          proof: await stand.nonce(),
        })
      ).status,
    ).toBe(400);
    expect(
      (await adopt({ cmdId: newId(), machineId: PANEL, devices: [], proof: {} }, '')).status,
    ).toBe(401);

    expect(readFileSync(join(stand.layout.root, 'devices.json'), 'utf8')).toBe(before);
    expect(notes.map((n) => n.event)).toEqual([
      'devices.adopted',
      'devices.refused',
      'devices.refused',
      'devices.refused',
      'devices.refused',
    ]);
  });

  it('no devices port → 501', async () => {
    stand = await startStand();
    expect(
      (await adopt({ cmdId: newId(), machineId: PANEL, devices: [], proof: await stand.nonce() }))
        .status,
    ).toBe(501);
  });
});
