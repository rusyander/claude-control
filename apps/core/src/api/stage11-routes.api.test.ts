import { afterEach, describe, expect, it } from 'vitest';
import type { AgentsPort } from './agents.ts';
import type { AllocatorPort } from './allocator.ts';
import { startStand, TOKENS, type Stand } from './__fixtures__/api-harness.ts';

/**
 * Каркас маршрутов этапа 11 (W1-4) по настоящему HTTP: дерево агентов, места сеансов, активность
 * своей модели. Порта нет — 501 «не подключено», а не пустое дерево; с портом маршрут отдаёт
 * его вид; чтение — только с токеном ядра или панели.
 */

let stand: Stand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

const ROUTES = (taskId: string) => [
  `/v1/tasks/${taskId}/agents`,
  `/v1/tasks/${taskId}/agents/n1`,
  `/v1/tasks/${taskId}/agents/stream`,
  `/v1/tasks/${taskId}/agents/export`,
  '/v1/agents',
  '/v1/allocator',
  '/v1/local/activity',
  '/v1/local/activity/stream',
];

describe('stage-11 route skeleton', () => {
  it('every new read is 401 without a token and 501 not-implemented without a port', async () => {
    stand = await startStand();
    for (const path of ROUTES(stand.taskId)) {
      expect({ path, status: (await stand.get(path, '')).status }).toEqual({ path, status: 401 });
      const res = await stand.get(path, TOKENS.panel);
      const body = (await res.json()) as { code?: string };
      expect({ path, status: res.status, code: body.code }).toEqual({
        path,
        status: 501,
        code: 'not-implemented',
      });
    }
  });

  it('with ports: filters are parsed (400 on an unknown key), a missing task is 404, the view passes through', async () => {
    const calls: unknown[] = [];
    const agents: AgentsPort = {
      tree: (taskId, query) => {
        calls.push(query);
        return taskId === stand?.taskId ? ({ taskId, nodes: [] } as never) : undefined;
      },
      node: () => undefined,
      list: (query) => {
        calls.push(query);
        return { nodes: [], truncated: false };
      },
      exportSlice: (taskId) => (taskId === stand?.taskId ? '{"seq":1}\n' : undefined),
      follow: () => undefined,
    };
    const allocator: AllocatorPort = { view: () => ({ tickets: [] }) as never };
    stand = await startStand(undefined, { agents: () => agents, allocator: () => allocator });
    const id = stand.taskId;

    const tree = await stand.get(`/v1/tasks/${id}/agents?status=running&class=L`);
    expect(tree.status).toBe(200);
    expect(await tree.json()).toEqual({ taskId: id, nodes: [] });
    expect(calls[0]).toEqual({ status: 'running', class: 'L' });

    const bad = await stand.get(`/v1/agents?owner=x`);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('bad-query');
    expect((await stand.get(`/v1/agents?status=exit`)).status).toBe(400);
    expect(await (await stand.get('/v1/agents?groupId=g')).json()).toEqual({
      nodes: [],
      truncated: false,
    });

    const other = '01920000-0000-7000-8000-00000000ffff';
    expect((await stand.get(`/v1/tasks/${other}/agents`)).status).toBe(404);
    expect((await stand.get(`/v1/tasks/${id}/agents/n1`)).status).toBe(404);
    const slice = await stand.get(`/v1/tasks/${id}/agents/export`);
    expect(slice.status).toBe(200);
    expect(slice.headers.get('content-type')).toContain('application/x-ndjson');
    expect(await slice.text()).toBe('{"seq":1}\n');
    expect((await stand.get(`/v1/tasks/${other}/agents/export`)).status).toBe(404);

    // Поток идёт через порт (этап 11, зона истории): порт не знает задачи — 404 до потока.
    expect((await stand.get(`/v1/tasks/${id}/agents/stream`)).status).toBe(404);
    expect((await stand.get(`/v1/tasks/${id}/agents/stream?after=x`)).status).toBe(400);
    expect(await (await stand.get('/v1/allocator')).json()).toEqual({ tickets: [] });
  });
});
