import { describe, expect, it } from 'vitest';
import type { Health, SlotState } from './llama-client.ts';
import { createActivityWatch } from './activity.ts';

/** Сервер-заглушка: что ответят `/health` и `/slots` на очередном шаге опроса. */
function harness(stallMs = 10_000) {
  let clock = 1_000;
  let health: Health | undefined = 'ok';
  let slot: SlotState | undefined = { processing: false, filled: 0, decoded: 0 };
  let wedged = 0;
  /** `/slots` не отвечает (очередь задач сервера стоит): опрос отказывает по сроку. */
  let slotFails = false;
  const watch = createActivityWatch({
    health: () => Promise.resolve(health),
    slot: () =>
      slotFails
        ? Promise.reject(new Error('The operation was aborted due to timeout'))
        : Promise.resolve(slot),
    server: () => ({
      model: 'qwen3.6:27b-coding',
      quant: 'UD-Q4_K_XL',
      context: 131_072,
      device: 'gpu',
    }),
    onWedged: () => {
      wedged += 1;
    },
    stallText: (seconds) => `stalled ${seconds}`,
    now: () => clock,
    intervalMs: 60_000_000,
    stallMs: () => stallMs,
  });
  return {
    watch,
    advance: (ms: number) => {
      clock += ms;
    },
    setHealth: (value: Health | undefined) => {
      health = value;
    },
    setSlot: (value: SlotState | undefined) => {
      slot = value;
    },
    wedged: () => wedged,
    failSlots: (value: boolean) => {
      slotFails = value;
    },
  };
}

describe('присмотр за запросом к локальной модели (L6)', () => {
  it('разбор промпта движется — этап «prompt» с заполнением, запрос не рвётся сколько бы ни шёл', async () => {
    const h = harness();
    const track = h.watch.track(90_000);
    for (let filled = 2_048; filled <= 40_960; filled += 2_048) {
      h.setSlot({ processing: true, filled, decoded: 0 });
      h.advance(9_000);
      await h.watch.tick();
    }
    expect(track.signal.aborted).toBe(false);
    expect(h.watch.snapshot()).toMatchObject({
      phase: 'prompt',
      promptTokens: 90_000,
      filled: 40_960,
      model: 'qwen3.6:27b-coding',
      quant: 'UD-Q4_K_XL',
      context: 131_072,
      inFlight: 1,
    });
    h.setSlot({ processing: true, filled: 90_010, decoded: 12 });
    await h.watch.tick();
    expect(h.watch.snapshot()).toMatchObject({ phase: 'generating', decoded: 12 });
    track.done();
    expect(h.watch.snapshot()).toMatchObject({ phase: 'idle', inFlight: 0 });
  });

  it('слот застыл посреди разбора при живом /health — обрыв с текстом и перезапуск сервера', async () => {
    const h = harness();
    const track = h.watch.track(60_000);
    h.setSlot({ processing: true, filled: 8_192, decoded: 0 });
    await h.watch.tick();
    h.advance(9_999);
    await h.watch.tick();
    expect(track.signal.aborted).toBe(false);
    expect(h.watch.snapshot().silentMs).toBe(9_999);
    h.advance(1);
    await h.watch.tick();
    expect(track.signal.aborted).toBe(true);
    expect((track.signal.reason as Error).message).toBe('stalled 10');
    expect(h.wedged()).toBe(1);
    expect(h.watch.snapshot()).toMatchObject({ phase: 'idle', lastStall: { seconds: 10 } });
  });

  it('запрос не взят слотом и ничего не движется — обрыв без перезапуска сервера', async () => {
    const h = harness();
    const track = h.watch.track(1_000);
    await h.watch.tick();
    h.advance(10_000);
    await h.watch.tick();
    expect(track.signal.aborted).toBe(true);
    expect(h.wedged()).toBe(0);
  });

  it('модель грузится — движение, а не тишина; сервер не отвечает — не обрыв (его поднимает присмотр)', async () => {
    const h = harness();
    const track = h.watch.track(1_000);
    h.setHealth('loading');
    for (let i = 0; i < 5; i += 1) {
      h.advance(9_000);
      await h.watch.tick();
    }
    expect(h.watch.snapshot().phase).toBe('loading');
    h.setHealth(undefined);
    h.advance(60_000);
    await h.watch.tick();
    expect(h.watch.snapshot().phase).toBe('starting');
    expect(track.signal.aborted).toBe(false);
  });

  it('слот занят чужим запросом, который движется, — наш ждёт в очереди и не рвётся', async () => {
    const h = harness();
    const track = h.watch.track(5_000);
    for (let decoded = 1; decoded < 20; decoded += 1) {
      h.setSlot({ processing: true, filled: 30_000 + decoded, decoded });
      h.advance(5_000);
      await h.watch.tick();
    }
    expect(track.signal.aborted).toBe(false);
  });

  it('декодирование зависло: /health отвечает, /slots — нет; тишина копится, обрыв и перезапуск (ревью M2)', async () => {
    const h = harness();
    const track = h.watch.track(60_000);
    h.setSlot({ processing: true, filled: 8_192, decoded: 0 });
    await h.watch.tick();
    h.failSlots(true);
    for (let waited = 0; waited < 9_000; waited += 3_000) {
      h.advance(3_000);
      await h.watch.tick();
    }
    expect(track.signal.aborted).toBe(false);
    expect(h.watch.snapshot()).toMatchObject({ phase: 'prompt', silentMs: 9_000 });
    h.advance(1_000);
    await h.watch.tick();
    expect(track.signal.aborted).toBe(true);
    expect((track.signal.reason as Error).message).toBe('stalled 10');
    expect(h.wedged()).toBe(1);
  });

  it('на процессоре /slots молчит весь пакет разбора — короче срока тишины это не обрыв (ревью M2)', async () => {
    const h = harness(600_000);
    const track = h.watch.track(30_000);
    h.setSlot({ processing: true, filled: 2_048, decoded: 0 });
    await h.watch.tick();
    for (let batch = 2; batch <= 6; batch += 1) {
      // Пакет в 2048 токенов у 27B на процессоре — полторы минуты без ответа на опрос.
      h.failSlots(true);
      for (let waited = 0; waited < 90_000; waited += 2_000) {
        h.advance(2_000);
        await h.watch.tick();
      }
      h.failSlots(false);
      h.setSlot({ processing: true, filled: 2_048 * batch, decoded: 0 });
      await h.watch.tick();
    }
    expect(track.signal.aborted).toBe(false);
    expect(h.wedged()).toBe(0);
    expect(h.watch.snapshot()).toMatchObject({ phase: 'prompt', filled: 12_288, silentMs: 0 });
  });

  it('отказ сервера виден чату до удачного ответа; 503 «Loading model» — загрузка, не отказ', () => {
    const h = harness();
    const first = h.watch.track(100);
    expect(h.watch.snapshot().lastRequestAt).toBe(1_000);
    first.failed(500, 'Error: Jinja Exception: System message must be at the beginning.');
    first.done();
    expect(h.watch.snapshot().lastError).toEqual({
      at: 1_000,
      status: 500,
      message: 'Error: Jinja Exception: System message must be at the beginning.',
    });
    const loading = h.watch.track(100);
    loading.failed(503, 'Loading model');
    loading.done();
    expect(h.watch.snapshot().lastError?.status).toBe(500);
    h.advance(5_000);
    const ok = h.watch.track(100);
    ok.succeeded();
    ok.done();
    expect(h.watch.snapshot().lastError).toBeUndefined();
    expect(h.watch.snapshot().lastRequestAt).toBe(6_000);
    const long = h.watch.track(100);
    long.failed(502, 'x'.repeat(1_000));
    expect(h.watch.snapshot().lastError?.message).toHaveLength(300);
    long.done();
  });
});
