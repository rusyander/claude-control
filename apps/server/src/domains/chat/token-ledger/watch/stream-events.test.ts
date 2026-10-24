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

  it('carries the error kind and head of a failed call (R24, R29, R30)', () => {
    expect(
      streamWatchEvents(
        {
          kind: 'toolResult',
          toolUseId: 'a',
          chars: 9,
          isError: true,
          errorKind: 'network',
          errorHead: 'fetch failed',
        },
        5,
      ),
    ).toEqual([
      {
        kind: 'toolResult',
        t: 5,
        id: 'a',
        chars: 9,
        isError: true,
        errorKind: 'network',
        errorHead: 'fetch failed',
      },
    ]);
  });

  it('a model retry is an outage, an exhausted limit is not (R30 vs R10)', () => {
    expect(
      streamWatchEvents({ kind: 'apiRetry', attempt: 1, status: 529, error: 'overloaded' }, 5),
    ).toEqual([{ kind: 'apiError', t: 5, head: 'overloaded HTTP 529' }]);
    expect(streamWatchEvents({ kind: 'apiRetry', status: 429, error: 'rate_limit' }, 5)).toEqual(
      [],
    );
    expect(streamWatchEvents({ kind: 'apiRetry', error: 'rate_limit' }, 5)).toEqual([]);
  });

  it('a failed run ends the turn; only a network-shaped failure is also an outage', () => {
    expect(streamWatchEvents({ kind: 'error', message: 'API Error: 500 server_error' }, 5)).toEqual(
      [
        { kind: 'apiError', t: 5, head: 'API Error: N server_error' },
        { kind: 'end', t: 5 },
      ],
    );
    expect(streamWatchEvents({ kind: 'error', message: 'API Error: 429 rate limit' }, 5)).toEqual([
      { kind: 'end', t: 5 },
    ]);
    expect(streamWatchEvents({ kind: 'error', message: 'Process exited with code 1' }, 5)).toEqual([
      { kind: 'end', t: 5 },
    ]);
  });

  it('F-104: a client-side API error or a stray 5xx number is not an outage; connection loss is', () => {
    const outage = (message: string) =>
      streamWatchEvents({ kind: 'error', message }, 5).some((e) => e.kind === 'apiError');
    expect(outage('API Error: 400 prompt is too long')).toBe(false);
    expect(outage('API Error: 401 authentication_error')).toBe(false);
    expect(outage('Error: file has 512 lines, limit exceeded')).toBe(false);
    expect(outage('API Error: 529 overloaded_error')).toBe(true);
    expect(outage('API Error: Connection error.')).toBe(true);
    expect(outage('HTTP 503 Service Unavailable')).toBe(true);
    expect(outage('fetch failed')).toBe(true);
  });

  it('streamed text keeps the session alive and feeds the turn tail (R27, R33)', () => {
    expect(streamWatchEvents({ kind: 'text', text: 'Which option?' }, 5)).toEqual([
      { kind: 'activity', t: 5 },
      { kind: 'say', t: 5, text: 'Which option?' },
    ]);
  });
});
