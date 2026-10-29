import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputRefused, type HostConnection } from '../../session-host/client.ts';
import { sessionFile } from '../../session-host/protocol.ts';
import type { SdkRule } from './normalise.ts';
import { SdkSession } from './session.ts';

/**
 * core-s2 F-38, сторона насоса: хост отказал в записи отправки — её ожидание хода снимается
 * (`normaliser.forget`), иначе при правиле без эха `waiting` не пустеет и следующая отправка
 * не уходит никогда. Подменена только граница — канал хоста; насос и нормализатор настоящие.
 */

const written: string[] = [];
const host = {
  send: async (cmdId: string): Promise<{ dup: boolean }> => {
    written.push(cmdId);
    if (cmdId === 'refused-1') throw new InputRefused(cmdId, 'cli stdin closed');
    return { dup: false };
  },
  close: () => undefined,
} as unknown as HostConnection;

vi.mock('../../session-host/client.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../session-host/client.ts')>();
  return { ...real, attachSession: async () => ({ state: 'live', session: host }) };
});

const opened: SdkSession[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  written.length = 0;
});

const NO_ECHO: SdkRule = {
  echo: false,
  mapPermission: (raw) => ({ action: 'exec', target: raw.tool, tool: raw.tool, display: raw.tool }),
};

describe('core-s2 sdk-stream session pump — a refused send', () => {
  it('F-38 a send the host refused is forgotten, so the next send still goes out (rule without echo)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'sdk-session-forget-'));
    writeFileSync(sessionFile(d, 'stdout'), '');
    const s = new SdkSession(d, NO_ECHO, { pollMs: 10 });
    opened.push(s);
    await expect(s.send('refused-1', 'first')).rejects.toBeInstanceOf(InputRefused);
    const second = s.send('next-2', 'second');
    const outcome = await Promise.race([
      second,
      new Promise<'stuck'>((done) => setTimeout(() => done('stuck'), 2_000)),
    ]);
    expect(outcome).toEqual({ dup: false });
    expect(written).toEqual(['refused-1', 'next-2']);
  });
});
