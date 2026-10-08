import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvider, listProviders } from '../../../providers/registry.ts';
import { ProviderChatRun } from './ProviderChatRun.ts';

/**
 * «Разрешить правки» на одиночном запуске (живого хода нет): флаг CLI ставится
 * только там, где он проверен по `--help` (codex 0.160 `--sandbox`, qwen 0.25.0
 * `--approval-mode`). Спросить человека одиночный запуск не может — выключено
 * значит «без правок», а не «как в настройках CLI».
 */

type SpawnImpl = Parameters<ProviderChatRun['start']>[0]['spawnImpl'];

/** Фейковый CLI, запоминающий командную строку целиком. */
function recordingSpawn(seen: string[]): SpawnImpl {
  return ((command: string, args: string[]) => {
    seen.push([command, ...args].join(' '));
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => {}, on: () => {} };
    child.kill = () => child.emit('close', null);
    setTimeout(() => {
      (child.stdout as EventEmitter).emit('data', Buffer.from('ок'));
      child.emit('close', 0);
    }, 0);
    return child;
  }) as unknown as SpawnImpl;
}

describe('одиночный запуск: «Разрешить правки» флагами CLI', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pchat-edits-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const lineOf = async (providerId: string, allowEdits?: boolean): Promise<string> => {
    const seen: string[] = [];
    await new ProviderChatRun().start(
      {
        provider: getProvider(providerId),
        history: [{ id: 'm1', role: 'user', content: 'Вопрос', at: '2026-01-01T00:00:00.000Z' }],
        chatId: 'chat',
        appDataDir: dir,
        detect: () => true,
        spawnImpl: recordingSpawn(seen),
        ...(allowEdits === undefined ? {} : { permission: { allowEdits } }),
      },
      () => {},
    );
    return seen[0] ?? '';
  };

  it('codex: включено — workspace-write, выключено — read-only', async () => {
    expect(await lineOf('codex', true)).toContain('--sandbox workspace-write');
    expect(await lineOf('codex', false)).toContain('--sandbox read-only');
  });

  it('qwen: включено — yolo, выключено — default (настройка yolo не действует молча)', async () => {
    expect(await lineOf('qwen', true)).toContain('--approval-mode yolo');
    expect(await lineOf('qwen', false)).toContain('--approval-mode default');
  });

  it('без политики argv прежний — флагов прав нет', async () => {
    expect(await lineOf('codex')).not.toContain('--sandbox');
    expect(await lineOf('qwen')).not.toContain('--approval-mode');
  });

  it('gemini: включено — yolo, выключено — default (0.62.0, проверено живьём)', async () => {
    expect(await lineOf('gemini', true)).toContain('--approval-mode yolo');
    expect(await lineOf('gemini', false)).toContain('--approval-mode default');
    expect(await lineOf('gemini')).not.toContain('--approval-mode');
  });

  it('CLI без проверенного флага argv не меняет', async () => {
    // Кто без флага — решает объявление (`editsControl: 'none'`), а не список
    // здесь: полосы CLI переводят своих в `flag` по одному.
    const unflagged = listProviders().filter(
      (provider) =>
        provider.id !== 'claude' &&
        (provider.assistant?.editsControl ?? 'none') === 'none' &&
        provider.assistant?.oneShotArgs &&
        !provider.assistant.sessionServer &&
        !provider.assistant.liveServer,
    );
    for (const provider of unflagged) {
      expect(await lineOf(provider.id, true)).toBe(await lineOf(provider.id, false));
    }
  });

  it('флаг стоит до промпта — промпт остаётся последним элементом', () => {
    expect(getProvider('codex').assistant?.oneShotArgs?.('P', { allowEdits: true })).toEqual([
      'exec',
      '--sandbox',
      'workspace-write',
      'P',
    ]);
    expect(getProvider('qwen').assistant?.oneShotArgs?.('P', { allowEdits: false })).toEqual([
      '--approval-mode',
      'default',
      '-p',
      'P',
    ]);
  });
});
