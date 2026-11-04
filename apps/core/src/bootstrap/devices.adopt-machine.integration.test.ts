import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
import { makeDevice, MACHINE_ID } from '../api/__fixtures__/api-harness.ts';
import { raiseHumanPoint } from '../conductor/human/raise.ts';
import { createTaskRegistry } from '../conductor/tasks.ts';
import { CREATED, deps, fakeClock, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { ensureCoreHome } from '../platform/core-home.ts';
import { bootCore } from './boot.ts';

/**
 * Номер машины панели в ядре (этап 10, Q5): телефон подписывает номером ПАНЕЛИ, а ядро судило
 * подпись своим `<дом ядра>/machine-id` — ни одна подпись телефона не проходила. Перенос
 * устройств (`adopt-devices`) несёт номер панели, и загруженное ядро судит им уже следующую
 * подпись — без перезапуска. Ядро — настоящее (`bootCore`: проводка API, пир по таблице ОС).
 */

describe('adopt-devices carries the panel machine id into a booted core (stage 10, Q5)', () => {
  it('a device signature for the panel machine id is refused until adopt names that id, then the answer is applied', async () => {
    const home = join(tempDir('adopt-mid-'), 'core');
    const layout = ensureCoreHome(home);
    const seed = createTaskRegistry(layout.tasks, deps({ clock: fakeClock(Date.now()) }));
    const task = await seed.create(CREATED);
    const raised = raiseHumanPoint(task, {
      source: 'launch',
      stepId: null,
      sessionId: null,
      action: { kind: 'launch', target: newId() },
      point: 10,
      dedupe: null,
      question: 'Launch the task?',
      options: ['approve-split', 'cancel'],
      recommendation: 'approve-split',
      blocking: true,
    });
    if (raised.kind !== 'asked') throw new Error(`ask not raised: ${raised.kind}`);
    seed.closeAll();

    const core = await bootCore({ home, build: 'adopt-mid-test' });
    try {
      const token = readFileSync(layout.token, 'utf8').trim();
      const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const post = async (path: string, body: unknown) => {
        const res = await fetch(`${core.url}${path}`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify(body),
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };
      const nonce = async () => {
        const page = newId();
        const res = await fetch(`${core.url}/v1/nonce?page=${page}`, { headers: auth });
        return { nonce: ((await res.json()) as { nonce: string }).nonce, page };
      };
      const phone = makeDevice();
      const adopt = async (machineId: string) =>
        post('/v1/devices/adopt', {
          cmdId: newId(),
          machineId,
          devices: [phone.device],
          proof: await nonce(),
        });
      const answer = () => {
        const command: Omit<CommandEnvelope, 'proof'> = {
          cmdId: newId(),
          kind: 'answer',
          target: { taskId: task.taskId },
          fields: { askId: raised.askId, answer: 'approve-split' },
        };
        // `makeDevice` подписывает номером `MACHINE_ID` — это «номер машины панели».
        return post('/v1/commands', { ...command, proof: { signature: phone.signFor(command) } });
      };

      const own = readFileSync(join(layout.root, 'machine-id'), 'utf8').trim();
      expect(own).not.toBe(MACHINE_ID);
      // Устройство известно, номер — чужой: подпись телефона не проходит.
      expect((await adopt('other-machine-0001')).status).toBe(200);
      expect(await answer()).toMatchObject({ status: 403, body: { code: 'signature-invalid' } });

      const adopted = await adopt(MACHINE_ID);
      expect(adopted).toMatchObject({ status: 200, body: { machineId: MACHINE_ID } });
      expect(readFileSync(join(layout.root, 'machine-id'), 'utf8')).toBe(`${MACHINE_ID}\n`);
      expect(await answer()).toMatchObject({ status: 200, body: { status: 'applied' } });
    } finally {
      await core.stop();
    }
  }, 60_000);
});
