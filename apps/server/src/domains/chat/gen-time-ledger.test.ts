import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatRunRegistry, type RunLike } from './ChatRunRegistry.ts';
import type { ChatEvent, RawEvent, RunOptions } from './ChatRunner.ts';
import { TurnTracker } from './stream-usage.ts';
import { readChatMessages } from './ChatHistory.ts';
import { genTimeSink, genTimesById } from './gen-time-ledger.ts';

/**
 * Скорость ответа переживает конец хода (живой прогон 08.10: ток/с были видны,
 * пока ответ шёл, и пропадали, как только лента перечитала транскрипт).
 *
 * Цепочка целиком: поток модели → трекер ходов → реестр прогонов → журнал на
 * диске → лента из транскрипта. Подменён только процесс CLI: его строки потока
 * подаются в реестр как есть.
 */
class FakeRun implements RunLike {
  private onEvent?: (event: ChatEvent) => void;
  start(_options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    return new Promise<void>(() => undefined);
  }
  stop(): void {}
  emit(event: ChatEvent): void {
    this.onEvent?.(event);
  }
}

const raw = (value: unknown): RawEvent => value as RawEvent;

/** Один ход модели: старт, дельта текста, конец — часы сдвигаются между строками. */
function turnLines(id: string, model: string): RawEvent[] {
  return [
    raw({ type: 'stream_event', event: { type: 'message_start', message: { id, model } } }),
    raw({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '391' } },
    }),
    raw({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 40 } } }),
  ];
}

describe('журнал времени генерации: от потока до ленты', () => {
  let appData: string;
  let projectsDir: string;
  let fake: FakeRun;
  let registry: ChatRunRegistry;

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'cc-gen-times-data-'));
    projectsDir = mkdtempSync(join(tmpdir(), 'cc-gen-times-proj-'));
    fake = new FakeRun();
    registry = new ChatRunRegistry(() => fake);
    registry.setGenTimeSink(genTimeSink(appData));
    registry.start('c1', { prompt: 'p', cwd: 'C:/work/app' }, {});
  });
  afterEach(() => {
    rmSync(appData, { recursive: true, force: true });
    rmSync(projectsDir, { recursive: true, force: true });
  });

  /** Прогнать ход через трекер (часы +250 мс на строку) и реестр. */
  function play(id: string, model: string): void {
    let clock = 0;
    const tracker = new TurnTracker(() => (clock += 250));
    for (const line of turnLines(id, model)) {
      for (const event of tracker.track(line)) fake.emit(event);
    }
  }

  function transcript(id: string, model: string): void {
    const dir = join(projectsDir, 'proj');
    mkdirSync(dir, { recursive: true });
    const records = [
      { type: 'user', uuid: 'u0', message: { role: 'user', content: '17*23?' } },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-10-08T10:00:00.000Z',
        message: {
          id,
          model,
          role: 'assistant',
          content: [{ type: 'text', text: '391' }],
          usage: { input_tokens: 20, output_tokens: 40 },
        },
      },
    ];
    writeFileSync(join(dir, 's.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  }

  it('локальная модель: законченный ответ в ленте несёт время генерации своего хода', async () => {
    play('msg_qwen_1', 'qwen3.6:27b-coding');
    transcript('msg_qwen_1', 'qwen3.6:27b-coding');

    const page = await readChatMessages(projectsDir, 's', { genTimes: genTimesById(appData) });
    const answer = page.messages.find((message) => message.id === 'a1');
    // Дельта на 2-й строке, конец хода на 3-й: 250 мс генерации.
    expect(answer?.usage?.genMs).toBe(250);
    // Журнал лежит на диске — переживает перезапуск панели: свежий модуль без
    // кэша в памяти читает время из файла.
    vi.resetModules();
    const cold = await import('./gen-time-ledger.ts');
    expect(cold.genTimesById(appData).get('msg_qwen_1')).toBe(250);
  });

  it('облачный Claude в журнал не пишется — скорость ему не показывается', () => {
    play('msg_claude_1', 'claude-opus-5-5');
    expect(existsSync(join(appData, 'chat-gen-times.json'))).toBe(false);
  });

  it('чужой ответ времени не получает: привязка только по id', async () => {
    play('msg_qwen_1', 'qwen3.6:27b-coding');
    transcript('msg_qwen_2', 'qwen3.6:27b-coding');

    const page = await readChatMessages(projectsDir, 's', { genTimes: genTimesById(appData) });
    expect(page.messages.find((message) => message.id === 'a1')?.usage).not.toHaveProperty('genMs');
  });
});
