import type { PlatformGatewayEvent } from '@agentdeck/contracts';
import {
  HOP_STALL_CPU_MS as STALL_CPU_MS,
  HOP_STALL_GPU_MS as STALL_GPU_MS,
  type HopActivity,
} from '@agentdeck/contracts/core/hops';
import { describe, expect, it } from 'vitest';
import { localActivityOf, localOutcomeOf, withHopActivity } from './activity.ts';

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
      // Число, а не константа: справка обещает «2 мин у видеокарты», и ядро берёт тот же предел.
      stallMs: 120_000,
    });
  });

  it('сервер на процессоре молчит законно дольше: предел тишины 600 с', () => {
    const snapshot = localActivityOf({
      server: () => ({ model: 'm', context: 8_192, device: 'cpu' }),
      events: () => undefined,
    });
    expect(snapshot.stallMs).toBe(600_000);
  });
});

/** Ход маршрута в той форме, в какой его отдаёт лента звена ядра (`HopActivity`). */
function hop(over: Partial<HopActivity> = {}): HopActivity {
  return {
    route: 'local:own',
    model: 'stub',
    phase: 'prompt',
    inFlight: 1,
    startedAt: 1_000,
    prompt: { filled: 2048, total: 4096 },
    decoded: 0,
    lastMoveAt: 2_000,
    stalled: false,
    ...over,
  };
}

describe('ход локальной модели по ленте звена ядра (этап 11, W2-5)', () => {
  const base = { model: 'qwen', context: 8_192, stallMs: STALL_GPU_MS };

  it('этап, разбор промпта и токены ответа берутся из ленты; сервер — из записи панели', () => {
    const view = withHopActivity(base, { routes: [hop()] }, 3_000);
    expect(view).toEqual({
      model: 'qwen',
      context: 8_192,
      phase: 'prompt',
      inFlight: 1,
      startedAt: 1_000,
      prompt: { filled: 2048, total: 4096 },
      decoded: 0,
      lastMoveAt: 2_000,
      stalled: false,
      stallMs: STALL_GPU_MS,
    });
  });

  it('из маршрутов берётся тот, где запрос в полёте, а не самый свежий простаивающий', () => {
    const idle = hop({ route: 'gateway:local-ollama', phase: 'idle', inFlight: 0, lastMoveAt: 9 });
    const busy = hop({ phase: 'generating', decoded: 10, lastMoveAt: 5 });
    const view = withHopActivity(base, { routes: [idle, busy] }, 6);
    expect(view).toMatchObject({ phase: 'generating', decoded: 10, inFlight: 1 });
  });

  it('два маршрута в полёте — берётся тот, чьё движение свежее; в полёте никого — последний', () => {
    const older = hop({
      route: 'local:own',
      phase: 'prompt',
      prompt: { filled: 64 },
      lastMoveAt: 3,
    });
    const fresher = hop({
      route: 'local:own:panel',
      phase: 'generating',
      decoded: 7,
      lastMoveAt: 8,
    });
    expect(withHopActivity(base, { routes: [fresher, older] }, 9)).toMatchObject({
      phase: 'generating',
      decoded: 7,
    });
    expect(withHopActivity(base, { routes: [older, fresher] }, 9).phase).toBe('generating');
    const closedA = hop({ route: 'local:own', phase: 'idle', inFlight: 0, lastMoveAt: 4 });
    const closedB = hop({ route: 'local:own:panel', phase: 'idle', inFlight: 0, lastMoveAt: 11 });
    expect(withHopActivity(base, { routes: [closedB, closedA] }, 12).lastMoveAt).toBe(11);
  });

  it('застой пересчитан по устройству: 200 с тишины — застой у видеокарты, не у процессора', () => {
    const quiet = { routes: [hop({ lastMoveAt: 0, stalled: true })] };
    expect(withHopActivity(base, quiet, 200_000).stalled).toBe(true);
    const cpu = { ...base, stallMs: STALL_CPU_MS };
    expect(withHopActivity(cpu, quiet, 200_000).stalled).toBe(false);
    expect(withHopActivity(cpu, quiet, 600_000).stalled).toBe(true);
    const loading = { routes: [hop({ phase: 'loading', lastMoveAt: 0 })] };
    expect(withHopActivity(base, loading, 900_000).stalled).toBe(false);
  });

  it('тело ядра не той формы или пустое — хода нет, ответ прежний', () => {
    expect(withHopActivity(base, { routes: [] }, 1)).toEqual(base);
    expect(withHopActivity(base, { routes: [{ route: 'x' }] }, 1)).toEqual(base);
    expect(withHopActivity(base, { error: 'core-absent' }, 1)).toEqual(base);
    expect(withHopActivity(base, undefined, 1)).toEqual(base);
  });
});
