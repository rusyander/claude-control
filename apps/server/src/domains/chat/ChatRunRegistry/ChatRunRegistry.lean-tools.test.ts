import type { RunOptions } from '../run-options/run-options.ts';
import { describe, it, expect } from 'vitest';
import { ChatRunRegistry, type RunLike } from './ChatRunRegistry.ts';
import type { ChatEvent } from '../chat-events.ts';

/**
 * Настройка «без тяжёлых схем» (`chatLeanTools`) в реестре прогонов: снятые инструменты
 * спрашиваются на каждом старте. Перенесено из `ChatRunRegistry.autonomy.test.ts`, когда
 * автономия чата ушла в архив (02.11.2026), — сама настройка жива.
 */
class FakeRun implements RunLike {
  private resolve?: () => void;
  options?: RunOptions;

  start(options: RunOptions, _onEvent: (event: ChatEvent) => void): Promise<void> {
    this.options = options;
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

const OPTIONS: RunOptions = { prompt: 'привет', cwd: '/tmp/x' };

describe('ChatRunRegistry — снятые тяжёлые схемы (chatLeanTools)', () => {
  it('настройка читается на каждом старте: снятая галочка возвращает инструменты следующему ходу', () => {
    const runs: FakeRun[] = [];
    const registry = new ChatRunRegistry(() => {
      const run = new FakeRun();
      runs.push(run);
      return run;
    });
    let lean = true;
    registry.setDeniedToolsResolver(() => (lean ? ['Artifact', 'Workflow'] : []));
    registry.start('c1', OPTIONS, {});
    expect(runs[0]?.options?.deniedTools).toEqual(['Artifact', 'Workflow']);
    runs[0]?.finish();

    lean = false;
    registry.start('c2', { ...OPTIONS, deniedTools: ['Artifact'] }, {});
    expect(runs[1]?.options?.deniedTools).toEqual([]);
  });
});
