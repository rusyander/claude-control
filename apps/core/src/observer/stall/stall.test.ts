import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import { OBSERVER_PREDICATES } from '../registry.ts';
import { signalDef } from '../catalog.ts';
import type { SignalVerdict } from '../observer.types.ts';
import {
  formatQuiet,
  MODEL_CLASS,
  PREDICATES,
  sessionStallThreshold,
  stallPredicate,
  stallThreshold,
  STALL_DEFAULT_MS,
  STALL_FLOOR_MS,
} from './index.ts';

/**
 * Порог и предикат тишины (06:138-139, F9 этапа 8) — чистые функции: порог по классу ожидаемого
 * инструмента (p95 × 3, пол 2 мин, иначе 10 мин), предикат называет строку `session.probe` и
 * ничего не решает сам (серьёзность и действие — каталог: warn → show).
 */

const SID = '01920000-0000-7000-8000-0000000c0001';
const STEP = '01920000-0000-7000-8000-0000000c0002';

function probeLine(
  seq: number,
  data: Partial<JournalLine<'session.probe'>['data']>,
): JournalLine<'session.probe'> {
  return {
    v: 1,
    seq,
    at: 0,
    mono: 0,
    bootId: 'b',
    kind: 'session.probe',
    actor: 'core',
    sessionId: SID,
    stepId: STEP,
    data: {
      sessionId: SID,
      verdict: 'alive',
      cpuDeltaMs: 0,
      quietMs: 725_000,
      thresholdMs: 600_000,
      toolClass: MODEL_CLASS,
      reason: 'host pid 1; threshold: no learned p95',
      ...data,
    },
  } as unknown as JournalLine<'session.probe'>;
}

const CTX = { windowOf: () => null, now: () => 0 };

const detailOf = (v: SignalVerdict | undefined): string | undefined =>
  v?.fired ? v.detail : undefined;

describe('stage 8 stall threshold per tool class (F9)', () => {
  it('stage 8 stall threshold: learned p95 x3 floored at 2 min; unlearned class takes the spec default 10 min; a test default replaces only the unlearned value', () => {
    expect(stallThreshold('exec', { exec: 100_000 })).toEqual({
      ms: 300_000,
      toolClass: 'exec',
      basis: 'learned',
    });
    // Короткий вызов: 3 × 5 с = 15 с меньше пола — проба не приходит на каждой паузе модели.
    expect(stallThreshold('read', { read: 5_000 }).ms).toBe(STALL_FLOOR_MS);
    expect(stallThreshold('wait', { exec: 100_000 })).toEqual({
      ms: STALL_DEFAULT_MS,
      toolClass: 'wait',
      basis: 'default',
    });
    expect(stallThreshold('exec', null, 30_000)).toMatchObject({ ms: 30_000, basis: 'default' });
    expect(stallThreshold('exec', { exec: 100_000 }, 30_000).ms).toBe(300_000);
    // Мусор в выученном не даёт порога 0 или NaN.
    expect(stallThreshold('exec', { exec: Number.NaN }).basis).toBe('default');
    expect(stallThreshold('exec', { exec: -1 }).basis).toBe('default');
  });

  it('stage 8 stall threshold of a session: nothing pending is the model class; parallel pending calls take the longest class', () => {
    expect(sessionStallThreshold([], { model: 50_000 })).toMatchObject({
      toolClass: MODEL_CLASS,
      ms: 150_000,
    });
    expect(sessionStallThreshold(['read', 'exec'], { read: 1_000, exec: 200_000 })).toMatchObject({
      toolClass: 'exec',
      ms: 600_000,
    });
    // Невыученный класс среди ожидаемых — его 10 мин длиннее выученного.
    expect(sessionStallThreshold(['read', 'mcp'], { read: 1_000 })).toMatchObject({
      toolClass: 'mcp',
      ms: STALL_DEFAULT_MS,
    });
  });
});

describe('stage 8 stall predicate over session.probe (F9, P18)', () => {
  it('stage 8 stall predicate: an alive quiet session is shown with its quiet time, threshold, class and CPU; key per session and probe line', () => {
    const { verdicts } = stallPredicate.step(null, probeLine(41, { cpuDeltaMs: 0 }), CTX);
    expect(verdicts).toEqual([
      expect.objectContaining({
        fired: true,
        signal: 'stall',
        subject: SID,
        key: `stall:${SID}:41`,
        sessionId: SID,
        stepId: STEP,
        inputs: [41],
      }),
    ]);
    expect(detailOf(verdicts[0])).toBe(
      'quiet 12m 05s, threshold 10m 00s (model); host alive, CPU flat; shown, not stopped',
    );
    const moving = stallPredicate.step(null, probeLine(42, { cpuDeltaMs: 1_500 }), CTX);
    expect(detailOf(moving.verdicts[0])).toContain('CPU moving (+1500 ms)');
    const unread = stallPredicate.step(null, probeLine(43, { cpuDeltaMs: null }), CTX);
    expect(detailOf(unread.verdicts[0])).toContain('CPU unread');
  });

  it('stage 8 stall predicate: dead host names session lost; unknown liveness names the reason and stops nothing', () => {
    const dead = stallPredicate.step(
      null,
      probeLine(7, { verdict: 'dead', cpuDeltaMs: null }),
      CTX,
    );
    expect(detailOf(dead.verdicts[0])).toContain('host dead: session lost');
    const unknown = stallPredicate.step(
      null,
      probeLine(8, { verdict: 'unknown', cpuDeltaMs: null, reason: 'ps failed' }),
      CTX,
    );
    expect(detailOf(unknown.verdicts[0])).toBe(
      'quiet 12m 05s, threshold 10m 00s (model); liveness unread (ps failed); nothing stopped',
    );
  });

  it('stage 8 stall near-miss: lines other than session.probe never fire, the registry carries the predicate, the catalog shows it without stopping', () => {
    const other = { ...probeLine(1, {}), kind: 'session.transition' } as unknown as JournalLine;
    expect(stallPredicate.step(null, other, CTX).verdicts).toEqual([]);
    expect(PREDICATES).toContain(stallPredicate);
    expect(OBSERVER_PREDICATES).toContain(stallPredicate);
    expect(signalDef('stall')).toMatchObject({ severity: 'warn', action: 'show' });
    expect(formatQuiet(3_725_000)).toBe('1h 02m');
    expect(formatQuiet(40_400)).toBe('40s');
  });
});
