import { describe, expect, it } from 'vitest';
import { CLAUDE_OUTCOME } from '../claude/outcome.ts';
import { QWEN_OUTCOME } from '../qwen/outcome.ts';
import { clipBytes, ERROR_TEXT_MAX_BYTES, readToolOutcome } from './outcome.ts';

/** Ключ формы GitHub — детектор `@agentdeck/dlp` узнаёт его по виду. */
const SECRET = `ghp_${'A1b2C3d4E5'.repeat(3)}abcdef`;

describe('tool outcome from a tool_result block (stage 8, F18)', () => {
  it('errorText is masked by the dlp secret detector before it leaves the adapter', () => {
    const out = readToolOutcome(
      { type: 'tool_result', is_error: true, content: `Exit code 1\ntoken ${SECRET} rejected` },
      CLAUDE_OUTCOME,
    );
    expect(out.errorText).not.toContain(SECRET);
    expect(out.errorText).toMatch(/^Exit code 1\ntoken \S+ rejected$/);
    expect(out.exitCode).toBeNull();
  });

  it('errorText is clipped to 2 KB of UTF-8 without splitting a character', () => {
    const out = readToolOutcome(
      { type: 'tool_result', is_error: true, content: 'ж'.repeat(5000) },
      CLAUDE_OUTCOME,
    );
    expect(Buffer.byteLength(out.errorText!, 'utf8')).toBeLessThanOrEqual(ERROR_TEXT_MAX_BYTES);
    expect(Buffer.byteLength(out.errorText!, 'utf8')).toBeGreaterThan(ERROR_TEXT_MAX_BYTES - 2);
    expect(out.errorText).not.toContain('�');
    expect(clipBytes('abc', 2)).toBe('ab');
  });

  it('CRLF and LF error texts are the same errorText (one digest on Windows and Linux)', () => {
    const crlf = readToolOutcome(
      { type: 'tool_result', is_error: true, content: 'Exit code 3\r\nboom\r\n' },
      CLAUDE_OUTCOME,
    );
    const lf = readToolOutcome(
      { type: 'tool_result', is_error: true, content: 'Exit code 3\nboom\n' },
      CLAUDE_OUTCOME,
    );
    expect(crlf.errorText).toBe(lf.errorText);
  });

  it('qwen: two runs of the same failure differ only by the PGID line → identical errorText', () => {
    const frame = (pgid: number) =>
      `Command: npm test\nDirectory: (root)\nOutput: 1 failed\nError: (none)\nExit Code: 1\nSignal: (none)\nProcess Group PGID: ${pgid}`;
    const a = readToolOutcome(
      { type: 'tool_result', is_error: true, content: frame(57656) },
      QWEN_OUTCOME,
    );
    const b = readToolOutcome(
      { type: 'tool_result', is_error: true, content: frame(1203) },
      QWEN_OUTCOME,
    );
    expect(a.errorText).toBe(b.errorText);
    expect(a.errorText).toContain('Exit Code: 1');
    expect(a.bytes).toBeNull();
  });

  it('claude: bytes = UTF-8 bytes of the content the model got; array content counts its text parts; success has no errorText', () => {
    const out = readToolOutcome(
      {
        type: 'tool_result',
        content: [
          { type: 'text', text: 'привет' },
          { type: 'image', source: {} },
        ],
      },
      CLAUDE_OUTCOME,
    );
    expect(out).toEqual({ exitCode: null, errorText: null, bytes: Buffer.byteLength('привет') });
  });
});
