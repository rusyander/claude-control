import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
import { deviceIdOf } from '@agentdeck/contracts/phone-signing';
import { afterEach, describe, expect, it } from 'vitest';
import { raiseHumanPoint } from '../conductor/human/raise.ts';
import { seedSession } from '../conductor/model-tools/__fixtures__/seed.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { publicKeyHash, verifyDeviceSignature } from '../policy/authority/device-signature.ts';
import { startStand, TRUSTED_HOP_PID, type Stand } from './__fixtures__/api-harness.ts';
import { signedBody } from './auth.ts';

/**
 * Вопрос права задачи ядра из чата — ответ с телефона (этап 10, G9). Ход чата идёт задачей ядра,
 * его карточка права — вопрос пункта 5 (`source: 'permit'`). Телефон отвечает сам: грант, затем
 * ответ `grant` — командами через прокладку панели, подписанными ключом устройства. Прокладка —
 * доверенное звено без pid настоящего пира: для ядра это пир `unknown`, и human-strict `answer` /
 * `grant` проходят только с подписью устройства; без неё — `signature-required`, журнал вопроса
 * не тронут. Путь настоящий: Fastify ядра, суд полномочий, журнал задачи; подменён только пир.
 */

let stand: Stand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

/**
 * Вектор телефона (`apps/mobile/src/shared/api/signing/coreCommand.test.ts`): зерно 0..31,
 * публичный ключ из `signing.test.ts` телефона и `verify.test.ts` панели.
 */
const PHONE_VECTOR = {
  publicKey: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg',
  panel: 'panel-golden-0001',
  command: {
    cmdId: '019a4b2c-0000-7000-8000-000000000001',
    kind: 'answer',
    target: { taskId: '019a4b2c-0000-7000-8000-0000000000aa' },
    fields: { askId: '019a4b2c-0000-7000-8000-0000000000bb', answer: 'grant' },
  } as Omit<CommandEnvelope, 'proof'>,
  time: 1_793_000_000_000,
  header:
    'v1;device=56475aa75463474c;nonce=golden-nonce-0001;time=1793000000000;' +
    'sig=s09NrIDJ8tNVxBfOEdjqHq2B01dnLLGxiX33wWBELhwV50bAfHxSWX4Dyf00wt75p23pHGwdSExW5UNK_ZsiBw',
};

describe('a chat core permit ask answered from the phone (stage 10, G9)', () => {
  it('the phone-made signature of an answer verifies with the core verifier byte for byte', () => {
    const id = deviceIdOf(publicKeyHash(PHONE_VECTOR.publicKey) ?? '');
    const context = {
      machineId: PHONE_VECTOR.panel,
      now: PHONE_VECTOR.time,
      devices: [{ id, publicKey: PHONE_VECTOR.publicKey }],
    };
    const input = {
      route: 'POST /v1/commands',
      params: {},
      body: signedBody({ ...PHONE_VECTOR.command, proof: { signature: PHONE_VECTOR.header } }),
      header: PHONE_VECTOR.header,
    };
    expect(verifyDeviceSignature(input, context)).toEqual({
      ok: true,
      deviceId: id,
      nonce: 'golden-nonce-0001',
    });
    // Другой ответ под той же подписью — не принят: подпись держит тело команды.
    const tampered = {
      ...input,
      body: {
        ...PHONE_VECTOR.command,
        fields: { askId: '019a4b2c-0000-7000-8000-0000000000bb', answer: 'refuse' },
      },
    };
    expect(verifyDeviceSignature(tampered, context)).toEqual({ ok: false, refusal: 'invalid' });
  });

  it('through the panel hop: unsigned grant/answer → signature-required; device-signed → applied', async () => {
    stand = await startStand();
    const s = stand;
    const opened = await s.registry.open(s.taskId);
    if (!('task' in opened)) throw new Error(opened.refused);
    const task = opened.task;
    const seeded = seedSession(task, { stepKind: 'work' });
    const raised = raiseHumanPoint(task, {
      source: 'permit',
      stepId: seeded.stepId,
      sessionId: seeded.sessionId,
      action: { kind: 'path', target: 'migrations/1.sql' },
      point: 5,
      dedupe: `permit:${seeded.stepId}:5:edit:x`,
      question: 'The step needs a grant to edit migrations/1.sql (Edit)',
      options: ['grant', 'refuse'],
      recommendation: 'refuse',
      blocking: true,
    });
    if (raised.kind !== 'asked') throw new Error(`ask not raised: ${raised.kind}`);
    // Прокладка панели пересылает без pid настоящего пира — для ядра пир `unknown`.
    s.peer.direct = TRUSTED_HOP_PID;

    const grant = s.envelope('grant', {
      project: 'r1',
      globs: ['migrations/1.sql'],
      ops: ['edit'],
    });
    const answer = s.envelope('answer', { askId: raised.askId, answer: 'grant' });
    const lines = () => readJournalLines(task.dir, task.taskId).lines;
    const effects = () =>
      lines().filter((l) => l.kind === 'grant.given' || l.kind === 'human.answered');

    // Число страницы без подписи — голос панели, не человека: оба отказа, журнал вопроса не тронут.
    for (const unsigned of [grant, answer]) {
      const refused = await s.command({ ...unsigned, proof: await s.nonce() });
      expect(refused).toMatchObject({ status: 403, body: { code: 'signature-required' } });
    }
    expect(effects()).toEqual([]);

    for (const cmd of [grant, answer]) {
      // Отвергнутый номер команды записан отказом: подписанная — новой командой, своим номером.
      const fresh = { ...cmd, cmdId: newId() };
      const applied = await s.command({ ...fresh, proof: { signature: s.device.signFor(fresh) } });
      expect(applied).toMatchObject({ status: 200, body: { status: 'applied' } });
    }
    expect(effects().map((l) => [l.kind, l.data])).toEqual([
      [
        'grant.given',
        expect.objectContaining({ project: 'r1', globs: ['migrations/1.sql'], ops: ['edit'] }),
      ],
      ['human.answered', expect.objectContaining({ askId: raised.askId, answer: 'grant' })],
    ]);
  });
});
