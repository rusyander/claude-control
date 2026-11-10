import { describe, expect, it } from 'vitest';
import { fromAdf, toAdf } from './adf.ts';

/** ADF облака: туда — абзацы, обратно — читаемый текст со ссылками-карточками и переносами. */
describe('trackers/adf', () => {
  it('текст ↔ документ: пустые строки — пустые абзацы, корень несёт version 1', () => {
    const doc = toAdf('first\n\nthird');
    expect(doc).toMatchObject({ type: 'doc', version: 1 });
    expect(doc.content).toHaveLength(3);
    expect(fromAdf(doc)).toBe('first\n\nthird');
    expect(fromAdf(null)).toBeUndefined();
    expect(fromAdf('plain')).toBe('plain');
    expect(fromAdf(7)).toBe('7');
    expect(fromAdf({ type: 'text', text: 'root' })).toBe('root');
  });

  it('карточка ссылки — её адрес; блочная с новой строки; hardBreak — перенос', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'MR: ' },
            { type: 'inlineCard', attrs: { url: 'https://forge.example.com/mr/1' } },
            { type: 'hardBreak' },
            { type: 'text', text: 'next' },
          ],
        },
        { type: 'blockCard', attrs: { url: 'https://tracker.example.com/browse/PROJ-1' } },
        { type: 'inlineCard', attrs: { url: 42 } },
      ],
    };
    expect(fromAdf(doc)).toBe(
      'MR: https://forge.example.com/mr/1\nnext\nhttps://tracker.example.com/browse/PROJ-1',
    );
    expect(fromAdf({ type: 'inlineCard', attrs: { url: 'https://x.example.com' } })).toBe(
      'https://x.example.com',
    );
  });
});
