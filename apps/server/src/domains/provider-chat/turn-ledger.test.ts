import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ConfigProvider } from '../../providers/types/types.ts';
import { ProviderChatService } from './ProviderChatService/ProviderChatService.ts';
import type {
  ProviderChatRunEvent,
  ProviderChatRunLike,
} from './ProviderChatRun/ProviderChatRun.ts';
import { createChat } from './store/store.ts';
import { markProviderTurn, PROVIDER_TURN_LEDGER } from './turn-ledger.ts';
import { RUN_LEDGERS, busyRun } from '../../lib/dev-watch.mjs';

/**
 * F2: ход чужого CLI живёт процессом сервера, и сторож разработки обязан его
 * видеть, иначе правка исходника посреди ответа Codex/Qwen обрывала ход.
 */

class FakeRun implements ProviderChatRunLike {
  emit: ((event: ProviderChatRunEvent) => void) | undefined;
  start(_options: unknown, onEvent: (event: ProviderChatRunEvent) => void): Promise<void> {
    this.emit = onEvent;
    return new Promise<void>(() => {});
  }
  stop(): void {}
}

const PROVIDER = { id: 'codex', name: 'Codex' } as ConfigProvider;

describe('журнал ходов чужих CLI', () => {
  let dir: string;
  const ledger = (): unknown[] =>
    JSON.parse(readFileSync(join(dir, PROVIDER_TURN_LEDGER), 'utf8')) as unknown[];
  const alive = (pid: number): boolean => pid === process.pid;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pturn-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('сторож читает тот журнал, который пишет чат чужого CLI', () => {
    expect(RUN_LEDGERS).toContain(PROVIDER_TURN_LEDGER);
    expect(RUN_LEDGERS).toContain('runs.json');
  });

  it('идущий ход — занято для сторожа, конец хода — свободно', () => {
    const run = new FakeRun();
    const service = new ProviderChatService(() => run);
    createChat(dir, 'codex', { id: 'chat', workdir: 'C:/work/proj' });
    expect(service.send(dir, 'codex', 'chat', { text: 'Вопрос' }, { provider: PROVIDER })).toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(ledger()).toEqual([
      expect.objectContaining({ key: 'codex:chat', cwd: 'C:/work/proj', pid: process.pid }),
    ]);
    expect(busyRun(ledger(), alive)).toBe(true);

    run.emit?.({ type: 'done', reply: 'Готово', transport: 'stream' });
    expect(ledger()).toEqual([]);
    expect(busyRun(ledger(), alive)).toBe(false);
  });

  it('упавший ход тоже снимается с журнала', () => {
    const run = new FakeRun();
    const service = new ProviderChatService(() => run);
    createChat(dir, 'codex', { id: 'chat' });
    service.send(dir, 'codex', 'chat', { text: 'Вопрос' }, { provider: PROVIDER });
    run.emit?.({ type: 'error', error: 'CLI не найден', reason: 'cli_error' });
    expect(ledger()).toEqual([]);
  });

  it('записи прошлого сервера выбрасываются, свои другие ходы остаются', () => {
    writeFileSync(
      join(dir, PROVIDER_TURN_LEDGER),
      JSON.stringify([
        { key: 'qwen:old', cwd: '', pid: 999_999, startedAt: 1 },
        { key: 'qwen:mine', cwd: '', pid: 42, startedAt: 2 },
      ]),
    );
    markProviderTurn(dir, 'codex:new', { cwd: 'x', startedAt: 3 }, 42);
    expect(ledger()).toEqual([
      { key: 'qwen:mine', cwd: '', pid: 42, startedAt: 2 },
      { key: 'codex:new', cwd: 'x', pid: 42, startedAt: 3 },
    ]);
    markProviderTurn(dir, 'qwen:mine', undefined, 42);
    expect(ledger()).toEqual([{ key: 'codex:new', cwd: 'x', pid: 42, startedAt: 3 }]);
  });
});
