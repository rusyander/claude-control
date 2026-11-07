import { describe, it, expect } from 'vitest';
import { ChatRunRegistry, type RunLike } from './ChatRunRegistry.ts';
import type { RunOptions } from '../run-options/run-options.ts';
import type { ChatEvent } from '../chat-events.ts';

/**
 * Слово «на ходу» в чате на ядре начинает следующий ход ТОГО ЖЕ прогона (событие `nextTurn`).
 * Итог прогона, который читают уведомление и планировщик конца, — ответ ПОСЛЕДНЕГО хода, а хвост
 * текста разделяет ходы абзацем. Без этого два ответа склеивались в «готовготов» (core-chat-012).
 * Реестр настоящий, планировщик — настоящий вход `setHandoffPlanner`; подменён только сам прогон.
 */

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

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const OPTIONS: RunOptions = { prompt: 'сделай', cwd: '/tmp/x' };

describe('ChatRunRegistry — граница хода внутри прогона', () => {
  it('итог — ответ последнего хода, хвост разделяет ходы абзацем', async () => {
    const fake = new FakeRun();
    const registry = new ChatRunRegistry(() => fake);
    const seen: { text: string; answer?: string }[] = [];
    registry.setHandoffPlanner((finished) => {
      seen.push({ text: finished.text, ...(finished.answer ? { answer: finished.answer } : {}) });
      return undefined;
    });

    registry.start('c-next', OPTIONS, {});
    fake.emit({ kind: 'session', sessionId: 'sess-1', model: 'm', tools: 1 });
    fake.emit({ kind: 'text', text: 'готов' });
    fake.emit({ kind: 'nextTurn', prompt: 'и ещё тесты', at: 1_000 });
    fake.emit({ kind: 'text', text: 'тесты готовы' });
    fake.finish();
    await flush();

    expect(seen).toEqual([{ text: 'готов\n\nтесты готовы', answer: 'тесты готовы' }]);
  });

  it('хвост уже кончается абзацем — второй абзац не добавляется', async () => {
    const fake = new FakeRun();
    const registry = new ChatRunRegistry(() => fake);
    const seen: string[] = [];
    registry.setHandoffPlanner((finished) => {
      seen.push(finished.text);
      return undefined;
    });

    registry.start('c-next-2', OPTIONS, {});
    fake.emit({ kind: 'text', text: 'готов\n\n' });
    fake.emit({ kind: 'nextTurn', prompt: 'дальше', at: 2_000 });
    fake.emit({ kind: 'text', text: 'ещё' });
    fake.finish();
    await flush();

    expect(seen).toEqual(['готов\n\nещё']);
  });
});
