import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_GIT_ASK } from '../auto-approve/git-ask.ts';

/**
 * L2 (ревью 23.10): в авторежиме CLI до брокера прав доходит только задетое
 * правилом `ask`. Запуск с брокером в авторежиме обязан нести `CHAT_GIT_ASK` в
 * файле `--settings`, не стирая своих правил. Подменён только `spawn` — файл
 * читается таким, каким его получил бы CLI.
 */

class FakeChild extends EventEmitter {
  readonly stdin = Object.assign(new EventEmitter(), {
    write: (): boolean => true,
    end: () => undefined,
  });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

async function settingsOf(
  cwd: string,
  options: {
    permissionMode: string;
    broker: boolean;
    platformSettings?: Record<string, unknown>;
  },
): Promise<Record<string, unknown> | undefined> {
  let settings: Record<string, unknown> | undefined;
  vi.resetModules();
  vi.doMock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:child_process')>()),
    spawn: (_command: string, args: string[]) => {
      args.forEach((arg, index) => {
        if (arg !== '--settings') return;
        const value = (args[index + 1] ?? '').replace(/^"|"$/g, '');
        settings = JSON.parse(readFileSync(value, 'utf8')) as Record<string, unknown>;
      });
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    },
  }));
  const { ChatRun } = await import('./ChatRunner.ts');
  await new ChatRun().start(
    {
      prompt: 'ok',
      cwd,
      permissionMode: options.permissionMode,
      ...(options.platformSettings ? { platformSettings: options.platformSettings } : {}),
      ...(options.broker
        ? { permissionPrompt: { runId: 'r1', baseUrl: 'http://127.0.0.1:1' } }
        : {}),
    },
    () => undefined,
  );
  return settings;
}

const askOf = (settings: Record<string, unknown> | undefined): unknown[] =>
  ((settings?.permissions as { ask?: unknown[] } | undefined)?.ask ?? []) as unknown[];

describe('ChatRunner: правила `ask` git в авторежиме с брокером', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'cc-runner-gitask-'));
  });
  afterEach(() => {
    vi.doUnmock('node:child_process');
    rmSync(cwd, { recursive: true, force: true });
  });

  it('авторежим с брокером — `CHAT_GIT_ASK` в файле настроек', async () => {
    const ask = askOf(await settingsOf(cwd, { permissionMode: 'auto', broker: true }));
    expect(ask).toEqual(expect.arrayContaining([...CHAT_GIT_ASK]));
    expect(ask).toContain('Bash(*git*branch*-*D*)');
    // Инструмент PowerShell — теми же правилами (I-08): `Bash(…)` его не задевает.
    expect(ask).toContain('PowerShell(*git*branch*-*D*)');
    expect(ask.filter((rule) => String(rule).startsWith('PowerShell('))).toHaveLength(
      CHAT_GIT_ASK.length,
    );
  });

  it('свои правила профиля остаются, повторов нет', async () => {
    const settings = await settingsOf(cwd, {
      permissionMode: 'auto',
      broker: true,
      platformSettings: {
        permissions: { ask: ['Bash(git *)', 'Bash(*git*merge*)'], deny: ['mcp__x__merge'] },
        env: { A: '1' },
      },
    });
    const ask = askOf(settings);
    expect(ask[0]).toBe('Bash(git *)');
    expect(ask).toEqual(expect.arrayContaining([...CHAT_GIT_ASK]));
    expect(ask.filter((rule) => rule === 'Bash(*git*merge*)')).toHaveLength(1);
    expect((settings?.permissions as { deny?: unknown }).deny).toEqual(['mcp__x__merge']);
    expect(settings?.env).toEqual({ A: '1' });
  });

  it('не авторежим или без брокера — правил не добавляет', async () => {
    expect(askOf(await settingsOf(cwd, { permissionMode: 'acceptEdits', broker: true }))).toEqual(
      [],
    );
    expect(askOf(await settingsOf(cwd, { permissionMode: 'auto', broker: false }))).toEqual([]);
  });
});
