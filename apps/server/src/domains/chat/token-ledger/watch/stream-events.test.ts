import { describe, expect, it } from 'vitest';
import { streamWatchEvents } from './stream-events.ts';

describe('streamWatchEvents', () => {
  it('marks a compaction the human asked for, leaves an automatic one unmarked', () => {
    expect(streamWatchEvents({ kind: 'compact', trigger: 'manual' }, 5)).toEqual([
      { kind: 'compact', t: 5, manual: true },
    ]);
    expect(streamWatchEvents({ kind: 'compact', trigger: 'auto' }, 5)).toEqual([
      { kind: 'compact', t: 5 },
    ]);
  });
});
