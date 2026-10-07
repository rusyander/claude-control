import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getProvider } from '../../providers/registry.ts';
import { ProviderChatRun, type ProviderChatRunEvent } from './ProviderChatRun.ts';

/**
 * `assistant.oneShotEnv` — переключатель «Разрешить правки» у CLI, которому режим
 * задают окружением, а не флагом (Goose: `GOOSE_MODE`). Подменён только процесс
 * CLI (внешняя граница): видно, с каким окружением и argv он был бы запущен, а
 * его stdout — настоящий вывод Goose 1.53 (фикстура каталога).
 */

const stdout = readFileSync(
  fileURLToPath(
    new URL(
      '../../providers/catalog/__fixtures__/goose-1.53-run-stream-json.jsonl',
      import.meta.url,
    ),
  ),
  'utf8',
);

interface Spawned {
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
}

function fakeSpawn(seen: Spawned[]) {
  return ((_file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    seen.push({ args, env: options?.env });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: () => void; end: () => void; on: () => void };
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => {}, on: () => {} };
    child.kill = () => child.emit('close', null);
    setTimeout(() => {
      // Кусками по 50 байт: строка JSON рвётся посередине, как в настоящей трубе.
      for (let at = 0; at < stdout.length; at += 50)
        child.stdout.emit('data', Buffer.from(stdout.slice(at, at + 50)));
      child.emit('close', 0);
    }, 0);
    return child;
  }) as unknown as Parameters<ProviderChatRun['start']>[0]['spawnImpl'];
}

describe('ProviderChatRun: одиночный запуск Goose', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pchat-goose-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const run = async (allowEdits: boolean | undefined) => {
    const seen: Spawned[] = [];
    const events: ProviderChatRunEvent[] = [];
    await new ProviderChatRun().start(
      {
        provider: getProvider('goose'),
        history: [{ id: 'm1', role: 'user', content: 'Вопрос', at: '2026-01-01T00:00:00.000Z' }],
        chatId: 'chat',
        appDataDir: dir,
        detect: () => true,
        spawnImpl: fakeSpawn(seen),
        ...(allowEdits === undefined ? {} : { permission: { allowEdits } }),
      } as Parameters<ProviderChatRun['start']>[0],
      (event) => events.push(event),
    );
    return { seen, events };
  };

  it('правки выключены — GOOSE_MODE=chat; ответ без инструмента и без заставки', async () => {
    const { seen, events } = await run(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.env?.GOOSE_MODE).toBe('chat');
    // На win32 без `.exe` на PATH запуск идёт через cmd.exe — argv склеен в строку.
    expect(seen[0]?.args.join(' ')).toContain('--output-format stream-json');
    expect(events.at(-1)).toEqual({
      type: 'done',
      reply: 'Сначала проверю. \n\nГотово: файл на месте.',
      transport: 'stream',
    });
  });

  it('правки разрешены — GOOSE_MODE=auto', async () => {
    const { seen } = await run(true);
    expect(seen[0]?.env?.GOOSE_MODE).toBe('auto');
  });

  it('переключателя нет — режим не задаётся, решает конфиг человека', async () => {
    const saved = process.env.GOOSE_MODE;
    delete process.env.GOOSE_MODE;
    try {
      const { seen } = await run(undefined);
      expect(seen[0]?.env?.GOOSE_MODE).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.GOOSE_MODE = saved;
    }
  });
});
