import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { taskAttachmentsPath } from '@agentdeck/contracts/core/estimate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../lib/ids/uuidv7.ts';
import { isInside } from '../platform/paths.ts';
import { startStand, TOKENS, type Stand } from './__fixtures__/api-harness.ts';

/**
 * `POST /v1/tasks/:id/attachments` (этап 10, s10 G11) через настоящий Fastify: суд полномочий класса
 * `message-to-step`, сверка байтов, копия в каталоге задачи, повтор того же звонка — та же копия.
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let stand: Stand;
beforeAll(async () => {
  stand = await startStand();
});
afterAll(async () => {
  await stand.close();
});

async function post(
  taskId: string,
  body: Record<string, unknown>,
  token: string | null = TOKENS.core,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${stand.url}${taskAttachmentsPath(taskId)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const attachment = (name: string, bytes: Buffer) => ({ name, base64: bytes.toString('base64') });
const proven = async (cmdId: string, item: { name: string; base64: string }) => ({
  cmdId,
  attachment: item,
  proof: await stand.nonce(),
});

describe('task attachment route', () => {
  it('authority first: no token 401, session token forged, no proof refused — nothing stored', async () => {
    const item = attachment('a.png', PNG);
    expect((await post(stand.taskId, await proven(newId(), item), null)).status).toBe(401);
    const forged = await post(stand.taskId, await proven(newId(), item), TOKENS.session);
    expect([forged.status, forged.body.code]).toEqual([403, 'forged-authority']);
    const bare = await post(stand.taskId, { cmdId: newId(), attachment: item, proof: {} });
    expect([bare.status, bare.body.code]).toEqual([403, 'proof-required']);
  });

  it('a valid image lands under the task attachments dir; the same call again is the same copy; other bytes under it are refused', async () => {
    const cmdId = newId();
    const first = await post(stand.taskId, await proven(cmdId, attachment('shot.png', PNG)));
    expect(first.status).toBe(201);
    const file = first.body.file as string;
    // Вне дома ядра: `<корень вложений>/<taskId>/<cmdId>/<имя>` (00 §Core home).
    expect(file).toBe(join(stand.layout.attachments, stand.taskId, cmdId, 'shot.png'));
    expect(isInside(stand.layout.root, file)).toBe(false);
    expect(readFileSync(file).equals(PNG)).toBe(true);
    expect(first.body).toMatchObject({ name: 'shot.png', bytes: PNG.length });

    const again = await post(stand.taskId, await proven(cmdId, attachment('shot.png', PNG)));
    expect([again.status, again.body.file]).toEqual([201, file]);

    const swapped = Buffer.concat([PNG, Buffer.from([0])]);
    const clash = await post(stand.taskId, await proven(cmdId, attachment('shot.png', swapped)));
    expect([clash.status, clash.body.code]).toEqual([422, 'attachment-refused']);
    expect(readFileSync(file).equals(PNG)).toBe(true);
  });

  it('bytes that are not the named image, an unsupported name and an unknown task are refused', async () => {
    const fake = await post(
      stand.taskId,
      await proven(newId(), attachment('fake.png', Buffer.from('not a png'))),
    );
    expect([fake.status, fake.body.code]).toEqual([422, 'attachment-refused']);
    expect(JSON.stringify(fake.body.problems)).toMatch(/fake\.png/);
    const exe = await post(stand.taskId, await proven(newId(), attachment('run.exe', PNG)));
    expect([exe.status, exe.body.code]).toEqual([422, 'attachment-refused']);
    const unknown = await post(newId(), await proven(newId(), attachment('a.png', PNG)));
    expect([unknown.status, unknown.body.code]).toEqual([404, 'no-task']);
  });
});
