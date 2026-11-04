import type { PlatformGatewayEvent } from '@agentdeck/contracts';
import { describe, expect, it } from 'vitest';
import { localActivityOf, localOutcomeOf } from './activity.ts';

/**
 * Память отказа сервера моделей (L6) по книге контуров ядра: события — в той форме, в какой их
 * пишет шлюз ядра (`contourEvent`, `apps/core/src/hop-host/contour-book/record.ts`).
 */

function event(at: number, status: number, over: Partial<PlatformGatewayEvent> = {}) {
  return {
    at: new Date(at).toISOString(),
    platformId: 'local-ollama',
    path: '/v1/messages',
    dialect: 'anthropic-messages',
    status,
    stages: [],
    summarized: false,
    violations: [],
    masked: false,
    blocked: false,
    interrupted: false,
    unknownFrames: [],
    lost: [],
    shimmed: [],
    toolCalls: 0,
    contourCalls: 0,
    toolFlaws: [],
    claimedWithoutCall: false,
    totalTokens: 0,
    ...over,
  } as PlatformGatewayEvent;
}

const TEMPLATE_500 = 'Нет связи… Value is not callable: null at row 61, column 25';

describe('память отказа локальной модели по книге ядра (L6)', () => {
  it('сервер ответил 500 — чат видит код и текст; время запроса выставлено', () => {
    const outcome = localOutcomeOf([event(5_000, 500, { error: TEMPLATE_500 })]);
    expect(outcome).toEqual({
      lastRequestAt: 5_000,
      lastError: { at: 5_000, status: 500, message: TEMPLATE_500 },
    });
  });

  it('удачный ответ после отказа стирает его', () => {
    const outcome = localOutcomeOf([event(5_000, 500, { error: TEMPLATE_500 }), event(6_000, 200)]);
    expect(outcome.lastError).toBeUndefined();
    expect(outcome.lastRequestAt).toBe(6_000);
  });

  it('порядок в книге не важен: судит самое позднее событие', () => {
    const outcome = localOutcomeOf([event(6_000, 200), event(5_000, 500, { error: 'x' })]);
    expect(outcome.lastError).toBeUndefined();
  });

  it('503 «Loading model» — загрузка, а не отказ; 499 — ушёл клиент', () => {
    expect(
      localOutcomeOf([event(5_000, 503, { error: 'Loading model' })]).lastError,
    ).toBeUndefined();
    expect(localOutcomeOf([event(5_000, 499, { error: 'gone' })]).lastError).toBeUndefined();
  });

  it('отказ без текста называет код; длинный текст укорочен до 300 знаков', () => {
    expect(localOutcomeOf([event(5_000, 502)]).lastError?.message).toBe('HTTP 502');
    const long = localOutcomeOf([event(5_000, 500, { error: 'x'.repeat(1_000) })]);
    expect(long.lastError?.message).toHaveLength(300);
  });

  it('события других контуров не судят локальную модель', () => {
    const outcome = localOutcomeOf([
      event(5_000, 500, { platformId: 'enterprise-platform', error: 'boom' }),
    ]);
    expect(outcome).toEqual({});
  });

  it('ядро молчит — ни отказа, ни времени; снимок несёт только сервер', () => {
    const snapshot = localActivityOf({
      server: () => ({ model: 'qwen3.6:27b-coding', quant: 'UD-Q4_K_XL', context: 131_072 }),
      events: () => undefined,
    });
    expect(snapshot).toEqual({
      model: 'qwen3.6:27b-coding',
      quant: 'UD-Q4_K_XL',
      context: 131_072,
    });
  });
});
