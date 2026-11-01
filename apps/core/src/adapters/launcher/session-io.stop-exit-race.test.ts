import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { channelPath } from '../../platform/control-channel.ts';
import { waitFor } from '../../platform/__fixtures__/harness.ts';
import { runHost } from '../../session-host/host.ts';
import { sessionFile, type HostSpec } from '../../session-host/protocol.ts';
import { stopSession } from './session-io.ts';

/**
 * CLI вышел сам ровно тогда, когда его останавливают: хост уже записал exit.json, послал `exit` и
 * закрыл канал, так что ответа `stopped` не будет — остановка обязана прочитать исход, а не упасть
 * «host channel closed» (так падал afterAll живого набора sdk-adapter на Linux). Хост — в процессе
 * теста (как в `session-io.stop-unknown`), CLI и канал настоящие; подключение обёрнуто, только
 * чтобы остановка гарантированно пришла после выхода CLI, а не случайно.
 */

vi.mock('../../session-host/client.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../session-host/client.ts')>();
  return {
    ...real,
    attachSession: async (dir: string) => {
      const attached = await real.attachSession(dir);
      if (attached.state !== 'live') throw new Error(`attach: ${attached.state}`);
      // Подключились к живому хосту; теперь CLI выходит сам, хост пишет исход и закрывает канал.
      writeFileSync(join(dir, 'go'), '');
      const connection = attached.session as unknown as { closedError?: Error };
      await waitFor(() =>
        existsSync(sessionFile(dir, 'exit')) && connection.closedError ? true : undefined,
      );
      return attached;
    },
  };
});

const TOKEN = 'b'.repeat(48);
const root = mkdtempSync(join(tmpdir(), 'host-stop-race-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('stopSession when the CLI exits by itself as the stop goes out', () => {
  it('the closed channel is not a failure: the stop reports already-exited with the recorded code', async () => {
    const dir = mkdtempSync(join(root, 'race-'));
    const sessionId = `stop-race-${process.pid}-${Date.now()}`;
    writeFileSync(sessionFile(dir, 'token'), TOKEN);
    const spec: HostSpec = {
      v: 1,
      sessionId,
      command: process.execPath,
      // Выходит сам с кодом 3, как только подключение положило метку `go`.
      args: [
        '-e',
        `const fs = require('node:fs');
         setInterval(() => fs.existsSync(${JSON.stringify(join(dir, 'go'))}) && process.exit(3), 20);`,
      ],
      cwd: dir,
      env: { ...(process.env as Record<string, string>) },
      channel: channelPath(sessionId),
    };
    writeFileSync(sessionFile(dir, 'spec'), JSON.stringify(spec));
    const running = runHost(dir);
    await waitFor(() => (existsSync(sessionFile(dir, 'host')) ? true : undefined));
    // Хост здесь — сам процесс теста: ждать его ухода незачем.
    const outcome = await stopSession(dir, 'tree', 1_000, 0);
    await running;
    expect(outcome).toMatchObject({ how: 'already-exited', code: 3 });
  }, 60_000);
});
