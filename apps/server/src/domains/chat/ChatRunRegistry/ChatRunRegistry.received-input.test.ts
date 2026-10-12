import { describe, it, expect } from 'vitest';
import type { RunInputRecord } from '@agentdeck/contracts/run-input';
import { ChatRunRegistry, type RunLike } from './ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from '../ChatRunner/ChatRunner.ts';

/**
 * Реестр пишет «что получил агент» (U8) из ТЕХ ЖЕ параметров, с которыми
 * стартует процесс: после маршрута контура и сводки детей. Фейковый прогон
 * запоминает свои параметры — запись сверяется с ними, а не с ожиданием.
 */
class CapturingRun implements RunLike {
  options?: RunOptions;

  start(options: RunOptions, _onEvent: (event: ChatEvent) => void): Promise<void> {
    this.options = options;
    return new Promise<void>(() => undefined);
  }

  stop(): void {}
}

describe('ChatRunRegistry: «что получил агент»', () => {
  it('запись — из параметров запуска: сводка детей и модель контура в ней есть', () => {
    const run = new CapturingRun();
    const registry = new ChatRunRegistry(() => run);
    registry.setChildrenBriefResolver(() => 'Сводка детей: группа 1 на ревью.');
    registry.setPlatformRouting(() => ({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' },
      model: { model: 'contour-model', asked: 'opus', source: 'asked', replaced: true },
      systemPrompt: 'Промпт контура',
    }));
    const written: Array<{ keys: readonly string[]; record: RunInputRecord }> = [];
    registry.setInputJournal((keys, record) => void written.push({ keys, record }));

    registry.start(
      'c1',
      { prompt: 'Слова человека', cwd: '/tmp/x', model: 'opus' },
      {
        sessionId: 'sess-1',
      },
    );

    expect(written).toHaveLength(1);
    expect(written[0]?.keys).toEqual(['c1', 'sess-1']);
    expect(written[0]?.record.prompt).toBe(run.options?.prompt);
    expect(written[0]?.record.prompt).toContain('Сводка детей: группа 1 на ревью.');
    expect(written[0]?.record.prompt).toContain('Слова человека');
    expect(written[0]?.record.model).toBe('contour-model');
    expect(written[0]?.record.systemPrompt).toBe('Промпт контура');
  });

  it('отказ контура — прогон ничего не получил, записи нет', () => {
    const registry = new ChatRunRegistry(() => new CapturingRun());
    registry.setPlatformRouting(() => ({ env: {}, refusal: 'Контур обязателен' }));
    const written: unknown[] = [];
    registry.setInputJournal((_keys, record) => void written.push(record));

    registry.start('r1', { prompt: 'p', cwd: '/tmp/x' }, {});

    expect(written).toEqual([]);
  });

  it('сбой записи старт не срывает', () => {
    const run = new CapturingRun();
    const registry = new ChatRunRegistry(() => run);
    registry.setInputJournal(() => {
      throw new Error('диск полон');
    });

    expect(registry.start('c1', { prompt: 'p', cwd: '/tmp/x' }, {})).toBe(true);
    expect(run.options?.prompt).toBe('p');
  });
});
