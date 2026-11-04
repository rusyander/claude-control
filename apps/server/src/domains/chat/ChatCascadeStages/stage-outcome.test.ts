import { describe, it, expect, afterEach } from 'vitest';
import {
  ChatRunRegistry,
  type RunFinished,
  type RunLike,
} from '../ChatRunRegistry/ChatRunRegistry.ts';
import type { ChatEvent } from '../chat-events.ts';

/**
 * Итог хода (группа 1, 25.10, F4): текст после последнего инструмента, без
 * пересказа по ходу работы между вызовами. Задание следующего звена из него
 * панель больше не собирает (планировщик звеньев уехал в ядро, этап 10), но
 * реестр прогонов по-прежнему отдаёт итог в `RunFinished.answer`.
 */

/** Управляемый прогон: события шлёт тест, конец — тоже. */
type RunOptions = Parameters<RunLike['start']>[0];

class FakeRun implements RunLike {
  private onEvent?: (event: ChatEvent) => void;
  private resolve?: () => void;
  start(_options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    return new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }
  stop(): void {
    this.resolve?.();
  }
  emit(event: ChatEvent): void {
    this.onEvent?.(event);
  }
  finish(): void {
    this.resolve?.();
  }
}

describe('реестр прогонов: итог хода — текст после последнего инструмента', () => {
  let registry: ChatRunRegistry | undefined;
  afterEach(() => registry?.stopAll());

  it('проза между вызовами в итог не входит, весь хвост — в `text`', async () => {
    const fake = new FakeRun();
    registry = new ChatRunRegistry(() => fake);
    let finished: RunFinished | undefined;
    registry.setHandoffPlanner((done) => {
      finished = done;
      return undefined;
    });
    registry.start('chat-1', { prompt: 'работа', cwd: 'C:/repo' }, { projectPath: 'C:/repo' });
    fake.emit({ kind: 'text', text: 'ПРОЗА-ХОДА 1' } as ChatEvent);
    fake.emit({ kind: 'tool', name: 'Read', input: { file_path: 'a.ts' }, id: 't1' } as ChatEvent);
    fake.emit({ kind: 'text', text: 'ПРОЗА-ХОДА 2' } as ChatEvent);
    fake.emit({ kind: 'tool', name: 'Edit', input: { file_path: 'a.ts' }, id: 't2' } as ChatEvent);
    fake.emit({ kind: 'text', text: 'ИТОГ-ЗВЕНА ' } as ChatEvent);
    fake.emit({ kind: 'text', text: 'готово' } as ChatEvent);
    fake.finish();
    await new Promise((done) => setTimeout(done, 20));

    expect(finished?.answer).toBe('ИТОГ-ЗВЕНА готово');
    expect(finished?.text).toContain('ПРОЗА-ХОДА 1');
  });
});
