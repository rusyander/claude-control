import { describe, it, expect, beforeEach } from 'vitest';
import {
  ChatRunRegistry,
  type RunLike,
  type BufferedEvent,
  type RunSubscriber,
} from './ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from './ChatRunner.ts';

/**
 * Цена шага в живом потоке.
 *
 * Реестр считает расход, но тарифов не знает: их приносит слой маршрутов
 * функцией. Ключевое — событие `usage` уходит слушателю уже с ценой, шаг без
 * модели остаётся без неё (считать не по чему), а сам счётчик токенов от этого
 * не меняется. Без цены разбивка бесполезна: по объёму дешёвый шаг от дорогого
 * не отличить, чтение кэша стоит на порядок меньше свежего входа.
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
}

const OPTIONS: RunOptions = { prompt: 'привет', cwd: 'C:/work/app' };

describe('ChatRunRegistry — цена шага', () => {
  let fake: FakeRun;
  let registry: ChatRunRegistry;
  let events: BufferedEvent[];
  let subscriber: RunSubscriber;

  beforeEach(() => {
    fake = new FakeRun();
    registry = new ChatRunRegistry(() => fake);
    events = [];
    subscriber = { send: (buffered) => events.push(buffered), close: () => undefined };
  });

  const usage = (model?: string): ChatEvent => ({
    kind: 'usage',
    input: 100,
    output: 200,
    cacheRead: 4000,
    cacheCreation: 50,
    model,
    toolIds: ['t1'],
  });

  const sent = (): Extract<ChatEvent, { kind: 'usage' }> | undefined =>
    events.map((buffered) => buffered.event).find((event) => event.kind === 'usage');

  it('оценщик задан и модель известна — событие уходит с ценой', () => {
    registry.setCostEstimator((model, tokens) => (model === 'opus' ? tokens.output / 1000 : 0));
    registry.start('c1', OPTIONS, {});
    registry.attach('c1', 0, subscriber);

    fake.emit(usage('opus'));

    expect(sent()?.costUsd).toBe(0.2);
  });

  it('модель шага неизвестна — цены нет, выдумывать её нечем', () => {
    registry.setCostEstimator(() => 0.5);
    registry.start('c1', OPTIONS, {});
    registry.attach('c1', 0, subscriber);

    fake.emit(usage(undefined));

    expect(sent()?.costUsd).toBeUndefined();
  });

  it('оценщик не задан — событие проходит как есть, счётчик токенов работает', () => {
    registry.start('c1', OPTIONS, {});
    registry.attach('c1', 0, subscriber);

    fake.emit(usage('opus'));

    expect(sent()?.costUsd).toBeUndefined();
    expect(registry.spend().tokens).toBe(4350);
  });

  it('вызовы шага доезжают до слушателя — по ним цифра садится на своё действие', () => {
    registry.start('c1', OPTIONS, {});
    registry.attach('c1', 0, subscriber);

    fake.emit(usage('opus'));

    expect(sent()?.toolIds).toEqual(['t1']);
  });
});
