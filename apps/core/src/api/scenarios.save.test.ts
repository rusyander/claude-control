import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { libraryFile } from '../conductor/scenario/index.ts';
import { forkOfFeature } from '../conductor/scenario/__fixtures__/scenario-harness.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { SESSION_PID, startStand, TOKENS, type Stand } from './__fixtures__/api-harness.ts';

/**
 * `POST /v1/scenarios` (этап 9, F6) на настоящем стенде API: суд полномочий `save-scenario`
 * строгий (пир `unknown` без подписи, токен сессии, процесс сессии — отказ, файла нет), запись
 * однократная (другой текст под занятой версией — 409, файл байт в байт прежний).
 */

let stand: Stand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

interface Sent {
  status: number;
  body: Record<string, unknown>;
}

async function save(
  s: Stand,
  scenario: unknown,
  opts: { token?: string; proof?: Record<string, string>; nonce?: boolean } = {},
): Promise<Sent> {
  const proof = opts.proof ?? (opts.nonce === false ? {} : await s.nonce());
  const res = await fetch(`${s.url}/v1/scenarios`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.token === '' ? {} : { authorization: `Bearer ${opts.token ?? TOKENS.core}` }),
    },
    body: JSON.stringify({ cmdId: newId(), scenario, proof }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function fileOf(s: Stand, scenario: Scenario): string {
  return libraryFile(s.layout.scenarios, { id: scenario.id, version: scenario.version });
}

describe('POST /v1/scenarios writes once (F6)', () => {
  it('201 creates, the same text again is 200, another text under a taken version is 409 and the file stays byte-equal', async () => {
    stand = await startStand();
    const first = forkOfFeature('team-flow', 1);
    const created = await save(stand, first);
    expect([created.status, created.body]).toEqual([201, { ref: { id: 'team-flow', version: 1 } }]);
    const file = fileOf(stand, first);
    const bytes = readFileSync(file, 'utf8');
    expect(JSON.parse(bytes)).toEqual(first);

    expect((await save(stand, first)).status).toBe(200);

    const other: Scenario = { ...first, title: 'Другой текст под той же версией' };
    const taken = await save(stand, other);
    expect([taken.status, taken.body.code, taken.body.next]).toEqual([409, 'version-taken', 2]);
    expect(readFileSync(file, 'utf8')).toBe(bytes);

    const second = await save(stand, { ...other, version: 2 });
    expect([second.status, second.body]).toEqual([201, { ref: { id: 'team-flow', version: 2 } }]);
  });

  it('a version gap, a preset id and a broken scenario are 422; a non-strict body is 400; nothing is written', async () => {
    stand = await startStand();
    const gap = forkOfFeature('team-flow', 3);
    const skipped = await save(stand, gap);
    expect([skipped.status, skipped.body.code, skipped.body.next]).toEqual([422, 'version-gap', 1]);
    expect(existsSync(fileOf(stand, gap))).toBe(false);

    const preset = { ...forkOfFeature('team-flow', 1), id: 'feature' };
    const reserved = await save(stand, preset);
    expect([reserved.status, reserved.body.code]).toEqual([422, 'preset-id-reserved']);
    expect(existsSync(fileOf(stand, preset))).toBe(false);

    const base = forkOfFeature('broken', 1);
    const [head, ...rest] = base.steps;
    const broken: Scenario = {
      ...base,
      steps: [{ ...head!, after: ['nowhere'] }, ...rest],
    };
    const invalid = await save(stand, broken);
    expect([invalid.status, invalid.body.code]).toEqual([422, 'invalid-scenario']);
    expect(invalid.body.problems).toContain(`${head!.id}: after unknown step nowhere`);
    expect(existsSync(fileOf(stand, broken))).toBe(false);

    const extra = await save(stand, { ...forkOfFeature('team-flow', 1), extra: true });
    expect([extra.status, extra.body.code]).toEqual([400, 'bad-scenario']);
  });
});

describe('POST /v1/scenarios is human-strict (save-scenario)', () => {
  it('peer unknown with a valid page nonce is refused signature-required and writes nothing', async () => {
    stand = await startStand();
    stand.peer.direct = 'unknown';
    const scenario = forkOfFeature('team-flow', 1);
    const refused = await save(stand, scenario);
    expect([refused.status, refused.body.code]).toEqual([403, 'signature-required']);
    expect(existsSync(fileOf(stand, scenario))).toBe(false);
  });

  it('session token, a session-descendant process, no nonce, a replayed nonce and a bad signature are refused', async () => {
    stand = await startStand();
    const scenario = forkOfFeature('team-flow', 1);

    const session = await save(stand, scenario, { token: TOKENS.session });
    expect([session.status, session.body.code]).toEqual([403, 'forged-authority']);

    stand.peer.direct = SESSION_PID;
    const descendant = await save(stand, scenario);
    expect([descendant.status, descendant.body.code]).toEqual([403, 'forged-authority']);
    stand.peer.direct = 4242;

    const bare = await save(stand, scenario, { nonce: false });
    expect([bare.status, bare.body.code]).toEqual([403, 'proof-required']);

    const proof = await stand.nonce();
    expect((await save(stand, forkOfFeature('used-once', 1), { proof })).status).toBe(201);
    const replay = await save(stand, scenario, { proof });
    expect([replay.status, replay.body.code]).toEqual([403, 'nonce-invalid']);

    const forged = await save(stand, scenario, {
      proof: { ...(await stand.nonce()), signature: 'v1.not-a-signature' },
    });
    expect([forged.status, forged.body.code]).toEqual([403, 'signature-invalid']);

    expect(existsSync(fileOf(stand, scenario))).toBe(false);
    expect((await save(stand, scenario, { token: '' })).status).toBe(401);
  });
});
