import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptTail } from './tail.ts';
import { createTranscriptReader } from './transcript-events.ts';

const dirs: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-tail-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const line = (row: unknown): string => `${JSON.stringify(row)}\n`;

describe('transcript tail', () => {
  it('reads only new complete lines, skips what was there at prime time', () => {
    const dir = temp();
    const file = join(dir, 'agent-1.jsonl');
    writeFileSync(file, line({ n: 1 }));
    const tail = new TranscriptTail();
    tail.prime(dir, 0);
    appendFileSync(file, line({ n: 2 }) + '{"n":3');
    expect(tail.read(dir, 60_000).map((entry) => entry.row)).toEqual([{ n: 2 }]);
    appendFileSync(file, '}\n');
    expect(tail.read(dir, 120_000).map((entry) => entry.row)).toEqual([{ n: 3 }]);
  });

  it('reads a file born after prime from the start and respects the interval', () => {
    const dir = temp();
    const tail = new TranscriptTail();
    tail.prime(dir, 0);
    const file = join(dir, 'agent-2.jsonl');
    writeFileSync(file, line({ a: 1 }) + 'not json\n' + line({ a: 2 }));
    expect(tail.read(dir, 1_000).map((entry) => entry.row)).toEqual([{ a: 1 }, { a: 2 }]);
    appendFileSync(file, line({ a: 3 }));
    expect(tail.read(dir, 2_000)).toEqual([]);
    expect(tail.read(dir, 40_000).map((entry) => entry.row)).toEqual([{ a: 3 }]);
  });

  it('rereads a rewritten (shorter) file from zero', () => {
    const dir = temp();
    const file = join(dir, 'agent-3.jsonl');
    const tail = new TranscriptTail();
    writeFileSync(file, line({ long: 'x'.repeat(100) }));
    tail.read(dir, 0, 0);
    writeFileSync(file, line({ b: 1 }));
    expect(tail.read(dir, 1, 0).map((entry) => entry.row)).toEqual([{ b: 1 }]);
  });

  it('turns subagent transcript rows into sidechain calls, one per message id', () => {
    const read = createTranscriptReader({ sidechain: true });
    const assistant = (text: string) => ({
      type: 'assistant',
      timestamp: '2026-10-20T10:00:00Z',
      message: {
        id: 'msg_1',
        model: 'claude-sonnet-4',
        usage: {
          input_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 10,
          output_tokens: 7,
        },
        content: [{ type: 'text', text }],
      },
    });
    const first = read(assistant('a'));
    expect(first).toEqual([
      expect.objectContaining({
        kind: 'call',
        model: 'claude-sonnet-4',
        cacheRead: 100,
        sidechain: true,
      }),
    ]);
    expect(read(assistant('b'))).toEqual([]);
    expect(
      read({ type: 'user', timestamp: '2026-10-20T10:00:01Z', message: { content: 'go on' } }),
    ).toEqual([]);
  });

  it('main transcript: human line starts a turn, compact boundary is a compaction', () => {
    const read = createTranscriptReader();
    expect(
      read({ type: 'user', timestamp: '2026-10-20T10:00:00Z', message: { content: 'go on' } }),
    ).toEqual([{ kind: 'start', t: Date.parse('2026-10-20T10:00:00Z') }]);
    expect(
      read({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-20T10:00:00Z' }),
    ).toEqual([{ kind: 'compact', t: Date.parse('2026-10-20T10:00:00Z') }]);
    // `/compact` по просьбе помечен: R3 его не считает.
    expect(
      read({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-10-20T10:00:00Z',
        compactMetadata: { trigger: 'manual' },
      }),
    ).toEqual([{ kind: 'compact', t: Date.parse('2026-10-20T10:00:00Z'), manual: true }]);
    expect(
      read({
        type: 'user',
        timestamp: '2026-10-20T10:00:02Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'abcd' }] },
      }),
    ).toEqual([{ kind: 'toolResult', t: Date.parse('2026-10-20T10:00:02Z'), id: 't1', chars: 4 }]);
  });
});
