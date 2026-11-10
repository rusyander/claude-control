import { afterEach, describe, expect, it } from 'vitest';
import type { WalkReply } from '@agentdeck/contracts/core/browse';
import { newId } from '../lib/ids/uuidv7.ts';
import { startStand, TOKENS, type Stand } from './__fixtures__/api-harness.ts';

/**
 * `GET /v1/tasks/:id/walk` (этап 12, P177): строки прохода задачи в порядке журнала — то, из чего
 * панель собирает спек записи. Секрет в строке — только имя.
 */

let stand: Stand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

describe('GET /v1/tasks/:id/walk returns the walk rows in journal order (P177)', () => {
  it('steps and gaps of the task, ended flag; read token only; bad id 400, unknown 404', async () => {
    stand = await startStand();
    const opened = await stand.registry.open(stand.taskId);
    if (!('task' in opened)) throw new Error(opened.refused);
    const task = opened.task;
    const empty = await stand.get(`/v1/tasks/${stand.taskId}/walk`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ taskId: stand.taskId, steps: [], gaps: [], ended: false });

    const stepId = newId();
    const checks = { console: 0, failed: 0, blank: false, stale: false };
    const open = {
      stepId,
      n: 1,
      action: 'open',
      value: 'http://127.0.0.1:4100/login',
      url: 'http://127.0.0.1:4100/login',
      checks,
      ok: true,
    } as const;
    const fill = {
      stepId,
      n: 2,
      action: 'fill',
      target: { label: 'Password' },
      secret: { name: 'STAND_PASSWORD' },
      url: 'http://127.0.0.1:4100/login',
      checks,
      ok: true,
    } as const;
    const gap = {
      stepId,
      action: 'hover',
      target: { text: 'Menu' },
      why: 'opens on hover',
    } as const;
    task.append({ kind: 'browse.step', actor: 'core', stepId, data: open });
    task.append({ kind: 'browse.gap', actor: 'core', stepId, data: gap });
    task.append({ kind: 'browse.step', actor: 'core', stepId, data: fill });

    const res = await stand.get(`/v1/tasks/${stand.taskId}/walk`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WalkReply;
    expect(body).toEqual({ taskId: stand.taskId, steps: [open, fill], gaps: [gap], ended: false });

    expect((await stand.get(`/v1/tasks/${stand.taskId}/walk`, TOKENS.panel)).status).toBe(200);
    expect((await stand.get(`/v1/tasks/${stand.taskId}/walk`, 'wrong-token')).status).toBe(401);
    expect((await stand.get(`/v1/tasks/not-an-id/walk`)).status).toBe(400);
    expect((await stand.get(`/v1/tasks/${newId()}/walk`)).status).toBe(404);
  });
});
