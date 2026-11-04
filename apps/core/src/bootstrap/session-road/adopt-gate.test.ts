import { describe, expect, it } from 'vitest';
import type { CliAdapter } from '../../adapters/adapter.types.ts';
import { adoptRefusal } from './adopt-gate.ts';
import type { RoadStart } from './road.types.ts';

/**
 * Суд просьбы продолжить разговор, начатый не ядром: решает переходник CLI сессии, а не id панели.
 * Переходник без `ownsTranscript` (формат хранилища не доказан) — отказ `resume_unproven`, даже
 * если транскрипт где-то есть; не прочитал — `resume_unreadable`; просьба без `adopt` — не суд.
 */

const start = (adopt: string | null, conversationId = 'c-1'): RoadStart =>
  ({
    adapterId: 'claude',
    cwd: 'C:/w/app',
    pin: { HOME: 'C:/h' },
    ...(adopt === null
      ? { resume: { conversationId, of: 's-prev' } }
      : { resume: { conversationId, adopt: { adapter: adopt } } }),
  }) as unknown as RoadStart;

const adapter = (owns?: CliAdapter['ownsTranscript']): CliAdapter =>
  ({ id: 'claude', ...(owns ? { ownsTranscript: owns } : {}) }) as unknown as CliAdapter;

describe('adopt gate: an outside conversation continues only on the adapter’s own proof', () => {
  it('the adapter is asked with the pin, the session root and the id; true lets it through', () => {
    const calls: unknown[][] = [];
    const got = adoptRefusal(
      start('claude'),
      adapter((...args) => {
        calls.push(args);
        return true;
      }),
    );
    expect(got).toBeNull();
    expect(calls).toEqual([[{ HOME: 'C:/h' }, 'C:/w/app', 'c-1']]);
  });

  it('no ownsTranscript is resume_unproven; false is resume_not_owned; undefined is resume_unreadable', () => {
    expect(adoptRefusal(start('claude'), adapter())).toBe('resume_unproven');
    expect(
      adoptRefusal(
        start('claude'),
        adapter(() => false),
      ),
    ).toBe('resume_not_owned');
    expect(
      adoptRefusal(
        start('claude'),
        adapter(() => undefined),
      ),
    ).toBe('resume_unreadable');
  });

  it('another CLI’s conversation is refused before the adapter is asked', () => {
    let asked = false;
    const got = adoptRefusal(
      start('qwen'),
      adapter(() => {
        asked = true;
        return true;
      }),
    );
    expect(got).toBe('resume_other_cli');
    expect(asked).toBe(false);
  });

  it('the core’s own continuation (no adopt) and no resume at all are not judged here', () => {
    expect(adoptRefusal(start(null), adapter())).toBeNull();
    expect(adoptRefusal({ adapterId: 'claude' } as RoadStart, adapter())).toBeNull();
  });
});
