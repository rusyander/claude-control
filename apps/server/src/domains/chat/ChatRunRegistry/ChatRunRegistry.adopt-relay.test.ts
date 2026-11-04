import { describe, expect, it } from 'vitest';
import { ChatRunRegistry, type RunLike } from './ChatRunRegistry.ts';
import type { RunOptions } from '../run-options/run-options.ts';
import type { ChatEvent } from '../chat-events.ts';
import type { RunLedgerEntry } from '../run-ledger/run-ledger.ts';

/**
 * Прогон панели за посредником, оставшийся от прежней жизни панели (этап 10, G14).
 * Запуск CLI панелью снят — прогоны чата ведёт ядро (`CoreChatRun`), и фабрика реестра
 * отдаёт только их. Прежде усыновление сессии за посредником брало прогон из фабрики и
 * будило в нём ход по той же сессии: ядро поднимало второй CLI с `--resume`, пока
 * первый жил за посредником. Теперь такой прогон усыновляется без потока
 * (`DetachedRun`): посреднику закрывают ввод, CLI доделывает ход и выходит, конец —
 * по жизни pid. Путь настоящий (реестр, `adopt`, `run-reattach`); посредника нет —
 * канал указывает в пустоту, как у процесса, который уже ушёл.
 */

class CountingRun implements RunLike {
  started: RunOptions[] = [];
  start(options: RunOptions, _onEvent: (event: ChatEvent) => void): Promise<void> {
    this.started.push(options);
    return new Promise<void>(() => undefined);
  }
  stop(): void {}
}

const ENTRY: RunLedgerEntry = {
  key: 'relay-chat',
  sessionId: 'sess-relay-1',
  cwd: '/proj',
  pid: 4242,
  startedAt: 1,
  relay: {
    pipe:
      process.platform === 'win32'
        ? '\\\\.\\pipe\\agentdeck-test-absent-g14'
        : '/tmp/agentdeck-test-absent-g14.sock',
    pid: 4243,
    signature: 's',
  },
};

describe('ChatRunRegistry: прогон за посредником после перехода чата на ядро', () => {
  it('усыновляется без потока: фабрика (ядро) не зовётся, ход по сессии не будится', () => {
    const made: CountingRun[] = [];
    const registry = new ChatRunRegistry(() => {
      const run = new CountingRun();
      made.push(run);
      return run;
    });

    expect(
      registry.adopt(ENTRY, { isAlive: () => true, kill: () => undefined, pollMs: 60_000 }),
    ).toBe(true);

    expect(made).toHaveLength(0);
    expect(registry.active().find((run) => run.chatId === 'relay-chat')?.status).toBe('running');
    registry.stopAll();
  });

  it('ждущая сессия за посредником не усыновляется и прогоном не считается', () => {
    const made: CountingRun[] = [];
    const registry = new ChatRunRegistry(() => {
      const run = new CountingRun();
      made.push(run);
      return run;
    });

    expect(
      registry.adopt({ ...ENTRY, idle: true }, { isAlive: () => true, kill: () => undefined }),
    ).toBe(false);

    expect(made).toHaveLength(0);
    expect(registry.active()).toEqual([]);
    registry.stopAll();
  });
});
