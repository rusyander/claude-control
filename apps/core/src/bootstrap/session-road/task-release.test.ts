import { createServer, type Server } from 'node:net';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { createStandRegistry, createStandWatch } from '../../verifier/stand/index.ts';
import { createSessionRoad, type RoadDeps } from './road.ts';

/**
 * Конец задачи через дорогу сессии (ревью A2r5-F04, проводка): стенд ядра `task-end` снимается
 * `releaseTask` и снимается с наблюдения реестра стендов, который дорога получила. Процесс стенда
 * давно ушёл (pid с чужим временем старта), адрес здоровья — закрытый порт на 127.0.0.1: снятие,
 * чтение назад и реестр — настоящие; дороге даны только поля, которые читает конец задачи.
 */

const root = tempDir('task-release-');
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function closedPortUrl(): Promise<string> {
  const s: Server = createServer();
  await new Promise<void>((done) => s.listen(0, '127.0.0.1', done));
  const { port } = s.address() as { port: number };
  await new Promise((done) => s.close(done));
  return `http://127.0.0.1:${port}/health`;
}

describe('road releaseTask releases the core stand and detaches its watch (A2r5-F04)', () => {
  it('a stand row task-end → verified, the registry no longer watches the task', async () => {
    const registry = createTaskRegistry(join(root, 'tasks'), deps());
    const task = await registry.create(CREATED);
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
    const stands = createStandRegistry();
    stands.attach(task.taskId, createStandWatch({ health: url, intervalMs: 60_000 }));
    const road = createSessionRoad({
      layout: { root: join(root, 'home'), token: join(root, 'home', 'token') },
      routes: { list: () => [], get: () => undefined },
      stands,
    } as unknown as RoadDeps);

    const released = await road.releaseTask(task);

    expect(released.leaks).toEqual([]);
    expect(released.verified).toEqual([{ rid, fact: expect.stringMatching(/not answering/) }]);
    expect(released.unread).toEqual([]);
    expect(stands.get(task.taskId)).toBeUndefined();
    registry.closeAll();
  });
});
