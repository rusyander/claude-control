import { describe, expect, it } from 'vitest';
import { NO_REFUSALS, refusalText } from './refusal';

const t = (key: string, options?: Record<string, unknown>): string =>
  `${key}${options ? JSON.stringify(options) : ''}`;
const size = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const limits = { maxBytes: 20 * 1024 * 1024, maxCount: 8 };

describe('refusalText', () => {
  it('нечего сказать — пусто', () => {
    expect(refusalText(NO_REFUSALS, t, size, limits)).toBeUndefined();
  });

  it('размер назван рядом с пределом; каждая причина — своим предложением', () => {
    const text = refusalText(
      {
        ...NO_REFUSALS,
        notImage: ['notes.txt'],
        tooLarge: [{ name: 'raw.png', size: 25 * 1024 * 1024 }],
        tooMany: ['nine.png'],
        failed: [{ name: 'broken.png', reason: 'unreadable' }],
      },
      t,
      size,
      limits,
    );
    expect(text).toContain('attach.notImage{"names":"notes.txt"}');
    expect(text).toContain('attach.tooLarge{"names":"raw.png — 25.0 MB","limit":"20.0 MB"}');
    expect(text).toContain('attach.tooMany{"names":"nine.png","limit":8}');
    expect(text).toContain('attach.unreadable{"names":"broken.png"}');
  });
});
