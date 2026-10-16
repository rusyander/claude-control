import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostname } from 'node:os';
import { createRunNotifier } from './remote-notify.ts';

/** Сеть — единственное, что подменяем: что именно уходит в Expo, видно по телу запроса. */
describe('createRunNotifier', () => {
  let bodies: unknown[];

  beforeEach(() => {
    bodies = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ data: [{ status: 'ok' }] }));
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const notify = (machineId?: () => string) =>
    createRunNotifier({
      isEnabled: () => true,
      devices: () => [
        { token: 'ExponentPushToken[x]', platform: 'android', label: 'Pixel', registeredAt: '' },
      ],
      forget: () => {},
      machineId,
    });

  it('номер машины уходит в data, имя машины — нет', async () => {
    notify(() => 'machine-1')({ kind: 'done', chatId: 'c1', projectPath: '/work/app' });
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    const [message] = bodies[0] as { title: string; body: string; data: object }[];
    expect(message?.data).toEqual({
      kind: 'done',
      chatId: 'c1',
      projectPath: '/work/app',
      machineId: 'machine-1',
    });
    expect(JSON.stringify(bodies[0])).not.toContain(hostname());
  });

  it('без номера поле не появляется — старый формат как был', async () => {
    notify()({ kind: 'question', chatId: 'c2' });
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    const [message] = bodies[0] as { data: object }[];
    expect(message?.data).not.toHaveProperty('machineId');
  });
});
