import { describe, expect, it } from 'vitest';
import {
  ChatRunRegistry,
  type RunFinished,
  type RunLedgerSink,
  type RunLike,
} from './ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from '../ChatRunner/ChatRunner.ts';
import type { RunLedgerEntry } from '../run-ledger/run-ledger.ts';

/**
 * Прогон на локальной модели, усыновлённый после перезапуска панели (L4c, F1): адрес
 * контура живёт в опциях запуска, а журнал их не хранит — без отдельной отметки усыновлённый
 * ночной прогон переставал считаться локальным (сон разрешён, настройка применяется посреди
 * задачи, обрыв не продолжается). Путь настоящий: запись в журнал из прогона одного реестра,
 * усыновление в другом; подменён только процесс.
 */

class FakeRun implements RunLike {
  pid = 4242;
  private resolve?: () => void;
  start(_options: RunOptions, _onEvent: (event: ChatEvent) => void): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }
  stop(): void {
    this.resolve?.();
  }
  finish(): void {
    this.resolve?.();
  }
}

class FakeLedger implements RunLedgerSink {
  readonly entries = new Map<string, RunLedgerEntry>();
  read(): RunLedgerEntry[] {
    return [...this.entries.values()];
  }
  upsert(entry: RunLedgerEntry): void {
    this.entries.set(entry.key, entry);
  }
  remove(key: string): void {
    this.entries.delete(key);
  }
}

const LOCAL_URL = 'http://127.0.0.1:5178/local-ollama';
const isLocalOptions = (options: RunOptions): boolean =>
  (options.platformEnv?.ANTHROPIC_BASE_URL ?? '').includes('/local-ollama');

/** Реестр прошлой жизни панели: ночной прогон идёт на локальной модели. */
function firstLife(ledger: FakeLedger, local: boolean): ChatRunRegistry {
  const registry = new ChatRunRegistry(() => new FakeRun());
  registry.setLedger(ledger, undefined, async (pid) => pid);
  registry.setLocalClassifier((options) => isLocalOptions(options));
  registry.setPlatformRouting(() => ({
    env: local ? ({ ANTHROPIC_BASE_URL: LOCAL_URL } as Record<string, string>) : {},
  }));
  registry.start('night', { prompt: 'задача', cwd: '/work' }, { origin: 'chat' });
  return registry;
}

/** Новая жизнь панели: тот же журнал, прогон усыновляется (процесс жив, трубы нет). */
function secondLife(ledger: FakeLedger): ChatRunRegistry {
  const registry = new ChatRunRegistry(() => new FakeRun());
  registry.setLedger(ledger, undefined, async (pid) => pid);
  registry.setLocalClassifier((options) => isLocalOptions(options));
  const entry = ledger.read()[0];
  if (!entry) throw new Error('журнал пуст');
  registry.adopt(entry, { isAlive: () => true, kill: () => undefined, pollMs: 20 });
  return registry;
}

describe('усыновлённый локальный прогон остаётся локальным', () => {
  it('запись в журнале несёт отметку, усыновлённый прогон виден условию «локальный»', () => {
    const ledger = new FakeLedger();
    firstLife(ledger, true);
    expect(ledger.entries.get('night')?.local).toBe(true);

    const adopted = secondLife(ledger);
    expect(adopted.anyRunning((run) => run.meta.local === true)).toBe(true);
    // Опции усыновлённого прогона адреса контура не несут — отметка единственная.
    expect(adopted.anyRunning((run) => isLocalOptions(run.options))).toBe(false);
  });

  it('продолжение старой локальной метки на облачном маршруте не наследует: отметка решается заново на каждом старте', () => {
    const registry = new ChatRunRegistry(() => new FakeRun());
    registry.setLocalClassifier((options) => isLocalOptions(options));
    registry.setPlatformRouting(() => ({ env: {} }));
    registry.start('chat', { prompt: 'x', cwd: '/work' }, { origin: 'chat', local: true });
    expect(registry.anyRunning((run) => run.meta.local === true)).toBe(false);
  });

  it('облачный прогон отметки не получает и после усыновления не становится локальным', () => {
    const ledger = new FakeLedger();
    firstLife(ledger, false);
    expect(ledger.entries.get('night')).not.toHaveProperty('local');
    const adopted = secondLife(ledger);
    expect(adopted.anyRunning((run) => run.meta.local === true)).toBe(false);
  });

  it('усыновлённый прогон кончился сбоем — планировщик видит его как локальный', async () => {
    const ledger = new FakeLedger();
    firstLife(ledger, true);
    let alive = true;
    const registry = new ChatRunRegistry(() => new FakeRun());
    registry.setLedger(ledger, undefined, async (pid) => pid);
    const seen: RunFinished[] = [];
    registry.setHandoffPlanner((finished) => {
      seen.push(finished);
      return undefined;
    });
    const entry = ledger.read()[0];
    if (!entry) throw new Error('журнал пуст');
    registry.adopt(entry, { isAlive: () => alive, kill: () => undefined, pollMs: 10 });
    alive = false;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.local).toBe(true);
  });
});
