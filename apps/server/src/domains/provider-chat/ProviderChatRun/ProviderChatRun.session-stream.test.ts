import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvider } from '../../../providers/registry.ts';
import type { OpencodeServe, OpencodeServeDeps } from '../../opencode-serve/opencode-serve.ts';
import { ProviderChatRun } from './ProviderChatRun.ts';

/**
 * Сессия OpenCode в чате: ответ идёт кусками шины `/event`, упавший ход
 * приходит в поток причиной CLI, а одиночный `opencode run` после начатого хода
 * не запускается (он повторил бы ход и напечатал бы его второй раз). Плюс общий
 * путь одиночного запуска: цвета терминала из stderr в переписку не попадают.
 * Живой прогон — `tools/qa/check-foreign-first-talk.mjs --cli opencode`.
 */

type SpawnImpl = Parameters<ProviderChatRun['start']>[0]['spawnImpl'];
type Event = { type: string; text?: string; reply?: string; error?: string };

const history = [
  { id: 'm1', role: 'user' as const, content: 'Вопрос', at: '2026-01-01T00:00:00.000Z' },
];

/** Подделка одиночного запуска: пишет в stdout/stderr и выходит с кодом. */
function fakeSpawn(stdout: string, stderr: string, code: number) {
  const spawned = vi.fn();
  const spawnImpl = ((command: string, args: string[]) => {
    spawned(command, args);
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write: () => {},
      on: () => {},
      end: () =>
        setTimeout(() => {
          if (stdout) (child.stdout as EventEmitter).emit('data', Buffer.from(stdout));
          if (stderr) (child.stderr as EventEmitter).emit('data', Buffer.from(stderr));
          child.emit('close', code);
        }, 0),
    };
    child.kill = () => child.emit('close', null);
    return child;
  }) as unknown as SpawnImpl;
  return { spawnImpl, spawned };
}

describe('OpenCode в чате: сессия потоком', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pchat-ocstream-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const run = async (serve: OpencodeServe, spawnImpl?: SpawnImpl) => {
    const events: Event[] = [];
    await new ProviderChatRun().start(
      {
        provider: getProvider('opencode'),
        history,
        chatId: 'chat',
        appDataDir: dir,
        detect: () => true,
        sessionServe: serve,
        timeoutMs: 2_000,
        ...(spawnImpl ? { spawnImpl } : {}),
      },
      (event) => events.push(event as Event),
    );
    return events;
  };

  it('куски шины — delta по одному, целый ответ не дублируется; done несёт целое', async () => {
    const serve = {
      ask: async (_id: string, _text: string, deps: OpencodeServeDeps) => {
        deps.onDelta?.('При');
        deps.onDelta?.('вет!');
        return { reply: 'Привет!', sessionId: 'ses_1' };
      },
      steer: async () => false,
    } as unknown as OpencodeServe;

    const events = await run(serve);

    expect(events.filter((e) => e.type === 'delta').map((e) => e.text)).toEqual(['При', 'вет!']);
    expect(events.at(-1)).toMatchObject({ type: 'done', reply: 'Привет!', transport: 'session' });
  });

  it('упавший ход — причина CLI в поток, одиночный запуск не стартует', async () => {
    const serve = {
      ask: async () => ({ error: 'Model not found: opencode/nope.', sessionId: 'ses_1' }),
      steer: async () => false,
    } as unknown as OpencodeServe;
    const { spawnImpl, spawned } = fakeSpawn('ответ run', '', 0);

    const events = await run(serve, spawnImpl);

    expect(spawned).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: 'Model not found: opencode/nope.',
      reason: 'cli_error',
    });
  });

  it('ошибка одиночного запуска приходит без цветов терминала', async () => {
    const noSession = {
      ask: async () => undefined,
      steer: async () => false,
    } as unknown as OpencodeServe;
    const esc = String.fromCharCode(27);
    const { spawnImpl } = fakeSpawn('', `${esc}[91m${esc}[1mError: ${esc}[0mModel not found`, 1);

    const events = await run(noSession, spawnImpl);

    expect(events.at(-1)).toMatchObject({ type: 'error', error: 'Error: Model not found' });
  });
});
