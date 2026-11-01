import { describe, expect, it } from 'vitest';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { baseContext, driftOf, forgetBase, measureBase, setHash } from './base.ts';
import type { BaseCacheFile, BaseKey } from './base.types.ts';

/** База сеанса (G9): тело первого хода минус бриф, кэш по ключу, дрейф > 20 % — перемер. */

const key: BaseKey = {
  adapter: 'cli-a',
  cliVersion: '1.0.0',
  stepKind: 'work',
  layerHash: setHash({ hooks: 'off' }),
  mcpHash: setHash({ servers: ['agentdeck'] }),
};

function store(initial: Fact<BaseCacheFile> = { absent: true }) {
  let file = initial;
  const writes: BaseCacheFile[] = [];
  return {
    writes,
    read: async () => file,
    write: async (next: BaseCacheFile) => {
      writes.push(next);
      file = { value: structuredClone(next) };
    },
  };
}

describe('measureBase', () => {
  it('base = the body that carries the brief minus the brief as it sits in the JSON body', () => {
    const brief = 'line "one"\nline two';
    const body = JSON.stringify({ system: 'S'.repeat(100), messages: [{ content: brief }] });
    const other = JSON.stringify({ title: 'side request' });
    const got = measureBase({ bodies: [other, body], brief })!;
    expect(got.bytes).toBe(Buffer.byteLength(body) - Buffer.byteLength(JSON.stringify(brief)) + 2);
    expect(got.tokens).toBe(Math.ceil(got.bytes / 4));
  });

  it('no body carries the brief: no measure (never the whole body as base)', () => {
    expect(measureBase({ bodies: ['{"a":1}'], brief: 'missing' })).toBeNull();
  });
});

describe('baseContext', () => {
  it('first call probes and caches; the second with the same key reads the cache, no probe', async () => {
    const s = store();
    let probes = 0;
    const probe = async () => {
      probes += 1;
      return { bodies: [JSON.stringify({ s: 'x'.repeat(40), m: 'BRIEF' })], brief: 'BRIEF' };
    };
    const first = await baseContext(key, { ...s, probe, now: () => 1 });
    expect(first).toMatchObject({ ok: true, measured: true, base: { ...key } });
    const second = await baseContext(key, { ...s, probe });
    expect(second).toMatchObject({ ok: true, measured: false });
    expect(probes).toBe(1);
    // Другой вид шага — другой ключ: свой замер.
    await baseContext({ ...key, stepKind: 'review' }, { ...s, probe });
    expect(probes).toBe(2);
  });

  it('an unreadable cache refuses, it does not probe over it', async () => {
    const s = store({ unknown: 'EPERM' });
    const got = await baseContext(key, {
      ...s,
      probe: async () => {
        throw new Error('must not probe');
      },
    });
    expect(got).toEqual({ ok: false, reason: 'base cache unreadable: EPERM' });
  });

  it('forgetBase drops the key so the next start measures again', async () => {
    const s = store();
    const probe = async () => ({ bodies: ['{"m":"B"}'], brief: 'B' });
    await baseContext(key, { ...s, probe });
    expect(await forgetBase(key, s)).toBe(true);
    expect(await baseContext(key, { ...s, probe })).toMatchObject({ measured: true });
  });
});

describe('driftOf', () => {
  it('within 20 % holds; beyond it in either direction is drift', () => {
    expect(driftOf({ tokens: 1000 }, 400, 1100).over).toBe(false);
    expect(driftOf({ tokens: 1000 }, 400, 1321).over).toBe(true);
    expect(driftOf({ tokens: 1000 }, 400, 879).over).toBe(true);
  });
});
