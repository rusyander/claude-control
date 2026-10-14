import { describe, expect, it } from 'vitest';
import {
  ChatRunRegistry,
  MAX_BUFFERED_BYTES,
  MAX_BUFFERED_EVENTS,
  type BufferedEvent,
  type RunLike,
} from './ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from '../ChatRunner/ChatRunner.ts';

/**
 * Буфер кадров прогона не растёт без предела (L4b, п.7): ночной прогон льёт кадры часами.
 * Путь настоящий — прогон реестра, подписчик через `attach`, как у SSE-ответа; подменён
 * только процесс CLI.
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

function setup() {
  const fake = new FakeRun();
  const registry = new ChatRunRegistry(() => fake);
  registry.start('night', { prompt: 'задача', cwd: '/work' }, { projectPath: '/work' });
  return { fake, registry };
}

const text = (body: string): ChatEvent => ({ kind: 'text', text: body }) as ChatEvent;

/** Всё, что видит клиент, подключившийся с `fromSeq`. */
function replay(registry: ChatRunRegistry, fromSeq: number): BufferedEvent[] {
  const seen: BufferedEvent[] = [];
  registry.attach('night', fromSeq, { send: (frame) => void seen.push(frame), close: () => {} });
  return seen;
}

describe('буфер кадров прогона ограничен', () => {
  it('кадров больше предела — в буфере остаются последние, число не растёт', () => {
    const { fake, registry } = setup();
    const total = MAX_BUFFERED_EVENTS * 3;
    for (let i = 1; i <= total; i += 1) fake.emit(text(`кадр ${i}`));
    const seen = replay(registry, 0).filter((frame) => frame.event.kind === 'text');
    expect(seen.length).toBeLessThanOrEqual(MAX_BUFFERED_EVENTS);
    expect(seen.length).toBeGreaterThan(MAX_BUFFERED_EVENTS * 0.85);
    expect(seen.at(-1)?.seq).toBe(total);
    // Номера идут подряд без дыр внутри оставшегося.
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]?.seq).toBe((seen[i - 1]?.seq ?? 0) + 1);
    }
  });

  it('один тяжёлый кадр не выбрасывает себя: последний кадр остаётся всегда', () => {
    const { fake, registry } = setup();
    fake.emit(text('x'.repeat(MAX_BUFFERED_BYTES + 10)));
    const seen = replay(registry, 0).filter((frame) => frame.event.kind === 'text');
    expect(seen).toHaveLength(1);
  });

  it('объём: пачка в десятую часть предела мала — режется дальше, пока не станет ниже 90% предела', () => {
    const { fake, registry } = setup();
    // Много мелких кадров: пачка в 400 штук уходит целиком на них и объёма почти не снимает.
    for (let i = 0; i < 500; i += 1) fake.emit(text('м'));
    const heavy = 'x'.repeat(150_000);
    const bytesKept = (): number =>
      replay(registry, 0)
        .filter((frame) => frame.event.kind === 'text')
        .reduce((sum, frame) => sum + JSON.stringify(frame.event).length, 0);
    for (let i = 0; i < 40; i += 1) {
      fake.emit(text(heavy));
      // После КАЖДОГО кадра в буфере не больше предела, а не только в конце прогона.
      expect(bytesKept()).toBeLessThanOrEqual(MAX_BUFFERED_BYTES);
    }
  });

  it('объём: тяжёлые кадры вытесняют старые раньше, чем набирается число', () => {
    const { fake, registry } = setup();
    const heavy = 'я'.repeat(200_000);
    for (let i = 0; i < 40; i += 1) fake.emit(text(heavy));
    const seen = replay(registry, 0).filter((frame) => frame.event.kind === 'text');
    // Каждый кадр ~200 КБ: влезает не больше десятка, а не все сорок.
    expect(seen.length).toBeLessThan(25);
    expect(seen.at(-1)?.seq).toBe(40);
  });

  it('клиент с дырой получает сообщение о сброшенных кадрах, номер которого между его fromSeq и оставшимися', () => {
    const { fake, registry } = setup();
    for (let i = 1; i <= MAX_BUFFERED_EVENTS * 2; i += 1) fake.emit(text(`кадр ${i}`));
    const seen = replay(registry, 5);
    const first = seen[0];
    expect(first?.event).toMatchObject({ kind: 'notice', code: 'eventsTrimmed' });
    const kept = seen.slice(1);
    expect(first?.seq).toBeGreaterThan(5);
    expect(first?.seq).toBeLessThan(kept[0]?.seq ?? 0);
    expect(first?.seq).toBe((kept[0]?.seq ?? 0) - 1);
    // Число в тексте — сколько кадров клиент не увидит.
    const dropped = Number(
      (first?.event as { textParams?: { count?: string } }).textParams?.count ?? 0,
    );
    expect(dropped).toBe((first?.seq ?? 0) - 5);
  });

  it('клиент, который не отстал (fromSeq в пределах буфера), сообщения не получает', () => {
    const { fake, registry } = setup();
    for (let i = 1; i <= MAX_BUFFERED_EVENTS * 2; i += 1) fake.emit(text(`кадр ${i}`));
    const tail = MAX_BUFFERED_EVENTS * 2 - 10;
    const seen = replay(registry, tail);
    expect(seen.map((frame) => frame.seq)).toEqual(
      Array.from({ length: 10 }, (_, i) => tail + 1 + i),
    );
    expect(seen.some((frame) => frame.event.kind === 'notice')).toBe(false);
  });

  it('до предела буфер цел и сообщений нет — прежнее поведение', () => {
    const { fake, registry } = setup();
    for (let i = 1; i <= 50; i += 1) fake.emit(text(`кадр ${i}`));
    const seen = replay(registry, 0);
    expect(seen.map((frame) => frame.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});
