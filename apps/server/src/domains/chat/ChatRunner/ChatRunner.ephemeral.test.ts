import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatRun } from './ChatRunner.ts';
import type { ChatEvent } from '../chat-events.ts';
import { LiveSessionPool } from '../live-session/live-session.ts';

/**
 * Разовый ход без следа (`ephemeral`) — путь пинга тёплого кэша: CLI получает
 * `--no-session-persistence` (транскрипта нет, в списке чатов пинга нет), а
 * процесс после хода закрывается, а не ждёт следующего в пуле живых сессий.
 * Процесс настоящий, подменён только CLI (`fake-live-cli.mjs`).
 */

const FAKE = fileURLToPath(new URL('../__fixtures__/fake-live-cli.mjs', import.meta.url));
const COMMAND = process.platform === 'win32' ? `"${process.execPath}" "${FAKE}"` : FAKE;
const SESSION = 'live-session-0001';

let cwd: string | undefined;
let pool: LiveSessionPool | undefined;

beforeAll(() => {
  if (process.platform !== 'win32') chmodSync(FAKE, 0o755);
});

afterEach(() => {
  pool?.closeAll();
  pool = undefined;
  if (!cwd) return;
  try {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    /* папку держит умирающий процесс */
  }
  cwd = undefined;
});

async function forkTurn(ephemeral: boolean): Promise<string> {
  cwd = mkdtempSync(join(tmpdir(), 'ephemeral-'));
  pool = new LiveSessionPool();
  let text = '';
  await new ChatRun(pool).start(
    {
      prompt: 'ARGV',
      cwd,
      command: COMMAND,
      sessionId: 'group-session',
      fork: true,
      ...(ephemeral ? { ephemeral: true } : {}),
    },
    (event: ChatEvent) => {
      if (event.kind === 'text') text += event.text;
    },
  );
  return text;
}

describe('разовый ход без следа (ephemeral)', { timeout: 30_000 }, () => {
  it('CLI получает --no-session-persistence, процесс не остаётся в пуле', async () => {
    const text = await forkTurn(true);
    expect(text).toContain('--fork-session');
    expect(text).toContain('--no-session-persistence');
    expect(pool?.has(SESSION)).toBe(false);
  });

  it('контроль: обычное ответвление без флага и остаётся ждать следующего хода', async () => {
    const text = await forkTurn(false);
    expect(text).toContain('--fork-session');
    expect(text).not.toContain('--no-session-persistence');
    expect(pool?.has(SESSION)).toBe(true);
  });
});
