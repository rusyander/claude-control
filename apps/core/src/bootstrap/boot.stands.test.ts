import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREATED, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { createStandWatch } from '../verifier/stand/index.ts';
import { bootCore, type BootedCore } from './boot.ts';
import type { ConductorWiringDeps } from './conductor-wiring/conductor-wiring.types.ts';

/**
 * Реестр стендов в сборке ядра (F-081, F-165): дорога сессии, которую загрузка отдаёт дирижёру,
 * держит ТОТ ЖЕ реестр стендов, что сервисы проверок (`verifier.services.stands`), — конец задачи
 * через дорогу снимает наблюдение стенда, к которому прикреплялась очередь. Подмен нет: настоящая
 * загрузка во временном доме; дирижёр запускается настоящий, тест только запоминает его вход.
 */

const seen: { deps?: ConductorWiringDeps } = {};
vi.mock('./conductor-wiring/index.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./conductor-wiring/index.ts')>();
  return {
    ...real,
    startConductor: (deps: ConductorWiringDeps) => {
      seen.deps = deps;
      return real.startConductor(deps);
    },
  };
});

let core: BootedCore | undefined;
afterEach(async () => {
  await core?.stop().catch(() => undefined);
  core = undefined;
});

async function closedPortUrl(): Promise<string> {
  const s: Server = createServer();
  await new Promise<void>((done) => s.listen(0, '127.0.0.1', done));
  const { port } = s.address() as { port: number };
  await new Promise((done) => s.close(done));
  return `http://127.0.0.1:${port}/health`;
}

describe('boot hands one stand registry to the session road and the check services', () => {
  it('task end through the booted road releases the core stand and detaches the watch the verifier attached', async () => {
    core = await bootCore({ home: join(tempDir('boot-stands-'), 'core'), build: 'stands-test' });
    const deps = seen.deps;
    expect(deps).toBeDefined();
    const task = await core.registry.create(CREATED);
    const url = await closedPortUrl();
    const rid = newId();
    task.append({
      kind: 'resource.created',
      actor: 'core',
      data: {
        rid,
        kind: 'stand',
        owner: 'core',
        release: 'task-end',
        ref: JSON.stringify({ pid: 999_999, start: 'gone-long-ago', health: url }),
      },
    });
    const stands = deps!.verifier.services.stands;
    stands.attach(task.taskId, createStandWatch({ health: url, intervalMs: 60_000 }));
    expect(stands.get(task.taskId)).toBeDefined();

    const released = await deps!.road.releaseTask(task);

    expect(released.verified).toEqual([{ rid, fact: expect.stringMatching(/not answering/) }]);
    expect(stands.get(task.taskId)).toBeUndefined();
  }, 60_000);
});
