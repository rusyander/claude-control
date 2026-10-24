import { describe, expect, it } from 'vitest';
import { ChatRunRegistry, type RunLike } from './ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from '../ChatRunner/ChatRunner.ts';

/**
 * R5 ревью П1: ход, который правило остывшей сессии увело в новый разговор,
 * человек возвращает в старую сессию кнопкой на заметке. Новый разговор
 * снимается, тот же старт идёт старой сессией без повторного решения правила.
 * Подменены процесс и само правило — решение о том, остыла ли сессия, проверено
 * в `cold-continuation.test.ts`.
 */

class FakeRun implements RunLike {
  pid = 4242;
  options?: RunOptions;
  stopped = 0;
  private resolve?: () => void;
  start(options: RunOptions, _onEvent: (event: ChatEvent) => void): Promise<void> {
    this.options = options;
    return new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }
  stop(): void {
    this.stopped += 1;
    this.resolve?.();
  }
  finish(): void {
    this.resolve?.();
  }
}

const COLD_NOTICE: ChatEvent = {
  kind: 'notice',
  code: 'coldResume',
  text: 'Ход пошёл новым разговором',
  textCode: 'chat-cold-resume-notice',
};

const turn: RunOptions = { prompt: 'Продолжи стадию', cwd: 'C:/copy', sessionId: 'old' };

function wired(policyCold = true) {
  const runs: FakeRun[] = [];
  const registry = new ChatRunRegistry(() => {
    const run = new FakeRun();
    runs.push(run);
    return run;
  });
  let decisions = 0;
  registry.setContinuationPolicy((_keys, options, meta) => {
    decisions += 1;
    if (!policyCold) return undefined;
    const { sessionId: _session, ...fresh } = options;
    const { sessionId: _metaSession, ...freshMeta } = meta;
    return {
      options: { ...fresh, prompt: `Вводная\n\n${options.prompt}` },
      meta: freshMeta,
      notice: COLD_NOTICE,
    };
  });
  return { registry, runs, decisions: () => decisions };
}

describe('ChatRunRegistry.keepColdSession — возврат в остывшую сессию', () => {
  it('новый разговор снят, тот же ход идёт старой сессией, правило не спрошено снова', () => {
    const { registry, runs, decisions } = wired();
    expect(registry.start('group-1', turn, { origin: 'groups', sessionId: 'old' })).toBe(true);
    expect(runs[0]?.options?.sessionId).toBeUndefined();
    expect(runs[0]?.options?.prompt).toBe('Вводная\n\nПродолжи стадию');

    expect(registry.keepColdSession('group-1')).toBe('started');
    expect(runs[0]?.stopped).toBe(1);
    expect(runs[1]?.options?.sessionId).toBe('old');
    expect(runs[1]?.options?.prompt).toBe('Продолжи стадию');
    expect(decisions()).toBe(1);
    expect(registry.isRunning('group-1')).toBe(true);
  });

  it('возвращённый ход второй раз не возвращается — в нём нечего возвращать', () => {
    const { registry } = wired();
    registry.start('group-1', turn, { origin: 'groups', sessionId: 'old' });
    registry.keepColdSession('group-1');
    expect(registry.keepColdSession('group-1')).toBe('not_cold');
  });

  it('следующее продолжение снова решает правило: отметка — на один старт', () => {
    const { registry, runs, decisions } = wired();
    registry.start('group-1', turn, { origin: 'groups', sessionId: 'old' });
    registry.keepColdSession('group-1');
    runs[1]?.finish();
    return Promise.resolve().then(() => {
      registry.start('group-1', turn, { origin: 'groups', sessionId: 'old' });
      expect(decisions()).toBe(2);
      expect(runs[2]?.options?.sessionId).toBeUndefined();
    });
  });

  it('ход, начатый не правилом остывшей сессии, — отказ; нет хода — отказ', () => {
    const warm = wired(false);
    warm.registry.start('group-1', turn, { origin: 'groups', sessionId: 'old' });
    expect(warm.registry.keepColdSession('group-1')).toBe('not_cold');
    expect(warm.runs[0]?.stopped).toBe(0);
    expect(wired().registry.keepColdSession('nobody')).toBe('absent');
  });

  it('законченный новый разговор не переигрывается старой сессией', async () => {
    const { registry, runs } = wired();
    registry.start('group-1', turn, { origin: 'groups', sessionId: 'old' });
    runs[0]?.finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.keepColdSession('group-1')).toBe('absent');
    expect(runs).toHaveLength(1);
  });
});
