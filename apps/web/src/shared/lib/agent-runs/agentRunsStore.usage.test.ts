import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    post: vi.fn(async () => ({ data: {} })),
    get: vi.fn(async () => ({ data: {} })),
  },
}));

import { agentRuns, getRun } from './agentRunsStore';

/**
 * Привязка расхода к действию.
 *
 * Расход приходит на ШАГ модели и обгоняет вызовы этого же шага: сервер шлёт
 * `usage` раньше, чем `tool`. Стор обязан свести их по id в любом порядке —
 * иначе цифра либо не появится вовсе, либо повиснет не на том действии. Шаг без
 * вызовов — это цена самого текста ответа, и она складывается по шагам: в ленте
 * текст склеен в один блок.
 */

/** Поток SSE из готовых кадров: отдаёт их разом и закрывается. */
function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(`${frame}\n\n`));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

const frame = (event: Record<string, unknown>, seq: number): string =>
  `data: ${JSON.stringify({ ...event, seq })}`;

const usageFrame = (toolIds: string[], seq: number, output = 200): string =>
  frame(
    {
      kind: 'usage',
      input: 100,
      output,
      cacheRead: 4000,
      cacheCreation: 50,
      model: 'claude-opus-4-8',
      costUsd: 0.012,
      toolIds,
    },
    seq,
  );

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
};

describe('agentRuns — расход по действиям', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    agentRuns.clear('c1');
  });

  /** Прогнать поток кадров через стор и вернуть итоговое состояние прогона. */
  async function run(frames: string[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse(frames)),
    );
    await agentRuns.start({ chatId: 'c1', prompt: 'посчитай' });
    await settle();
    return getRun('c1');
  }

  it('расход, пришедший раньше своего вызова, садится на него', async () => {
    const state = await run([
      usageFrame(['t1'], 1),
      frame({ kind: 'tool', name: 'Bash', input: { command: 'ls' }, id: 't1' }, 2),
    ]);

    expect(state.tools[0]?.usage?.output).toBe(200);
    expect(state.tools[0]?.usage?.costUsd).toBe(0.012);
  });

  it('расход, пришедший после своего вызова, дополняет уже показанное действие', async () => {
    const state = await run([
      frame({ kind: 'tool', name: 'Read', input: { file: 'a.ts' }, id: 't7' }, 1),
      usageFrame(['t7'], 2),
    ]);

    expect(state.tools[0]?.usage?.output).toBe(200);
  });

  it('параллельные вызовы одного шага получают ОБЩИЙ расход, а не долю каждый', async () => {
    // Раздельного счёта модель не даёт: делить 200 на три было бы выдумкой.
    const state = await run([
      usageFrame(['t1', 't2', 't3'], 1),
      frame({ kind: 'tool', name: 'Bash', input: {}, id: 't1' }, 2),
      frame({ kind: 'tool', name: 'Bash', input: {}, id: 't2' }, 3),
      frame({ kind: 'tool', name: 'Bash', input: {}, id: 't3' }, 4),
    ]);

    expect(state.tools.map((tool) => tool.usage?.output)).toEqual([200, 200, 200]);
  });

  it('чужой вызов расход не подхватывает', async () => {
    const state = await run([
      usageFrame(['t1'], 1),
      frame({ kind: 'tool', name: 'Bash', input: {}, id: 't1' }, 2),
      frame({ kind: 'tool', name: 'Grep', input: {}, id: 't2' }, 3),
    ]);

    expect(state.tools[0]?.usage).toBeDefined();
    expect(state.tools[1]?.usage).toBeUndefined();
  });

  it('шаги без вызовов — цена текста ответа, складывается по шагам', async () => {
    const state = await run([usageFrame([], 1, 30), usageFrame([], 2, 12)]);

    expect(state.textUsage?.output).toBe(42);
    expect(state.textUsage?.cacheRead).toBe(8000);
    expect(state.textUsage?.costUsd).toBeCloseTo(0.024, 6);
  });

  it('общий счётчик токенов прогона считает все шаги, включая безвызовные', async () => {
    const state = await run([
      usageFrame(['t1'], 1),
      frame({ kind: 'tool', name: 'Bash', input: {}, id: 't1' }, 2),
      usageFrame([], 3),
    ]);

    // Два шага по 100+200+4000+50.
    expect(state.tokens).toBe(8700);
  });
});
