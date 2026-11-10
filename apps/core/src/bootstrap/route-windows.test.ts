import type { Fact } from '@agentdeck/contracts/core/facts';
import { describe, expect, it } from 'vitest';
import { createRouteWindows, WINDOW_RETRY_MS } from './route-windows.ts';

/**
 * Книга окон маршрутов (этап 8): один источник окна для роста контекста наблюдателя и правила
 * 60 % продолжения. Подделан только маршрут — граница чтения факта `route.read.context`.
 */

function routeBook(answer: (model: string) => Fact<number> | 'throw' | 'throw-sync') {
  const reads: string[] = [];
  const route = {
    read: {
      context: (model: string): Promise<Fact<number>> => {
        reads.push(model);
        const got = answer(model);
        if (got === 'throw-sync') throw new Error('context read blew up');
        if (got === 'throw') return Promise.reject(new Error('context read failed'));
        return Promise.resolve(got);
      },
    },
  } as never;
  return { reads, routeOf: (id: string) => (id === 'r1' ? route : undefined) };
}

describe('route windows: one window source per core', () => {
  it('first ask starts the read and answers null; once read, the value per route × model; one read per pair', async () => {
    const book = routeBook((m) => ({ value: m === 'big' ? 1_000_000 : 200_000 }));
    let now = 0;
    const w = createRouteWindows({ routeOf: book.routeOf, now: () => now });
    expect(w.windowOf('r1', 'small')).toBeNull();
    expect(w.windowOf('r1', 'small')).toBeNull();
    await w.settled();
    expect(w.windowOf('r1', 'small')).toBe(200_000);
    expect(w.windowOf('r1', 'big')).toBeNull();
    await w.settled();
    expect(w.windowOf('r1', 'big')).toBe(1_000_000);
    now += WINDOW_RETRY_MS * 10;
    expect(w.windowOf('r1', 'small')).toBe(200_000);
    expect(book.reads).toEqual(['small', 'big']);
  });

  it('near-miss: no model, an unknown route, an unknown/absent fact or a non-window value judge nothing (null)', async () => {
    const notes: string[] = [];
    const book = routeBook((m) =>
      m === 'cli'
        ? { unknown: 'cli login: window not known' }
        : m === 'gone'
          ? { absent: true }
          : { value: 0 },
    );
    const w = createRouteWindows({
      routeOf: book.routeOf,
      now: () => 0,
      note: (e, d) => notes.push(`${e}:${String(d.reason)}`),
    });
    expect(w.windowOf('r1', null)).toBeNull();
    expect(w.windowOf('nope', 'm')).toBeNull();
    for (const m of ['cli', 'gone', 'zero']) w.windowOf('r1', m);
    await w.settled();
    for (const m of ['cli', 'gone', 'zero']) expect(w.windowOf('r1', m), m).toBeNull();
    expect(notes).toEqual([
      'route.window.unknown:cli login: window not known',
      'route.window.unknown:absent',
      'route.window.unknown:not a window',
    ]);
    expect(book.reads).toEqual(['cli', 'gone', 'zero']);
  });

  it('a missing window is re-read only after the retry interval — the route may come up', async () => {
    let up = false;
    const book = routeBook(() => (up ? { value: 128_000 } : { unknown: 'route down' }));
    let now = 0;
    const w = createRouteWindows({ routeOf: book.routeOf, now: () => now, retryMs: 1_000 });
    w.windowOf('r1', 'm');
    await w.settled();
    up = true;
    now = 999;
    expect(w.windowOf('r1', 'm')).toBeNull();
    expect(book.reads).toHaveLength(1);
    now = 1_000;
    expect(w.windowOf('r1', 'm')).toBeNull();
    await w.settled();
    expect(w.windowOf('r1', 'm')).toBe(128_000);
    expect(book.reads).toHaveLength(2);
  });

  it('a failing read (rejected or thrown synchronously) becomes a missing fact that is retried, never a stuck "reading" slot', async () => {
    for (const how of ['throw', 'throw-sync'] as const) {
      let fail = true;
      const book = routeBook(() => (fail ? how : { value: 64_000 }));
      let now = 0;
      const w = createRouteWindows({ routeOf: book.routeOf, now: () => now, retryMs: 10 });
      expect(w.windowOf('r1', 'm'), how).toBeNull();
      await w.settled();
      fail = false;
      now = 10;
      w.windowOf('r1', 'm');
      await w.settled();
      expect(w.windowOf('r1', 'm'), how).toBe(64_000);
    }
  });
});

describe('route windows: the model list of a route for the tier offers', () => {
  function modelsBook(answer: () => Fact<{ id: string }[]>) {
    let reads = 0;
    const route = {
      read: {
        models: (): Promise<Fact<{ id: string }[]>> => {
          reads += 1;
          return Promise.resolve(answer());
        },
      },
    } as never;
    return { reads: () => reads, routeOf: (id: string) => (id === 'r1' ? route : undefined) };
  }

  it('first ask starts the read and answers null; once read, the served ids; one read per route', async () => {
    const book = modelsBook(() => ({ value: [{ id: 'stub-model' }, { id: 'stub-alt' }] }));
    const w = createRouteWindows({ routeOf: book.routeOf, now: () => 0 });
    expect(w.modelsOf('r1')).toBeNull();
    await w.settled();
    expect(w.modelsOf('r1')).toEqual(['stub-model', 'stub-alt']);
    expect(w.modelsOf('r1')).toEqual(['stub-model', 'stub-alt']);
    expect(book.reads()).toBe(1);
  });

  it('an unknown route or an absent/unknown list judges nothing (null) and is noted', async () => {
    const notes: string[] = [];
    let answer: Fact<{ id: string }[]> = { unknown: 'listing failed' };
    const book = modelsBook(() => answer);
    let now = 0;
    const w = createRouteWindows({
      routeOf: book.routeOf,
      now: () => now,
      retryMs: 1_000,
      note: (e, d) => notes.push(`${e}:${String(d.reason)}`),
    });
    expect(w.modelsOf('nope')).toBeNull();
    expect(w.modelsOf('r1')).toBeNull();
    await w.settled();
    expect(w.modelsOf('r1')).toBeNull();
    answer = { absent: true };
    now += 1_000;
    expect(w.modelsOf('r1')).toBeNull();
    await w.settled();
    expect(w.modelsOf('r1')).toBeNull();
    expect(notes).toEqual(['route.models.unknown:listing failed', 'route.models.unknown:absent']);
  });
});
