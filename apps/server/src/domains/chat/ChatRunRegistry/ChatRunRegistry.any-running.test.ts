import { describe, expect, it } from 'vitest';
import { ChatRunRegistry, type RunLike } from './ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from '../ChatRunner/ChatRunner.ts';

/**
 * «Идёт ли прогон на локальной модели» (L4b): по этому ответу панель держит ОС
 * бодрствующей и откладывает перезапуск сервера. Прогон настоящий, процесс подменён.
 */

class FakeRun implements RunLike {
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

const LOCAL_URL = 'http://127.0.0.1:5178/local-ollama';
const isLocal = (run: { options: RunOptions }): boolean =>
  (run.options.platformEnv?.ANTHROPIC_BASE_URL ?? '').includes('/local-ollama');

describe('ChatRunRegistry.anyRunning', () => {
  it('локальный прогон идёт — да; закончился — нет', async () => {
    const run = new FakeRun();
    const registry = new ChatRunRegistry(() => run);
    registry.setPlatformRouting((origin) => ({
      env: origin === 'chat' ? ({ ANTHROPIC_BASE_URL: LOCAL_URL } as Record<string, string>) : {},
    }));
    expect(registry.anyRunning(isLocal)).toBe(false);
    registry.start('night', { prompt: 'задача', cwd: '/work' }, { origin: 'chat' });
    expect(registry.anyRunning(isLocal)).toBe(true);
    run.finish();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(registry.anyRunning(isLocal)).toBe(false);
  });

  it('облачный прогон под условие не подходит', () => {
    const registry = new ChatRunRegistry(() => new FakeRun());
    registry.setPlatformRouting(() => ({ env: {} }));
    registry.start('cloud', { prompt: 'задача', cwd: '/work' }, {});
    expect(registry.anyRunning(isLocal)).toBe(false);
    expect(registry.anyRunning(() => true)).toBe(true);
  });

  it('условие видит метку запуска: фоновый наблюдатель не считается чатом', () => {
    const registry = new ChatRunRegistry(() => new FakeRun());
    registry.start('w', { prompt: 'x', cwd: '/work' }, { origin: 'groups' });
    expect(registry.anyRunning((run) => (run.meta.origin ?? 'chat') === 'chat')).toBe(false);
    expect(registry.anyRunning((run) => run.meta.origin === 'groups')).toBe(true);
  });
});
