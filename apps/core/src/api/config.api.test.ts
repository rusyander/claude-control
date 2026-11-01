import { createHash } from 'node:crypto';
import type { ConfigView, SetConfigBody } from '@agentdeck/contracts/core/config';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../lib/ids/uuidv7.ts';
import { startStand, TOKENS, type Stand } from './__fixtures__/api-harness.ts';
import type { ConfigPort, SetConfigOutcome } from './config.types.ts';

/**
 * Шов `GET|POST /v1/config` (этап 7, волна 0): ручку держит API, порт — зона настройки. Без порта
 * обе ручки отвечают 501; суд полномочий `set-config` идёт ДО порта — токен сессии до записи не
 * доходит, число страницы с чистым пиром доходит. Порт здесь — запись в память, не файл.
 */

const DIGEST = createHash('sha256').update('{}').digest('hex');
const VIEW: ConfigView = { doc: {}, digest: DIGEST, drift: null, issues: [] };

type Refusal = { cmdId: string; code: string };

function memoryPort(): ConfigPort & {
  sets: { body: SetConfigBody; by: string }[];
  refusals: Refusal[];
} {
  const applied = new Map<string, SetConfigOutcome>();
  const sets: { body: SetConfigBody; by: string }[] = [];
  const refusals: Refusal[] = [];
  return {
    sets,
    refusals,
    refused: (cmdId, code) => refusals.push({ cmdId, code }),
    view: () => ({ value: VIEW }),
    replay: (cmdId) => applied.get(cmdId),
    async set(body, by) {
      sets.push({ body, by });
      const outcome: SetConfigOutcome = {
        status: 200,
        reply: { view: { ...VIEW, doc: body.doc }, replayed: false, warnings: [] },
      };
      applied.set(body.cmdId, {
        status: 200,
        reply: { view: { ...VIEW, doc: body.doc }, replayed: true, warnings: [] },
      });
      return outcome;
    },
  };
}

let stand: Stand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

async function post(
  s: Stand,
  body: unknown,
  /** Пустая строка — без заголовка (`undefined` взял бы значение по умолчанию). */
  token = TOKENS.core,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${s.url}/v1/config`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function signedBody(s: Stand): Promise<SetConfigBody> {
  const { nonce, page } = await s.nonce();
  return {
    cmdId: newId(),
    doc: { v: 1, forgePoll: ['github'] },
    baseDigest: DIGEST,
    proof: { nonce, page },
  };
}

describe('core config route seam', () => {
  it('without a config port both GET and POST answer 501, a missing token is 401 first', async () => {
    stand = await startStand();
    const got = await stand.get('/v1/config');
    expect([got.status, ((await got.json()) as { code: string }).code]).toEqual([
      501,
      'not-implemented',
    ]);
    const anonymous = await post(stand, await signedBody(stand), '');
    expect([anonymous.status, anonymous.body.code]).toEqual([401, 'token-required']);
    const unwired = await post(stand, await signedBody(stand));
    expect([unwired.status, unwired.body.code]).toEqual([501, 'not-implemented']);
  });

  it('with a port: GET returns its view; a session token is forged authority and never reaches set; a page nonce reaches set once, the same cmdId replays', async () => {
    const port = memoryPort();
    stand = await startStand(undefined, { config: () => port });
    const got = await stand.get('/v1/config');
    expect([got.status, await got.json()]).toEqual([200, VIEW]);

    const forgedBody = await signedBody(stand);
    const forged = await post(stand, forgedBody, TOKENS.session);
    expect([forged.status, forged.body.code]).toEqual([403, 'forged-authority']);
    // Отказ не тонет в 403: порт пишет его в журнал ядра (F23 — попытка сессии видна).
    expect(port.refusals).toContainEqual({ cmdId: forgedBody.cmdId, code: 'forged-authority' });
    const bad = await post(stand, { cmdId: 'x', doc: {}, baseDigest: DIGEST, proof: {} });
    expect([bad.status, bad.body.code]).toEqual([400, 'bad-config']);
    const bare = await post(stand, { ...(await signedBody(stand)), proof: {} });
    expect([bare.status, bare.body.code]).toEqual([403, 'proof-required']);
    expect(port.sets).toEqual([]);

    const body = await signedBody(stand);
    const ok = await post(stand, body);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ replayed: false, view: { doc: body.doc } });
    expect(port.sets).toEqual([{ body, by: 'nonce+peer' }]);
    // Тот же ключ повтора: прежний ответ, второй записи нет (число страницы уже израсходовано).
    const again = await post(stand, body);
    expect([again.status, again.body.replayed]).toEqual([200, true]);
    expect(port.sets).toHaveLength(1);
    // Повтор применённого ключа токеном сессии — не ответ повтора, а суд и отказ.
    const sessionReplay = await post(stand, body, TOKENS.session);
    expect([sessionReplay.status, sessionReplay.body.code]).toEqual([403, 'forged-authority']);
  });
});
