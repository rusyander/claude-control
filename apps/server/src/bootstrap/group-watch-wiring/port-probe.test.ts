import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createPortProbe, probePort } from './port-probe.ts';

/**
 * Проба порта для R36 — настоящим соединением с петлёй: слушающий сервер и закрытый
 * порт. Кэш пробы отвечает по прошлой пробе и заказывает новую, когда та устарела.
 */

let server: Server | undefined;

afterEach(async () => {
  const open = server;
  server = undefined;
  if (open) await new Promise<void>((resolve) => open.close(() => resolve()));
});

async function listen(): Promise<number> {
  const open = createServer((socket) => socket.end());
  server = open;
  await new Promise<void>((resolve) => open.listen(0, '127.0.0.1', resolve));
  const address = open.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
}

describe('port-probe (R36)', () => {
  it('слушающий порт — да; тот же порт после закрытия сервера — нет', async () => {
    const port = await listen();
    expect(await probePort(port)).toBe(true);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    expect(await probePort(port)).toBe(false);
  });

  it('кэш: первый ответ «нет» до пробы, после пробы — её итог; устаревшая проба повторяется', async () => {
    const port = await listen();
    let now = 1_000_000;
    const probe = createPortProbe(probePort, () => now);
    expect(probe.alive(port)).toBe(false);
    await probe.settle();
    expect(probe.alive(port)).toBe(true);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    // Проба свежая — ответ прежний, новой нет.
    expect(probe.alive(port)).toBe(true);
    await probe.settle();
    expect(probe.alive(port)).toBe(true);
    now += 31_000;
    expect(probe.alive(port)).toBe(true);
    await probe.settle();
    expect(probe.alive(port)).toBe(false);
  });

  it('порт вне диапазона — «нет» без пробы', async () => {
    let calls = 0;
    const probe = createPortProbe(async () => {
      calls += 1;
      return true;
    });
    expect(probe.alive(0)).toBe(false);
    expect(probe.alive(70_000)).toBe(false);
    expect(probe.alive(1.5)).toBe(false);
    await probe.settle();
    expect(calls).toBe(0);
  });

  it('проба упала — порт считается закрытым', async () => {
    const probe = createPortProbe(() => Promise.reject(new Error('boom')));
    probe.alive(4000);
    await probe.settle();
    expect(probe.alive(4000)).toBe(false);
  });
});
